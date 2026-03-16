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
    'https://unlock.outfitify.co.uk',
    'https://success.outfitify.co.uk',
    'https://quiz.outfitify.co.uk',
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
// Quiz data is stored in Stripe metadata so it
// survives server restarts before webhook fires
// ════════════════════════════════════════
app.post('/api/create-checkout', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessions.has(sessionId)) {
    return res.status(400).json({ error: 'Session not found or expired' });
  }

  const quizData = sessions.get(sessionId);

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
      success_url: `${process.env.SUCCESS_URL || "https://success.outfitify.co.uk"}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}`,
      cancel_url: `${process.env.UNLOCK_PAGE_URL}?sid=${sessionId}&cancelled=true`,
      customer_email: quizData.email,
      metadata: {
        sessionId,
        style:        quizData.style        || '',
        budget:       quizData.budget       || '',
        colours:      quizData.colours      || '',
        struggles:    quizData.struggles    || '',
        brands:       quizData.brands       || '',
        openToBrands: quizData.openToBrands || '',
        email:        quizData.email        || '',
      },
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
// Quiz data is read from Stripe metadata — not
// in-memory sessions — so restarts don't break it
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

    console.log(`Webhook received for session ${sessionId}, email: ${userEmail}`);

    const quizData = {
      style:        session.metadata.style,
      budget:       session.metadata.budget,
      colours:      session.metadata.colours,
      struggles:    session.metadata.struggles,
      brands:       session.metadata.brands,
      openToBrands: session.metadata.openToBrands,
      email:        session.metadata.email,
    };

    // Fire and forget — generate PDF in background
    generateAndStoreReport(sessionId, quizData, userEmail).catch(err => {
      console.error(`Unhandled error in generateAndStoreReport for ${sessionId}:`, err);
    });
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

  // Map style to sheet style values — must match column I exactly
  const styleMap = {
    'everyday fits':           'Everyday Fits',
    'everyday fit':            'Everyday Fits',
    'streetwear':              'Streetwear',
    'smart casual':            'Smart Casual/Workwear',
    'smart casual / workwear': 'Smart Casual/Workwear',
    'date night':              'Date Night/Going Out',
    'date night / going out':  'Date Night/Going Out',
    'active':                  'Active/Gym wear',
    'active/gym wear':         'Active/Gym wear',
    'active gym wear':         'Active/Gym wear',
  };
  const sheetStyle = styleMap[(style || '').toLowerCase()] || 'Everyday Fits';

  console.log(`[fetchProducts] raw style="${style}" → sheetStyle="${sheetStyle}" budget=${maxPrice}`);

  // Filter by style and budget — no fallback to avoid mixing styles
  const filtered = products.filter(p => {
    const price = parseFloat(p['Price']) || 0;
    const matchesStyle = (p['Style'] || '').trim() === sheetStyle;
    const matchesBudget = price <= maxPrice;
    return matchesStyle && matchesBudget && p['Item Name'];
  });

  console.log(`[fetchProducts] filtered ${filtered.length} products for style="${sheetStyle}"`);

  // If nothing matched, fall back to all products within budget
  const pool = filtered.length >= 6 ? filtered : products.filter(p => {
    const price = parseFloat(p['Price']) || 0;
    return price <= maxPrice && p['Item Name'];
  });

  // Group by category
  const byCategory = {};
  pool.forEach(p => {
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

  const raw = message.content[0].text.trim();
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(text);
}

// ════════════════════════════════════════
// Build the PDF using PDFKit (dark theme)
// ════════════════════════════════════════
async function buildPDF(content, quizData, products) {
  const pdfPath = path.join(os.tmpdir(), `outfitify-${Date.now()}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  // ── Design tokens ──
  const BG      = '#0D1117';
  const HEADER  = '#161B22';
  const BORDER  = '#30363D';
  const GREEN   = '#6EE7B7';
  const PURPLE  = '#A78BFA';
  const WHITE   = '#F0F6FC';
  const GREY    = '#8B949E';
  const MUTED   = '#C9D1D9';
  const CARD    = '#161B22';
  const CARD2   = '#21262D';
  const RED     = '#F87171';

  const PW = 595, PH = 842;
  const PAD = 50;
  const IW = PW - PAD * 2; // inner width = 495

  // ── Helpers ──
  function bg() { doc.rect(0, 0, PW, PH).fill(BG); }

  function header(sub) {
    doc.rect(0, 0, PW, 40).fill(HEADER);
    doc.rect(0, 39, PW, 1).fill(BORDER);
    doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold')
       .text('OUTFITIFY', 0, 13, { width: PW, align: 'center', characterSpacing: 5 });
    if (sub) {
      doc.fontSize(7).fillColor(GREY).font('Helvetica')
         .text(sub, 0, 25, { width: PW, align: 'center', characterSpacing: 1 });
    }
  }

  function footer() {
    doc.rect(0, PH - 30, PW, 30).fill(HEADER);
    doc.rect(0, PH - 30, PW, 1).fill(BORDER);
    doc.fontSize(7.5).fillColor(GREY).font('Helvetica')
       .text('outfitify.co.uk  ·  Making style effortless  ·  © Outfitify', 0, PH - 17, { width: PW, align: 'center' });
  }

  function sectionLabel(text, y) {
    doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold')
       .text(text, PAD, y, { characterSpacing: 2 });
    doc.moveTo(PAD, y + 13).lineTo(PAD + IW, y + 13).strokeColor(CARD2).lineWidth(1).stroke();
  }

  function card(x, y, w, h, color) {
    doc.roundedRect(x, y, w, h, 8).fill(color || CARD);
  }

  function lcard(x, y, w, h, accentColor) {
    doc.rect(x, y, w, h).fill(CARD);
    doc.roundedRect(x, y, w, h, 6).fill(CARD);
    doc.rect(x, y, 3, h).fill(accentColor || GREEN);
  }

  // ════════════════════════════════════════
  // PAGE 1: COVER
  // ════════════════════════════════════════
  bg();
  // Hero gradient block
  doc.rect(0, 40, PW, 160).fill('#0C1622');
  doc.moveTo(0, 200).lineTo(PW, 200).strokeColor(CARD2).lineWidth(1).stroke();

  header();

  // Eyebrow
  doc.moveTo(PAD, 65).lineTo(PAD + 20, 65).strokeColor(GREEN).lineWidth(2).stroke();
  doc.fontSize(9).fillColor(GREY).font('Helvetica')
     .text('Your Personalised Style Report', PAD + 28, 60);

  // Big style name
  const parts = content.styleType.split(' ');
  const line1 = parts[0] || '';
  const line2 = parts.slice(1).join(' ') || '';
  doc.fontSize(52).fillColor(WHITE).font('Helvetica-Bold').text(line1.toUpperCase(), PAD, 78);
  doc.fontSize(52).fillColor(GREEN).font('Helvetica-Bold').text(line2.toUpperCase(), PAD, 128);

  // Tagline
  doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique')
     .text(content.styleTagline, PAD, 186, { width: IW });

  // About card
  lcard(PAD, 218, IW, 72, GREEN);
  doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold')
     .text('ABOUT YOUR REPORT', PAD + 14, 226, { characterSpacing: 2 });
  doc.fontSize(10).fillColor(MUTED).font('Helvetica')
     .text(content.intro, PAD + 14, 240, { width: IW - 28, lineGap: 3 });

  // Colour palette
  sectionLabel('YOUR COLOUR PALETTE', 308);
  const sw = 56, swGap = 11;
  content.colourPalette.colours.forEach((hex, i) => {
    const x = PAD + i * (sw + swGap);
    doc.roundedRect(x, 330, sw, sw, 8).fill(hex);
    doc.fontSize(8).fillColor(GREY).font('Helvetica')
       .text(content.colourPalette.labels[i] || '', x, 393, { width: sw, align: 'center' });
  });
  doc.fontSize(10).fillColor(GREY).font('Helvetica')
     .text(content.colourPalette.description, PAD, 410, { width: IW, lineGap: 3 });

  // What's inside
  sectionLabel("WHAT'S INSIDE", 450);
  const insideItems = [
    ['3', 'Complete Outfits', 'Built around your style and budget'],
    ['✓', 'Real Product Links', 'Click straight through to buy'],
    ['5', 'Colour Palette', 'Your personal tones that always work'],
    ['✓', 'Styling Tips', "Do's, don'ts & seasonal guidance"],
  ];
  insideItems.forEach(([num, title, desc], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = PAD + col * (IW / 2 + 5), y = 472 + row * 58;
    card(x, y, IW / 2 - 5, 50, CARD2);
    doc.fontSize(20).fillColor(GREEN).font('Helvetica-Bold').text(num, x + 12, y + 15);
    doc.fontSize(10).fillColor(WHITE).font('Helvetica-Bold').text(title, x + 46, y + 10);
    doc.fontSize(8).fillColor(GREY).font('Helvetica').text(desc, x + 46, y + 25, { width: 170 });
  });

  footer();

  // ════════════════════════════════════════
  // PAGES 2-4: OUTFIT PAGES
  // ════════════════════════════════════════
  for (let i = 0; i < content.outfits.length; i++) {
    const outfit = content.outfits[i];
    doc.addPage();
    bg();
    header(`Outfit ${i + 1} of ${content.outfits.length}`);

    // Hero
    doc.rect(0, 40, PW, 120).fill('#0C1622');
    doc.moveTo(0, 160).lineTo(PW, 160).strokeColor(CARD2).lineWidth(1).stroke();

    // Outfit number + name — clamp font size to prevent overflow
    const nameText = outfit.name.toUpperCase();
    const nameFontSize = nameText.length > 20 ? 28 : nameText.length > 14 ? 34 : 40;
    doc.fontSize(nameFontSize).font('Helvetica-Bold');
    doc.fillColor(GREEN).text(`0${i + 1}`, PAD, 58, { continued: true });
    doc.fillColor(WHITE).text(`  ${nameText}`, { lineBreak: false });
    doc.fontSize(11).fillColor(PURPLE).font('Helvetica-Oblique').text(outfit.vibe, PAD, 108);

    // Tags
    let tagX = PAD;
    [outfit.occasion, outfit.season].forEach(tag => {
      const tw = Math.min(tag.length * 6 + 20, 200);
      doc.roundedRect(tagX, 122, tw, 20, 10).fill(CARD2);
      doc.fontSize(8).fillColor(GREY).font('Helvetica').text(tag, tagX + 10, 128, { width: tw - 20 });
      tagX += tw + 8;
    });

    // Why it works card
    lcard(PAD, 172, IW, 54, GREEN);
    doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold')
       .text('WHY THIS WORKS FOR YOU', PAD + 14, 180, { characterSpacing: 2 });
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica')
       .text(outfit.whyItWorks, PAD + 14, 194, { width: IW - 28, lineGap: 3 });

    // Items label
    doc.fontSize(7).fillColor(GREY).font('Helvetica-Bold')
       .text('THE ITEMS', PAD, 240, { characterSpacing: 2 });

    // Items
    let itemY = 255;
    for (const item of outfit.items) {
      // Try to find image
      let imageUrl = null;
      for (const catItems of Object.values(products)) {
        const match = catItems.find(p => p['Item Name'] === item.name);
        if (match) { imageUrl = match['Image URL']; break; }
      }

      // Item card
      doc.roundedRect(PAD, itemY, IW, 66).fill(CARD);
      doc.roundedRect(PAD, itemY, IW, 66).strokeColor(CARD2).lineWidth(1).stroke();

      // Try image
      if (imageUrl) {
        try {
          const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 5000 });
          doc.image(Buffer.from(imgResp.data), PAD + 8, itemY + 5, { width: 56, height: 56, cover: [56, 56] });
        } catch (e) {
          doc.roundedRect(PAD + 8, itemY + 5, 56, 56, 6).fill(CARD2);
        }
      } else {
        doc.roundedRect(PAD + 8, itemY + 5, 56, 56, 6).fill(CARD2);
      }

      const tx = PAD + 74;
      doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold')
         .text(item.category.toUpperCase(), tx, itemY + 8, { characterSpacing: 1.5 });
      doc.fontSize(10).fillColor(WHITE).font('Helvetica-Bold')
         .text(item.name, tx, itemY + 20, { width: 300, lineGap: 2 });
      doc.fontSize(8.5).fillColor(GREY).font('Helvetica')
         .text(item.why, tx, itemY + 38, { width: 300, lineGap: 2 });

      doc.fontSize(18).fillColor(GREEN).font('Helvetica-Bold')
         .text(item.price, PAD + IW - 70, itemY + 12, { width: 60, align: 'right' });
      doc.fontSize(8).fillColor(GREY).font('Helvetica')
         .text(item.brand, PAD + IW - 70, itemY + 36, { width: 60, align: 'right' });

      itemY += 74;
    }

    // Styling tip
    const tipY = itemY + 6;
    lcard(PAD, tipY, IW, 44, PURPLE);
    doc.fontSize(7).fillColor(PURPLE).font('Helvetica-Bold')
       .text('STYLING TIP', PAD + 14, tipY + 8, { characterSpacing: 2 });
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica-Oblique')
       .text(outfit.stylingTip, PAD + 14, tipY + 22, { width: IW - 28 });

    footer();
  }

  // ════════════════════════════════════════
  // FINAL PAGE: STYLE GUIDE
  // ════════════════════════════════════════
  doc.addPage();
  bg();
  header('Your Personal Style Guide');

  // Hero
  doc.rect(0, 40, PW, 80).fill('#0C1622');
  doc.moveTo(0, 120).lineTo(PW, 120).strokeColor(CARD2).lineWidth(1).stroke();
  doc.fontSize(26).fillColor(WHITE).font('Helvetica-Bold').text('YOUR STYLE GUIDE', PAD, 55);
  doc.fontSize(12).fillColor(GREEN).font('Helvetica-Oblique').text(content.styleType, PAD, 88);

  // Do's and Don'ts
  sectionLabel("DO'S & DON'TS", 132);

  // Do column
  const colW = (IW - 10) / 2;
  doc.roundedRect(PAD, 154, colW, 24, 6).fill('#0D2418');
  doc.fontSize(9).fillColor(GREEN).font('Helvetica-Bold').text('✓  DO', PAD + 12, 163);
  content.styleGuide.doList.forEach((item, i) => {
    const y = 184 + i * 28;
    doc.roundedRect(PAD, y, colW, 22, 5).fill(CARD2);
    doc.fontSize(8.5).fillColor(MUTED).font('Helvetica').text(`✓  ${item}`, PAD + 12, y + 7, { width: colW - 24 });
  });

  // Don't column
  const col2X = PAD + colW + 10;
  doc.roundedRect(col2X, 154, colW, 24, 6).fill('#2A1010');
  doc.fontSize(9).fillColor(RED).font('Helvetica-Bold').text("✗  DON'T", col2X + 12, 163);
  content.styleGuide.dontList.forEach((item, i) => {
    const y = 184 + i * 28;
    doc.roundedRect(col2X, y, colW, 22, 5).fill(CARD2);
    doc.fontSize(8.5).fillColor(MUTED).font('Helvetica').text(`✗  ${item}`, col2X + 12, y + 7, { width: colW - 24 });
  });

  // Essentials
  const essY = 184 + content.styleGuide.doList.length * 28 + 16;
  sectionLabel('3 ESSENTIALS EVERY MAN IN YOUR STYLE NEEDS', essY);
  content.styleGuide.essentials.forEach((item, i) => {
    const y = essY + 20 + i * 34;
    doc.roundedRect(PAD, y, IW, 28, 6).fill(CARD2);
    doc.fontSize(18).fillColor(GREEN).font('Helvetica-Bold').text(`0${i + 1}`, PAD + 10, y + 5);
    doc.fontSize(10).fillColor(WHITE).font('Helvetica-Bold').text(item, PAD + 46, y + 9, { width: IW - 60 });
  });

  // Seasonal tips
  const seasY = essY + 20 + content.styleGuide.essentials.length * 34 + 16;
  sectionLabel('SEASONAL TIPS', seasY);
  const seasons = [
    ['Spring', GREEN,   content.styleGuide.seasonalTips.spring],
    ['Summer', '#F59E0B', content.styleGuide.seasonalTips.summer],
    ['Autumn', '#D97706', content.styleGuide.seasonalTips.autumn],
    ['Winter', PURPLE,  content.styleGuide.seasonalTips.winter],
  ];
  seasons.forEach(([name, color, tip], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = PAD + col * (colW + 10), y = seasY + 20 + row * 62;
    doc.roundedRect(x, y, colW, 54, 6).fill(CARD2);
    doc.fontSize(10).fillColor(color).font('Helvetica-Bold').text(name, x + 10, y + 10);
    doc.fontSize(8.5).fillColor(GREY).font('Helvetica').text(tip, x + 10, y + 28, { width: colW - 20, lineGap: 2 });
  });

  // CTA
  const ctaY = seasY + 20 + 2 * 62 + 14;
  doc.roundedRect(PAD, ctaY, IW, 52, 8).fill(CARD2);
  doc.roundedRect(PAD, ctaY, IW, 52, 8).strokeColor(GREEN).lineWidth(1).stroke();
  doc.fontSize(12).fillColor(WHITE).font('Helvetica-Bold')
     .text('Want new outfits as your style evolves?', PAD, ctaY + 12, { width: IW, align: 'center' });
  doc.fontSize(10).fillColor(GREEN).font('Helvetica')
     .text('Retake the quiz anytime at outfitify.co.uk', PAD, ctaY + 30, { width: IW, align: 'center' });

  footer();
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
