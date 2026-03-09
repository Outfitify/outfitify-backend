require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── CORS: allow your Netlify domains ──
app.use(cors({
  origin: [
    'https://outfitify.co.uk',
    'https://quiz.outfitify.co.uk',
    'https://unlock.outfitify.co.uk',
    'https://success.outfitify.co.uk',
    'https://chipper-fairy-2f755d.netlify.app',
    /\.netlify\.app$/,
    'http://localhost:3000'
  ]
}));

// Raw body needed for Stripe webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── IN-MEMORY SESSION STORE ──
// Stores quiz answers keyed by a session ID until payment completes
const sessions = new Map();
// Stores generated PDF download tokens after payment
const downloads = new Map();

// ════════════════════════════════════════
// STEP 1 — Save quiz answers before payment
// Called by unlock page before redirecting to Stripe
// ════════════════════════════════════════
app.post('/api/save-session', (req, res) => {
  const { style, budget, colours, struggles, brands, openToBrands, email } = req.body;

  if (!style || !budget || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sessionId = crypto.randomBytes(16).toString('hex');
  sessions.set(sessionId, {
    style, budget, colours, struggles, brands, openToBrands, email,
    createdAt: Date.now()
  });

  // Clean up sessions older than 2 hours
  for (const [id, data] of sessions.entries()) {
    if (Date.now() - data.createdAt > 7200000) sessions.delete(id);
  }

  res.json({ sessionId });
});

// ════════════════════════════════════════
// STEP 2 — Create Stripe Checkout Session
// ════════════════════════════════════════
app.post('/api/create-checkout', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessions.has(sessionId)) {
    return res.status(400).json({ error: 'Session not found or expired' });
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: 'Outfitify Personalised Style Report',
            description: '5 complete outfits built around your style, budget & preferences — with product images and links',
            images: ['https://outfitify.co.uk/assets/images/image04.png'],
          },
          unit_amount: 999, // £9.99 in pence
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.BASE_URL}/success?token={CHECKOUT_SESSION_ID}&sid=${sessionId}`,
      cancel_url: `${process.env.UNLOCK_PAGE_URL}?sid=${sessionId}&cancelled=true`,
      customer_email: sessions.get(sessionId).email,
      metadata: { sessionId },
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
});

// ════════════════════════════════════════
// STEP 3 — Stripe Webhook (payment confirmed)
// Triggers PDF generation
// ════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const sessionId = session.metadata.sessionId;
    const userEmail = session.customer_email;

    if (sessions.has(sessionId)) {
      const quizData = sessions.get(sessionId);
      // Fire and forget — generate PDF in background
      generateAndStoreReport(sessionId, quizData, userEmail).catch(console.error);
    }
  }

  res.json({ received: true });
});

// ════════════════════════════════════════
// STEP 4 — Poll for PDF readiness
// Success page polls this until PDF is ready
// ════════════════════════════════════════
app.get('/api/report-status/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  if (downloads.has(sessionId)) {
    res.json({ ready: true, downloadToken: downloads.get(sessionId).token });
  } else {
    res.json({ ready: false });
  }
});

// ════════════════════════════════════════
// STEP 5 — Serve the PDF download
// ════════════════════════════════════════
app.get('/api/download/:token', (req, res) => {
  const { token } = req.params;

  // Find download by token
  for (const [sessionId, data] of downloads.entries()) {
    if (data.token === token) {
      if (!fs.existsSync(data.pdfPath)) {
        return res.status(404).json({ error: 'File not found' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Outfitify-Style-Report.pdf"`);
      return fs.createReadStream(data.pdfPath).pipe(res);
    }
  }

  res.status(404).json({ error: 'Download link not found or expired' });
});

// ════════════════════════════════════════
// CORE: Generate personalised PDF report
// ════════════════════════════════════════
async function generateAndStoreReport(sessionId, quizData, userEmail) {
  console.log(`Generating report for session ${sessionId}...`);

  try {
    // 1. Fetch products from Google Sheet
    const products = await fetchProducts(quizData.style, quizData.budget, quizData.colours);

    // 2. Generate personalised content via Claude
    const reportContent = await generateReportContent(quizData, products);

    // 3. Build PDF
    const pdfPath = await buildPDF(reportContent, quizData, products);

    // 4. Store download token
    const token = crypto.randomBytes(32).toString('hex');
    downloads.set(sessionId, { token, pdfPath, email: userEmail, createdAt: Date.now() });

    // 5. Send backup email via ZeptoMail
    const downloadUrl = `${process.env.BASE_URL}/api/download/${token}`;
    await sendBackupEmail(userEmail, downloadUrl, quizData.style);

    console.log(`Report ready for session ${sessionId}`);

  } catch (err) {
    console.error(`Report generation failed for ${sessionId}:`, err);
  }
}

// ════════════════════════════════════════
// Fetch & filter products from Google Sheet
// ════════════════════════════════════════
async function fetchProducts(style, budget, colours) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:M',
  });

  const rows = response.data.values;
  const headers = rows[0];
  const products = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i] || '');
    return obj;
  });

  // Parse budget to max price
  const budgetMap = {
    'Under £50': 50,
    '£51-100': 100,
    '£101-150': 150,
    '£151-200': 200,
    '£200+': 9999
  };
  const maxPrice = budgetMap[budget] || 100;

  // Map style to sheet style values
  const styleMap = {
    'Everyday fits': 'Everyday Fits',
    'Streetwear': 'Streetwear',
    'Smart casual / Workwear': 'Smart Casual',
    'Date night / Going out': 'Date Night',
    'Active/Gym Wear': 'Active/Gym Wear'
  };
  const sheetStyle = styleMap[style] || style;

  // Filter by style and budget
  const filtered = products.filter(p => {
    const price = parseFloat(p['Price']) || 0;
    const matchesStyle = p['Style'] === sheetStyle || p['Style'] === 'Everyday Fits'; // fallback
    const matchesBudget = price <= maxPrice;
    return matchesStyle && matchesBudget && p['Item Name'] && p['Image URL'];
  });

  // Group by category
  const byCategory = {};
  filtered.forEach(p => {
    const cat = p['Category'] || 'Other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  });

  // Select products for 3 outfits (top, bottoms, shoes, optional layer per outfit)
  const categories = ['Top', 'Bottoms', 'Shoes', 'Hoodie/Jacket'];
  const selected = {};
  categories.forEach(cat => {
    const items = byCategory[cat] || [];
    // Sort by placement weight (higher = priority partners first)
    items.sort((a, b) => (parseFloat(b['Placement Weight']) || 0) - (parseFloat(a['Placement Weight']) || 0));
    selected[cat] = items.slice(0, 6); // take top 6 per category
  });

  return selected;
}

// ════════════════════════════════════════
// Generate personalised content via Claude
// ════════════════════════════════════════
async function generateReportContent(quizData, products) {
  // Build a concise product list to send to Claude
  const productSummary = {};
  for (const [cat, items] of Object.entries(products)) {
    productSummary[cat] = items.slice(0, 4).map(p => ({
      name: p['Item Name'],
      brand: p['Brand'],
      price: `£${p['Price']}`,
      url: p['Product URL']
    }));
  }

  const prompt = `You are Outfitify's AI stylist. Create a personalised menswear style report for a customer.

CUSTOMER PROFILE:
- Style preference: ${quizData.style}
- Budget per item: ${quizData.budget}
- Colour preference: ${quizData.colours || 'No preference'}
- Biggest style struggle: ${quizData.struggles || 'Not specified'}
- Favourite brands: ${quizData.brands || 'Open to suggestions'}
- Open to new brands: ${quizData.openToBrands || 'Yes'}

AVAILABLE PRODUCTS (select from these only — use exact names):
${JSON.stringify(productSummary, null, 2)}

Generate a style report with exactly this JSON structure (respond with JSON only, no other text):
{
  "styleType": "short style type name (e.g. Clean Streetwear)",
  "styleTagline": "one punchy sentence describing their style",
  "intro": "2-3 sentences personalised to their profile and struggles",
  "colourPalette": {
    "description": "1-2 sentences about their ideal colours based on preference",
    "colours": ["#hex1", "#hex2", "#hex3", "#hex4", "#hex5"],
    "labels": ["name1", "name2", "name3", "name4", "name5"]
  },
  "outfits": [
    {
      "name": "Outfit name",
      "vibe": "Short vibe description",
      "occasion": "When to wear this",
      "season": "Best season(s) e.g. Autumn/Winter or All Year",
      "items": [
        {
          "category": "Top/Bottoms/Shoes/Layer",
          "name": "exact product name from the list above",
          "brand": "brand name",
          "price": "£XX",
          "why": "one sentence why this works for their style"
        }
      ],
      "stylingTip": "specific styling tip for this outfit",
      "whyItWorks": "2 sentences explaining why this outfit works for their profile"
    }
  ],
  "styleGuide": {
    "doList": ["Do this", "Do that", "Do this too", "And this"],
    "dontList": ["Avoid this", "Never this", "Skip this", "Not this"],
    "essentials": ["Item 1 every man in this style needs", "Item 2", "Item 3"],
    "seasonalTips": {
      "spring": "one tip",
      "summer": "one tip",
      "autumn": "one tip",
      "winter": "one tip"
    }
  }
}

Rules:
- Create exactly 3 outfits
- Each outfit must have 3-4 items selected from the products provided above
- Keep all recommendations within the customer's budget (${quizData.budget})
- Make the intro and tips feel genuinely personal to their struggles and preferences
- Be specific and direct — no generic advice
- JSON only, no markdown, no preamble`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content[0].text.trim();
  return JSON.parse(text);
}

// ════════════════════════════════════════
// Build the PDF using PDFKit
// ════════════════════════════════════════
async function buildPDF(content, quizData, products) {
  const pdfPath = path.join(os.tmpdir(), `outfitify-${Date.now()}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const stream = fs.createWriteStream(pdfPath);

  // Colours
  const DARK    = '#0E0E1A';
  const BLUE    = '#3D3F8F';
  const GREEN   = '#4CAF8A';
  const WHITE   = '#FFFFFF';
  const GREY    = '#888899';
  const LIGHT   = '#E8E8F0';
  const CARD    = '#16162A';

  doc.pipe(stream);

  // ── Helper: draw rounded rect ──
  function roundedRect(x, y, w, h, r, fillColor, strokeColor) {
    doc.roundedRect(x, y, w, h, r);
    if (fillColor) doc.fillColor(fillColor);
    if (strokeColor) doc.strokeColor(strokeColor).lineWidth(1);
    if (fillColor && strokeColor) doc.fillAndStroke();
    else if (fillColor) doc.fill();
    else if (strokeColor) doc.stroke();
  }

  // ── PAGE 1: Cover ──
  // Background
  doc.rect(0, 0, 595, 842).fill(DARK);

  // Top accent bar
  doc.rect(0, 0, 595, 6).fill(GREEN);

  // Logo area
  roundedRect(40, 30, 515, 80, 8, BLUE, null);
  doc.fontSize(28).fillColor(GREEN).font('Helvetica-Bold')
     .text('OUTFITIFY', 40, 48, { width: 515, align: 'center' });
  doc.fontSize(11).fillColor(LIGHT).font('Helvetica')
     .text('Your Personalised Style Report', 40, 82, { width: 515, align: 'center' });

  // Style type hero
  doc.fontSize(42).fillColor(WHITE).font('Helvetica-Bold')
     .text(content.styleType, 40, 140, { width: 515, align: 'center' });
  doc.fontSize(16).fillColor(GREEN).font('Helvetica')
     .text(content.styleTagline, 40, 198, { width: 515, align: 'center' });

  // Divider
  doc.moveTo(40, 230).lineTo(555, 230).strokeColor(BLUE).lineWidth(1).stroke();

  // Intro
  roundedRect(40, 245, 515, 90, 8, CARD, null);
  doc.fontSize(12).fillColor(LIGHT).font('Helvetica')
     .text(content.intro, 55, 258, { width: 485, align: 'left', lineGap: 4 });

  // Colour palette
  doc.fontSize(10).fillColor(GREY).font('Helvetica-Bold')
     .text('YOUR COLOUR PALETTE', 40, 355, { characterSpacing: 2 });

  const swatchW = 85;
  const swatchX = 40;
  content.colourPalette.colours.forEach((hex, i) => {
    const x = swatchX + i * (swatchW + 8);
    roundedRect(x, 375, swatchW, 50, 6, hex, null);
    doc.fontSize(8).fillColor(GREY).font('Helvetica')
       .text(content.colourPalette.labels[i] || '', x, 432, { width: swatchW, align: 'center' });
  });

  doc.fontSize(10).fillColor(LIGHT).font('Helvetica')
     .text(content.colourPalette.description, 40, 452, { width: 515, lineGap: 3 });

  // What's inside
  doc.fontSize(10).fillColor(GREY).font('Helvetica-Bold')
     .text("WHAT'S INSIDE YOUR REPORT", 40, 505, { characterSpacing: 2 });

  const insideItems = [
    ['👕', '3 Complete Outfits', 'Built around your style and budget'],
    ['🛍️', 'Real Product Links', 'Click straight through to buy each item'],
    ['🎨', 'Colour Palette', 'Your personal tones that always work together'],
    ['💡', 'Styling Tips', 'Do\'s, don\'ts, and seasonal guidance'],
  ];

  insideItems.forEach(([icon, title, desc], i) => {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const x = 40 + col * 265;
    const y = 525 + row * 65;
    roundedRect(x, y, 250, 55, 6, CARD, null);
    doc.fontSize(18).text(icon, x + 12, y + 18);
    doc.fontSize(11).fillColor(WHITE).font('Helvetica-Bold').text(title, x + 48, y + 13);
    doc.fontSize(9).fillColor(GREY).font('Helvetica').text(desc, x + 48, y + 29, { width: 190 });
  });

  // Footer
  doc.rect(0, 810, 595, 32).fill(BLUE);
  doc.fontSize(9).fillColor(LIGHT).font('Helvetica')
     .text('outfitify.co.uk  ·  Making style effortless  ·  © Outfitify', 0, 820, { align: 'center' });

  // ── PAGES 2-4: One page per outfit ──
  for (let i = 0; i < content.outfits.length; i++) {
    const outfit = content.outfits[i];
    doc.addPage();
    doc.rect(0, 0, 595, 842).fill(DARK);
    doc.rect(0, 0, 595, 6).fill(GREEN);

    // Header
    roundedRect(40, 20, 515, 55, 8, BLUE, null);
    doc.fontSize(11).fillColor(GREEN).font('Helvetica-Bold')
       .text('OUTFITIFY', 40, 30, { width: 515, align: 'center', characterSpacing: 3 });
    doc.fontSize(10).fillColor(GREY).font('Helvetica')
       .text(`Outfit ${i + 1} of ${content.outfits.length}`, 40, 48, { width: 515, align: 'center' });

    // Outfit name
    doc.fontSize(30).fillColor(WHITE).font('Helvetica-Bold')
       .text(`0${i + 1}  ${outfit.name.toUpperCase()}`, 40, 92);
    doc.fontSize(13).fillColor(GREEN).font('Helvetica')
       .text(outfit.vibe, 40, 130);

    // Meta pills
    const pills = [
      `📅 ${outfit.occasion}`,
      `🌤 ${outfit.season}`,
    ];
    let pillX = 40;
    pills.forEach(pill => {
      const w = pill.length * 7 + 20;
      roundedRect(pillX, 155, w, 24, 12, CARD, null);
      doc.fontSize(9).fillColor(LIGHT).font('Helvetica').text(pill, pillX + 10, 162);
      pillX += w + 10;
    });

    // Why it works
    roundedRect(40, 192, 515, 55, 8, CARD, null);
    doc.fontSize(9).fillColor(GREEN).font('Helvetica-Bold')
       .text('WHY THIS WORKS FOR YOU', 55, 200, { characterSpacing: 1 });
    doc.fontSize(10).fillColor(LIGHT).font('Helvetica')
       .text(outfit.whyItWorks, 55, 215, { width: 485, lineGap: 3 });

    // Items
    doc.fontSize(9).fillColor(GREY).font('Helvetica-Bold')
       .text('THE ITEMS', 40, 263, { characterSpacing: 2 });

    // Try to fetch and embed product images
    let itemY = 280;
    for (const item of outfit.items) {
      // Find product in our data to get image URL
      let imageUrl = null;
      for (const catItems of Object.values(products)) {
        const match = catItems.find(p => p['Item Name'] === item.name);
        if (match) { imageUrl = match['Image URL']; break; }
      }

      roundedRect(40, itemY, 515, 68, 6, CARD, null);

      // Try to embed image
      if (imageUrl) {
        try {
          const imgResp = await axios.get(imageUrl, {
            responseType: 'arraybuffer', timeout: 5000
          });
          const imgBuffer = Buffer.from(imgResp.data);
          doc.image(imgBuffer, 48, itemY + 6, { width: 56, height: 56, fit: [56, 56] });
        } catch (e) {
          // Image failed — draw placeholder
          roundedRect(48, itemY + 6, 56, 56, 4, BLUE, null);
          doc.fontSize(20).fillColor(GREEN).text('👕', 60, itemY + 22);
        }
      } else {
        roundedRect(48, itemY + 6, 56, 56, 4, BLUE, null);
      }

      // Item details
      doc.fontSize(8).fillColor(GREEN).font('Helvetica-Bold')
         .text(item.category.toUpperCase(), 115, itemY + 10, { characterSpacing: 1 });
      doc.fontSize(11).fillColor(WHITE).font('Helvetica-Bold')
         .text(item.name, 115, itemY + 22, { width: 320 });
      doc.fontSize(9).fillColor(GREY).font('Helvetica')
         .text(item.why, 115, itemY + 38, { width: 320, lineGap: 2 });

      // Price + brand
      doc.fontSize(14).fillColor(GREEN).font('Helvetica-Bold')
         .text(item.price, 460, itemY + 14, { width: 80, align: 'right' });
      doc.fontSize(9).fillColor(GREY).font('Helvetica')
         .text(item.brand, 460, itemY + 35, { width: 80, align: 'right' });

      itemY += 76;
    }

    // Styling tip
    const tipY = itemY + 8;
    roundedRect(40, tipY, 515, 48, 8, '#1A1A35', null);
    doc.moveTo(40, tipY).lineTo(40, tipY + 48).strokeColor(GREEN).lineWidth(3).stroke();
    doc.fontSize(9).fillColor(GREEN).font('Helvetica-Bold')
       .text('STYLING TIP', 55, tipY + 8, { characterSpacing: 1 });
    doc.fontSize(10).fillColor(LIGHT).font('Helvetica-Oblique')
       .text(outfit.stylingTip, 55, tipY + 22, { width: 485, lineGap: 3 });

    // Footer
    doc.rect(0, 810, 595, 32).fill(BLUE);
    doc.fontSize(9).fillColor(LIGHT).font('Helvetica')
       .text('outfitify.co.uk  ·  Making style effortless', 0, 820, { align: 'center' });
  }

  // ── FINAL PAGE: Style Guide ──
  doc.addPage();
  doc.rect(0, 0, 595, 842).fill(DARK);
  doc.rect(0, 0, 595, 6).fill(GREEN);

  roundedRect(40, 20, 515, 55, 8, BLUE, null);
  doc.fontSize(11).fillColor(GREEN).font('Helvetica-Bold')
     .text('OUTFITIFY', 40, 30, { width: 515, align: 'center', characterSpacing: 3 });
  doc.fontSize(10).fillColor(GREY).font('Helvetica')
     .text('Your Personal Style Guide', 40, 48, { width: 515, align: 'center' });

  doc.fontSize(26).fillColor(WHITE).font('Helvetica-Bold')
     .text('YOUR STYLE GUIDE', 40, 92);
  doc.fontSize(12).fillColor(GREEN).font('Helvetica')
     .text(content.styleType, 40, 126);

  // Do's and Don'ts
  doc.fontSize(9).fillColor(GREY).font('Helvetica-Bold')
     .text("DO'S & DON'TS", 40, 158, { characterSpacing: 2 });

  // Do column
  roundedRect(40, 175, 248, 30, 6, '#1A3A2A', null);
  doc.fontSize(11).fillColor(GREEN).font('Helvetica-Bold').text('✓  DO', 55, 185);

  content.styleGuide.doList.forEach((item, i) => {
    const y = 212 + i * 30;
    roundedRect(40, y, 248, 26, 4, CARD, null);
    doc.fontSize(10).fillColor(LIGHT).font('Helvetica').text(`✓  ${item}`, 55, y + 8, { width: 218 });
  });

  // Don't column
  roundedRect(307, 175, 248, 30, 6, '#3A1A1A', null);
  doc.fontSize(11).fillColor('#FF5252').font('Helvetica-Bold').text("✗  DON'T", 322, 185);

  content.styleGuide.dontList.forEach((item, i) => {
    const y = 212 + i * 30;
    roundedRect(307, y, 248, 26, 4, CARD, null);
    doc.fontSize(10).fillColor(LIGHT).font('Helvetica').text(`✗  ${item}`, 322, y + 8, { width: 218 });
  });

  // Essentials
  const essY = 212 + content.styleGuide.doList.length * 30 + 20;
  doc.fontSize(9).fillColor(GREY).font('Helvetica-Bold')
     .text('3 ESSENTIALS EVERY MAN IN YOUR STYLE NEEDS', 40, essY, { characterSpacing: 1 });

  content.styleGuide.essentials.forEach((item, i) => {
    const y = essY + 20 + i * 36;
    roundedRect(40, y, 515, 30, 6, CARD, null);
    doc.fontSize(22).fillColor(GREEN).text(`0${i + 1}`, 50, y + 5);
    doc.fontSize(11).fillColor(WHITE).font('Helvetica-Bold').text(item, 90, y + 10, { width: 450 });
  });

  // Seasonal tips
  const seasY = essY + 20 + content.styleGuide.essentials.length * 36 + 16;
  doc.fontSize(9).fillColor(GREY).font('Helvetica-Bold')
     .text('SEASONAL TIPS', 40, seasY, { characterSpacing: 2 });

  const seasons = [
    ['🌸 Spring', content.styleGuide.seasonalTips.spring],
    ['☀️ Summer', content.styleGuide.seasonalTips.summer],
    ['🍂 Autumn', content.styleGuide.seasonalTips.autumn],
    ['❄️ Winter', content.styleGuide.seasonalTips.winter],
  ];

  seasons.forEach(([season, tip], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 40 + col * 265;
    const y = seasY + 20 + row * 70;
    roundedRect(x, y, 248, 62, 6, CARD, null);
    doc.fontSize(11).fillColor(GREEN).font('Helvetica-Bold').text(season, x + 12, y + 10);
    doc.fontSize(9).fillColor(LIGHT).font('Helvetica').text(tip, x + 12, y + 28, { width: 224, lineGap: 3 });
  });

  // CTA
  const ctaY = seasY + 20 + 2 * 70 + 16;
  roundedRect(40, ctaY, 515, 60, 8, BLUE, null);
  doc.fontSize(14).fillColor(WHITE).font('Helvetica-Bold')
     .text('Want new outfits as your style evolves?', 40, ctaY + 12, { width: 515, align: 'center' });
  doc.fontSize(11).fillColor(GREEN).font('Helvetica')
     .text('Retake the quiz anytime at outfitify.co.uk', 40, ctaY + 34, { width: 515, align: 'center' });

  // Footer
  doc.rect(0, 810, 595, 32).fill(BLUE);
  doc.fontSize(9).fillColor(LIGHT).font('Helvetica')
     .text('outfitify.co.uk  ·  Making style effortless  ·  © Outfitify', 0, 820, { align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(pdfPath));
    stream.on('error', reject);
  });
}

// ════════════════════════════════════════
// Send backup email via ZeptoMail SMTP
// ════════════════════════════════════════
async function sendBackupEmail(toEmail, downloadUrl, styleType) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.zeptomail.eu',
    port: 587,
    auth: {
      user: process.env.ZEPTO_SMTP_USER,
      pass: process.env.ZEPTO_SMTP_PASS,
    }
  });

  await transporter.sendMail({
    from: '"Outfitify" <outfitify@outfitify.co.uk>',
    to: toEmail,
    subject: `Your ${styleType} Style Report is Ready 🔥`,
    html: `
      <div style="background:#0E0E1A;padding:40px;font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#3D3F8F;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
          <h1 style="color:#4CAF8A;font-size:24px;letter-spacing:3px;margin:0">OUTFITIFY</h1>
          <p style="color:#E8E8F0;margin:8px 0 0">Your Personalised Style Report</p>
        </div>
        <h2 style="color:white;font-size:22px">Your report is ready! 🎉</h2>
        <p style="color:#888899;font-size:15px;line-height:1.6">
          Your personalised <strong style="color:white">${styleType}</strong> style report has been generated. 
          Click below to download your 5 complete outfits, colour palette, styling tips and more.
        </p>
        <a href="${downloadUrl}" style="display:block;background:#4CAF8A;color:white;text-align:center;padding:18px;border-radius:10px;font-size:16px;font-weight:bold;text-decoration:none;margin:24px 0">
          Download My Style Report →
        </a>
        <p style="color:#888899;font-size:12px;text-align:center">
          This link is unique to you. If you have any issues, reply to this email.
        </p>
        <div style="border-top:1px solid #222;padding-top:16px;text-align:center;margin-top:24px">
          <p style="color:#888899;font-size:11px">Outfitify · Making style effortless · outfitify.co.uk</p>
        </div>
      </div>
    `
  });
}

// ════════════════════════════════════════
// Start server
// ════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Outfitify backend running on port ${PORT}`));
