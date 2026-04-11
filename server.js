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

// ── GRACEFUL SHUTDOWN ──
let activeJobs = 0;

process.on('SIGTERM', () => {
  console.log(`SIGTERM received. Active jobs: ${activeJobs}. Waiting before exit...`);
  const wait = () => {
    if (activeJobs === 0) { console.log('All jobs done, exiting.'); process.exit(0); }
    else { console.log(`Still waiting on ${activeJobs} job(s)...`); setTimeout(wait, 5000); }
  };
  wait();
});

// ── CORS ──
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

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const sessions = new Map();

const DOWNLOADS_DIR = path.join(os.tmpdir(), 'outfitify-downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

function downloadsPath(sessionId) { return path.join(DOWNLOADS_DIR, `${sessionId}.json`); }
function saveDownload(sessionId, data) { fs.writeFileSync(downloadsPath(sessionId), JSON.stringify(data)); }
function getDownload(sessionId) {
  const p = downloadsPath(sessionId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function findDownloadByToken(token) {
  if (!fs.existsSync(DOWNLOADS_DIR)) return null;
  for (const file of fs.readdirSync(DOWNLOADS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DOWNLOADS_DIR, file), 'utf8'));
      if (data.token === token) return data;
    } catch { /* skip */ }
  }
  return null;
}

// ════════════════════════════════════════
// STEP 1 — Save quiz answers
// New fields: budget, struggles, lifestyle, goal
// Removed: style, colours, brands, openToBrands
// ════════════════════════════════════════
app.post('/api/save-session', (req, res) => {
  const { budget, struggles, lifestyle, goal, fit, email } = req.body;
  if (!budget || !email) return res.status(400).json({ error: 'Missing required fields' });
  const sessionId = crypto.randomBytes(16).toString('hex');
  sessions.set(sessionId, { budget, struggles, lifestyle, goal, fit, email, createdAt: Date.now() });
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
  if (!sessions.has(sessionId)) return res.status(400).json({ error: 'Session not found or expired' });
  const quizData = sessions.get(sessionId);
  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: 'Outfitify Personal Style Blueprint',
            description: 'Your personalised style diagnosis, blueprint, wardrobe formula and outfit examples — built around you.',
            images: ['https://outfitify.co.uk/assets/images/image04.png']
          },
          unit_amount: 1499  // £14.99
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || "https://success.outfitify.co.uk"}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}`,
      cancel_url: `${process.env.UNLOCK_PAGE_URL}?sid=${sessionId}&cancelled=true`,
      customer_email: quizData.email,
      metadata: {
        sessionId,
        budget:    quizData.budget    || '',
        struggles: quizData.struggles || '',
        lifestyle: quizData.lifestyle || '',
        goal:      quizData.goal      || '',
        fit:       quizData.fit       || '',
        email:     quizData.email     || '',
      },
    });
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
});

// ════════════════════════════════════════
// STEP 3 — Stripe Webhook
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
      budget:    session.metadata.budget,
      struggles: session.metadata.struggles,
      lifestyle: session.metadata.lifestyle,
      goal:      session.metadata.goal,
      fit:       session.metadata.fit,
      email:     session.metadata.email,
    };
    generateAndStoreReport(sessionId, quizData, userEmail).catch(err => {
      console.error(`Unhandled error in generateAndStoreReport for ${sessionId}:`, err);
    });
  }
  res.json({ received: true });
});

// ════════════════════════════════════════
// STEP 4 — Poll for PDF readiness
// ════════════════════════════════════════
app.get('/api/report-status/:sessionId', (req, res) => {
  const dl = getDownload(req.params.sessionId);
  if (dl) res.json({ ready: true, downloadToken: dl.token });
  else res.json({ ready: false });
});

// ════════════════════════════════════════
// STEP 5 — Serve PDF download
// ════════════════════════════════════════
app.get('/api/download/:token', (req, res) => {
  const data = findDownloadByToken(req.params.token);
  if (data) {
    if (!fs.existsSync(data.pdfPath)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Outfitify-Style-Report.pdf"`);
    return fs.createReadStream(data.pdfPath).pipe(res);
  }
  res.status(404).json({ error: 'Download link not found or expired' });
});

// ════════════════════════════════════════
// CORE: Generate report
// ════════════════════════════════════════
async function generateAndStoreReport(sessionId, quizData, userEmail) {
  activeJobs++;
  console.log(`Generating report for session ${sessionId}... (active jobs: ${activeJobs})`);
  try {
    const products = await fetchProducts(quizData.budget);
    const reportContent = await generateReportContent(quizData, products);
    const pdfPath = await buildPDF(reportContent, quizData, products);
    const token = crypto.randomBytes(32).toString('hex');
    saveDownload(sessionId, { token, pdfPath, email: userEmail, createdAt: Date.now() });
    const downloadUrl = `${process.env.BASE_URL}/api/download/${token}`;
    await sendEmail(userEmail, downloadUrl, reportContent.styleIdentity.name);
    console.log(`Report ready for session ${sessionId}`);
  } catch (err) {
    console.error(`Report generation failed for ${sessionId}:`, err);
  } finally {
    activeJobs--;
    console.log(`Job done for ${sessionId}. Active jobs remaining: ${activeJobs}`);
  }
}

// ════════════════════════════════════════
// Fetch products from Google Sheet
// Now filters only on budget — goal/lifestyle drives style direction
// ════════════════════════════════════════
async function fetchProducts(budget) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:J',
  });

  const rows = response.data.values;
  const headers = rows[0];
  const products = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i] || '');
    return obj;
  });

  const budgetMap = { 'Under £30': 30, '£30–£60': 60, '£60–£100': 100, '£100+': 9999 };
  const maxPrice = budgetMap[budget] || 60;

  // Filter by budget and active status only
  const filtered = products.filter(p => {
    const price = parseFloat(p['Price']) || 0;
    const active = !p['Status'] || p['Status'].toLowerCase() === 'active';
    return price <= maxPrice && p['Item Name'] && active;
  });

  console.log(`[fetchProducts] budget=${maxPrice}, filtered=${filtered.length} active products`);

  // Group by category and shuffle randomly
  const byCategory = {};
  filtered.forEach(p => {
    const cat = p['Category'] || 'Other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  });

  const categories = ['Top', 'Bottoms', 'Shoes', 'Hoodie/Jacket'];
  const selected = {};
  categories.forEach(cat => {
    const items = (byCategory[cat] || []).sort(() => Math.random() - 0.5);
    selected[cat] = items.slice(0, 8);
  });

  return selected;
}

// ════════════════════════════════════════
// Generate report content via Claude
// ════════════════════════════════════════
async function generateReportContent(quizData, products) {
  const productSummary = {};
  for (const [cat, items] of Object.entries(products)) {
    productSummary[cat] = items.slice(0, 4).map(p => ({
      name: p['Item Name'],
      brand: p['Brand'],
      price: `£${p['Price']}`,
      url: p['Product URL']
    }));
  }

  const prompt = `You are the Outfitify AI stylist. You write like a senior personal stylist who has worked with hundreds of men — direct, confident, specific and authoritative. You never write generic advice. Every single sentence must be tied to this customer's specific answers.

CUSTOMER PROFILE:
- Budget per item: ${quizData.budget}
- Style struggles (what they selected — address these directly): ${quizData.struggles}
- Lifestyle: ${quizData.lifestyle}
- Style goal: ${quizData.goal}
- How clothes fit them: ${quizData.fit}

AVAILABLE PRODUCTS (use these as outfit illustrations — select 3 outfits of 3-4 items each):
${JSON.stringify(productSummary, null, 2)}

TONE RULES — follow these strictly:
- Write in second person ("you", "your") — never third person
- Never use: "it's important to", "consider", "you might want to", "here are some tips", "great", "amazing", "awesome", "key pieces", "wardrobe staples", "elevate your look", "game changer"
- Never start a sentence with "Remember" or "Note that"
- Never give advice that could apply to any man — every sentence must be specific to this customer
- Write like you know this person — because you do
- Be direct and authoritative — a good stylist doesn't hedge

Generate a style report with exactly this JSON structure (JSON only, no markdown, no preamble):
{
  "styleIdentity": {
    "name": "2-3 word style identity e.g. 'Sharp Minimalist' or 'Relaxed Authority' — derived from their goal and lifestyle, not a generic style category",
    "tagline": "One punchy sentence that captures exactly who they are as a dresser and where they're going — specific to their goal",
    "intro": "3 sentences. Sentence 1: acknowledge exactly where they are right now based on their struggles — make them feel seen. Sentence 2: name the specific thing that has been holding them back. Sentence 3: tell them what changes after reading this report."
  },
  "colourPalette": {
    "colours": ["#hex1", "#hex2", "#hex3", "#hex4", "#hex5"],
    "labels": ["name1", "name2", "name3", "name4", "name5"],
    "rationale": "2 sentences. Why these specific colours work for their goal and lifestyle. Name the colours and explain exactly how to use them together — base tones vs accent."
  },
  "diagnosis": {
    "headline": "One direct punchy headline — e.g. 'You are not lacking style. You are lacking a system.' Make it feel like a revelation.",
    "body": "4-5 sentences. Address their specific selected struggles head on. Explain the root cause not the symptom — why do these struggles actually happen? Be direct. No softening. This is the page that makes them feel completely understood.",
    "theTruth": "One single bold statement — the core insight that reframes how they think about their style problem. Make it feel like something they have never heard before."
  },
  "styleDNA": {
    "silhouette": "Exactly what silhouette works for their body, goal and lifestyle — use their fit answer to give specific proportions advice. E.g. if clothes are baggy, recommend slimmer cuts and layering to add structure. If tight on arms/shoulders, recommend relaxed fits with more room through the chest and shoulder. Be specific about what to look for and what to avoid.",,
    "fitLanguage": "The exact fit vocabulary they should use when shopping — specific terms like 'relaxed shoulder', 'tapered leg', 'dropped hem' that they can actually search for",
    "fabrics": "Which fabrics work for their specific lifestyle and why — tied to their actual week, not generic quality advice",
    "colourUsage": "How to actually use their palette day to day — specific ratios, which colours to use as base vs accent, how to combine them",
    "avoid": "Exactly what they should stop wearing immediately and precisely why — be direct, not diplomatic"
  },
  "wardrobeBlueprint": {
    "headline": "One sentence that frames their entire wardrobe strategy — specific to their goal",
    "priorities": [
      {
        "order": 1,
        "item": "Specific wardrobe item to buy first",
        "why": "Exactly why this is the priority — tied directly to their lifestyle and goal",
        "howToShop": "Specific guidance on what to look for — fit cues, fabric, what to avoid when buying this specific item"
      },
      {
        "order": 2,
        "item": "Second priority item",
        "why": "Why this comes second",
        "howToShop": "Specific shopping guidance"
      },
      {
        "order": 3,
        "item": "Third priority item",
        "why": "Why this is third",
        "howToShop": "Specific shopping guidance"
      },
      {
        "order": 4,
        "item": "Fourth priority item",
        "why": "Why fourth",
        "howToShop": "Specific shopping guidance"
      },
      {
        "order": 5,
        "item": "Fifth priority item",
        "why": "Why fifth",
        "howToShop": "Specific shopping guidance"
      }
    ],
    "neverBuyAgain": "2-3 specific things they should stop buying immediately and exactly why — tied to their struggles and goal",
    "costPerWear": "One specific insight about how to think about spending for their exact budget level"
  },
  "outfits": [
    {
      "name": "Outfit name",
      "occasion": "Specific occasion drawn from their lifestyle",
      "items": [
        {
          "category": "Top/Bottoms/Shoes/Layer",
          "name": "exact product name from the list above",
          "brand": "brand name",
          "price": "£XX",
          "url": "exact product url from the list above",
          "why": "One sentence — why this specific item works for their goal. Reference fit, fabric or a specific detail. Never generic praise."
        }
      ],
      "howToWear": "Specific styling instruction for this exact outfit — reference the actual items by name or category",
      "whyItWorks": "Why this outfit directly serves their goal and lifestyle — tied to their specific answers"
    }
  ],
  "whereToInvest": [
    {
      "brand": "Brand name",
      "why": "One specific sentence on why this brand suits their goal, lifestyle and budget — not generic praise",
      "bestFor": "The specific product type this brand does best for their style direction"
    }
  ]
}

Rules:
- wardrobeBlueprint.priorities must contain exactly 5 items in priority order
- outfits must contain exactly 3 outfits, each with 3-4 items from the products above
- whereToInvest must contain exactly 4 brands — real UK-accessible brands only
- Include the exact product URL for each outfit item from the list above
- Every field must be specific to this customer — if it could apply to any man, rewrite it
- JSON only, no markdown, no preamble`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = message.content[0].text.trim();
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(text);

  // Log the full output so we can review quality before PDF rebuild
  console.log('=== CLAUDE OUTPUT ===');
  console.log(JSON.stringify(parsed, null, 2));
  console.log('=== END OUTPUT ===');

  return parsed;
}

// ════════════════════════════════════════
// Build PDF — placeholder version for testing
// Renders the Claude output as readable text so
// we can verify content quality before full rebuild
// ════════════════════════════════════════
async function buildPDF(content, quizData, products) {
  const pdfPath = path.join(os.tmpdir(), `outfitify-${Date.now()}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: true });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  const BG     = '#0A0A0A';
  const GREEN  = '#B8A898';
  const WHITE  = '#F2EDE6';
  const GREY   = '#7A6E66';
  const MUTED  = '#C8BFB5';
  const CARD   = '#141210';
  const CARD2  = '#1C1916';
  const BORDER = '#2A2520';
  const PW = 595, PH = 842, PAD = 50, IW = 495;

  function bg() { doc.rect(0, 0, PW, PH).fill(BG); }
  function header(sub) {
    doc.rect(0, 0, PW, 36).fill('#111111');
    doc.rect(0, 35, PW, 1).fill(BORDER);
    doc.fontSize(8).fillColor(WHITE).font('Helvetica-Bold')
       .text('OUTFITIFY', 0, 11, { width: PW, align: 'center', characterSpacing: 6 });
    if (sub) doc.fontSize(6.5).fillColor(GREY).font('Helvetica')
       .text(sub.toUpperCase(), 0, 22, { width: PW, align: 'center', characterSpacing: 2 });
  }
  function footer() {
    doc.rect(0, PH - 28, PW, 28).fill('#111111');
    doc.rect(0, PH - 28, PW, 1).fill(BORDER);
    doc.fontSize(7).fillColor(GREY).font('Helvetica')
       .text('OUTFITIFY.CO.UK  ·  MAKING STYLE EFFORTLESS', 0, PH - 15, { width: PW, align: 'center', characterSpacing: 1 });
  }
  function sectionTitle(text, y) {
    doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold')
       .text(text, PAD, y, { characterSpacing: 3 });
    doc.moveTo(PAD, y + 12).lineTo(PAD + IW, y + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
  }
  function lcard(x, y, w, h, accent) {
    doc.rect(x, y, w, h).fill(CARD);
    doc.rect(x, y, 2, h).fill(accent || GREEN);
  }

  // ── PAGE 1: COVER ──
  bg();
  header();
  doc.rect(0, 40, PW, 180).fill('#0E0C0A');
  doc.moveTo(0, 220).lineTo(PW, 220).strokeColor(BORDER).lineWidth(0.5).stroke();

  // Style identity
  const nameParts = (content.styleIdentity.name || '').split(' ');
  doc.fontSize(54).fillColor(WHITE).font('Helvetica-Bold')
     .text((nameParts[0] || '').toUpperCase(), PAD, 58);
  doc.fontSize(54).fillColor(GREEN).font('Helvetica-Bold')
     .text((nameParts.slice(1).join(' ') || '').toUpperCase(), PAD, 112);
  doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique')
     .text(content.styleIdentity.tagline || '', PAD, 178, { width: IW });

  // Intro card
  lcard(PAD, 232, IW, 80, GREEN);
  doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold')
     .text('ABOUT YOUR REPORT', PAD + 14, 242, { characterSpacing: 2 });
  doc.fontSize(10).fillColor(MUTED).font('Helvetica')
     .text(content.styleIdentity.intro || '', PAD + 14, 256, { width: IW - 28, lineGap: 3 });

  // Colour palette
  sectionTitle('YOUR COLOUR PALETTE', 328);
  const sw = 56, swGap = 11;
  (content.colourPalette.colours || []).forEach((hex, i) => {
    const x = PAD + i * (sw + swGap);
    doc.rect(x, 350, sw, sw).fill(hex);
    doc.fontSize(7.5).fillColor(GREY).font('Helvetica')
       .text((content.colourPalette.labels || [])[i] || '', x, 413, { width: sw, align: 'center' });
  });
  doc.fontSize(9.5).fillColor(MUTED).font('Helvetica')
     .text(content.colourPalette.rationale || '', PAD, 432, { width: IW, lineGap: 3 });

  // What's inside
  sectionTitle("WHAT'S INSIDE", 474);
  const insideItems = [
    ['✓', 'Why You\'ve Been Getting It Wrong', 'Your personal style diagnosis'],
    ['✓', 'Your Style DNA', 'Silhouette, fit language, fabrics & colour'],
    ['✓', 'Your Wardrobe Blueprint', '5 priorities, what to buy first & why'],
    ['✓', 'The Looks', '3 outfit examples built around your life'],
  ];
  insideItems.forEach(([icon, title, desc], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const cardW = (IW - 10) / 2;
    const x = PAD + col * (cardW + 10), y = 496 + row * 58;
    doc.rect(x, y, cardW, 50).fill(CARD2);
    doc.fontSize(16).fillColor(GREEN).font('Helvetica-Bold').text(icon, x + 12, y + 16, { width: 20 });
    doc.fontSize(9.5).fillColor(WHITE).font('Helvetica-Bold').text(title, x + 38, y + 10, { width: cardW - 48 });
    doc.fontSize(8).fillColor(GREY).font('Helvetica').text(desc, x + 38, y + 26, { width: cardW - 48 });
  });

  footer();

  // ── PAGE 2: WHY YOU'VE BEEN GETTING IT WRONG ──
  doc.addPage();
  bg();
  header('Why You\'ve Been Getting It Wrong');

  doc.rect(0, 40, PW, 90).fill('#0E0C0A');
  doc.moveTo(0, 130).lineTo(PW, 130).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold')
     .text('WHY YOU\'VE BEEN', PAD, 52);
  doc.fontSize(22).fillColor(GREEN).font('Helvetica-Bold')
     .text('GETTING IT WRONG', PAD, 78);

  // Diagnosis headline
  lcard(PAD, 144, IW, 52, GREEN);
  doc.fontSize(14).fillColor(WHITE).font('Helvetica-Bold')
     .text(content.diagnosis?.headline || '', PAD + 16, 158, { width: IW - 32, lineGap: 2 });

  // Body
  doc.fontSize(10).fillColor(MUTED).font('Helvetica')
     .text(content.diagnosis?.body || '', PAD, 212, { width: IW, lineGap: 4 });

  // The Truth
  const truthY = 212 + doc.heightOfString(content.diagnosis?.body || '', { width: IW, lineGap: 4 }) + 24;
  doc.rect(PAD, truthY, IW, 1).fill(GREEN);
  doc.fontSize(13).fillColor(GREEN).font('Helvetica-Bold')
     .text(content.diagnosis?.theTruth || '', PAD, truthY + 16, { width: IW, lineGap: 3 });

  footer();

  // ── PAGE 3: YOUR STYLE DNA ──
  doc.addPage();
  bg();
  header('Your Style DNA');

  doc.rect(0, 40, PW, 90).fill('#0E0C0A');
  doc.moveTo(0, 130).lineTo(PW, 130).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold').text('YOUR', PAD, 52);
  doc.fontSize(22).fillColor(GREEN).font('Helvetica-Bold').text('STYLE DNA', PAD, 78);

  const dnaItems = [
    ['SILHOUETTE', content.styleDNA?.silhouette || ''],
    ['FIT LANGUAGE', content.styleDNA?.fitLanguage || ''],
    ['FABRICS', content.styleDNA?.fabrics || ''],
    ['COLOUR USAGE', content.styleDNA?.colourUsage || ''],
    ['STOP WEARING', content.styleDNA?.avoid || ''],
  ];

  let dnaY = 144;
  dnaItems.forEach(([label, text]) => {
    const h = Math.max(doc.fontSize(9.5).heightOfString(text, { width: IW - 28, lineGap: 3 }) + 32, 52);
    lcard(PAD, dnaY, IW, h, label === 'STOP WEARING' ? '#C4886A' : GREEN);
    doc.fontSize(6.5).fillColor(label === 'STOP WEARING' ? '#C4886A' : GREEN).font('Helvetica-Bold')
       .text(label, PAD + 14, dnaY + 10, { characterSpacing: 2 });
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica')
       .text(text, PAD + 14, dnaY + 24, { width: IW - 28, lineGap: 3 });
    dnaY += h + 8;
  });

  footer();

  // ── PAGE 4: YOUR WARDROBE BLUEPRINT ──
  doc.addPage();
  bg();
  header('Your Wardrobe Blueprint');

  doc.rect(0, 40, PW, 90).fill('#0E0C0A');
  doc.moveTo(0, 130).lineTo(PW, 130).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold').text('YOUR WARDROBE', PAD, 52);
  doc.fontSize(22).fillColor(GREEN).font('Helvetica-Bold').text('BLUEPRINT', PAD, 78);

  // Strategy headline
  doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique')
     .text(content.wardrobeBlueprint?.headline || '', PAD, 144, { width: IW });

  // 5 priorities
  let bpY = 170;
  (content.wardrobeBlueprint?.priorities || []).forEach((p, i) => {
    const textW = IW - 80;
    const h = Math.max(
      doc.fontSize(9).heightOfString(p.why || '', { width: textW, lineGap: 2 }) +
      doc.fontSize(8).heightOfString(p.howToShop || '', { width: textW, lineGap: 2 }) + 38, 64
    );
    doc.rect(PAD, bpY, IW, h).fill(CARD2);
    doc.rect(PAD, bpY, 2, h).fill(GREEN);

    // Order number
    doc.fontSize(28).fillColor(GREEN).font('Helvetica-Bold')
       .text(`0${p.order}`, PAD + 10, bpY + (h - 28) / 2, { lineBreak: false });

    // Item name
    doc.fontSize(10).fillColor(WHITE).font('Helvetica-Bold')
       .text(p.item || '', PAD + 52, bpY + 10, { width: textW, lineBreak: false });
    // Why
    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
       .text(p.why || '', PAD + 52, bpY + 26, { width: textW, lineGap: 2 });
    // How to shop
    const whyH = doc.fontSize(9).heightOfString(p.why || '', { width: textW, lineGap: 2 });
    doc.fontSize(8).fillColor(GREEN).font('Helvetica-Oblique')
       .text(p.howToShop || '', PAD + 52, bpY + 28 + whyH, { width: textW, lineGap: 2 });

    bpY += h + 6;
  });

  // Never buy again
  const neverY = bpY + 10;
  doc.rect(PAD, neverY, IW, 1).fill('#C4886A');
  doc.fontSize(7).fillColor('#C4886A').font('Helvetica-Bold')
     .text('NEVER BUY AGAIN', PAD, neverY + 10, { characterSpacing: 2 });
  doc.fontSize(9.5).fillColor(MUTED).font('Helvetica')
     .text(content.wardrobeBlueprint?.neverBuyAgain || '', PAD, neverY + 24, { width: IW, lineGap: 3 });

  footer();

  // ── PAGES 5-7: THE LOOKS (3 outfits) ──
  for (let i = 0; i < (content.outfits || []).length; i++) {
    const outfit = content.outfits[i];
    doc.addPage();
    bg();
    header(`The Looks — ${i + 1} of ${content.outfits.length}`);

    // Hero
    const nameText = (outfit.name || '').toUpperCase();
    const prefixStr = `0${i + 1}  `;
    let nameFontSize = 40;
    for (const sz of [40, 34, 28, 22]) {
      doc.fontSize(sz).font('Helvetica-Bold');
      if (doc.widthOfString(prefixStr + nameText) <= IW) { nameFontSize = sz; break; }
      nameFontSize = sz;
    }
    const nameLineH = nameFontSize * 1.2;
    const heroH = 18 + nameLineH + 8 + 14 + 8 + 20 + 10;
    const heroBottom = 40 + heroH;

    doc.rect(0, 40, PW, heroH).fill('#0E0C0A');
    doc.moveTo(0, heroBottom).lineTo(PW, heroBottom).strokeColor(BORDER).lineWidth(0.5).stroke();

    doc.fontSize(nameFontSize).font('Helvetica-Bold');
    doc.fillColor(GREEN).text(prefixStr, PAD, 40 + 18, { continued: true });
    doc.fillColor(WHITE).text(nameText, { lineBreak: false });

    doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique')
       .text(outfit.occasion || '', PAD, 40 + 18 + nameLineH + 8, { width: IW, lineBreak: false });

    // Why it works
    const whyCardTop = heroBottom + 12;
    doc.fontSize(9.5).font('Helvetica');
    const whyH = doc.heightOfString(outfit.whyItWorks || '', { width: IW - 28, lineGap: 3 }) + 28;
    lcard(PAD, whyCardTop, IW, whyH, GREEN);
    doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold')
       .text('WHY THIS WORKS FOR YOU', PAD + 14, whyCardTop + 10, { characterSpacing: 2 });
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica')
       .text(outfit.whyItWorks || '', PAD + 14, whyCardTop + 24, { width: IW - 28, lineGap: 3 });

    // Items
    const itemsLabelY = whyCardTop + whyH + 12;
    doc.fontSize(7).fillColor(GREY).font('Helvetica-Bold')
       .text('THE ITEMS', PAD, itemsLabelY, { characterSpacing: 2 });

    // Fetch images in parallel
    const imageBuffers = await Promise.all((outfit.items || []).map(async item => {
      let imageUrl = null;
      for (const catItems of Object.values(products)) {
        const match = catItems.find(p => p['Item Name'] === item.name);
        if (match) { imageUrl = match['Image URL']; break; }
      }
      if (!imageUrl) return null;
      try {
        const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 5000 });
        return Buffer.from(imgResp.data);
      } catch { return null; }
    }));

    function truncate(str, maxChars) {
      if (!str) return '';
      return str.length > maxChars ? str.slice(0, maxChars - 1).trimEnd() + '\u2026' : str;
    }

    let itemY = itemsLabelY + 14;
    const CARD_H = 72, IMG_W = 60, IMG_PAD = 8;

    for (let itemIdx = 0; itemIdx < (outfit.items || []).length; itemIdx++) {
      const item = outfit.items[itemIdx];
      const imgBuffer = imageBuffers[itemIdx];
      const tx = PAD + IMG_PAD + IMG_W + 10;
      const priceColX = PAD + IW - 82;
      const textW = priceColX - tx - 8;

      doc.rect(PAD, itemY, IW, CARD_H).fill(CARD);
      doc.rect(PAD, itemY, IW, CARD_H).strokeColor(BORDER).lineWidth(0.5).stroke();

      const imgY = itemY + (CARD_H - IMG_W) / 2;
      if (imgBuffer) {
        try {
          doc.save();
          doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).clip();
          doc.image(imgBuffer, PAD + IMG_PAD, imgY, { width: IMG_W, height: IMG_W, cover: [IMG_W, IMG_W] });
          doc.restore();
        } catch { doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).fill(CARD2); }
      } else {
        doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).fill(CARD2);
      }

      let productUrl = item.url || null;
      if (!productUrl) {
        for (const catItems of Object.values(products)) {
          const match = catItems.find(p => p['Item Name'] === item.name);
          if (match && match['Product URL']) { productUrl = match['Product URL']; break; }
        }
      }

      doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold')
         .text((item.category || '').toUpperCase(), tx, itemY + 10, { width: textW, lineBreak: false, characterSpacing: 1.5 });
      doc.fontSize(10).fillColor(productUrl ? GREEN : WHITE).font('Helvetica-Bold')
         .text(truncate(item.name, Math.floor(textW / 6.2)), tx, itemY + 22,
           { width: textW, lineBreak: false, ...(productUrl ? { link: productUrl } : {}) });
      doc.fontSize(8.5).fillColor(GREY).font('Helvetica')
         .text(truncate(item.why, Math.floor(textW / 5.3)), tx, itemY + 38, { width: textW, lineBreak: false });

      if (productUrl) {
        doc.fontSize(16).fillColor(GREEN).font('Helvetica-Bold')
           .text(item.price || '', priceColX, itemY + 14, { width: 80, align: 'right', lineBreak: false, link: productUrl });
      } else {
        doc.fontSize(16).fillColor(GREEN).font('Helvetica-Bold')
           .text(item.price || '', priceColX, itemY + 14, { width: 80, align: 'right', lineBreak: false });
      }
      doc.fontSize(8).fillColor(GREY).font('Helvetica')
         .text(item.brand || '', priceColX, itemY + 37, { width: 80, align: 'right', lineBreak: false });

      itemY += CARD_H + 6;
    }

    // How to wear tip
    doc.fontSize(9.5).font('Helvetica-Oblique');
    const tipH = doc.heightOfString(outfit.howToWear || '', { width: IW - 28, lineGap: 2 }) + 30;
    const tipYRaw = itemY + 10;
    const tipYMax = PH - 28 - 14 - tipH;
    const tipY = Math.min(tipYRaw, tipYMax);
    lcard(PAD, tipY, IW, tipH, '#8C7B6B');
    doc.fontSize(7).fillColor('#8C7B6B').font('Helvetica-Bold')
       .text('HOW TO WEAR IT', PAD + 14, tipY + 10, { characterSpacing: 2 });
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica-Oblique')
       .text(outfit.howToWear || '', PAD + 14, tipY + 24, { width: IW - 28, lineGap: 2 });

    footer();
  }

  // ── PAGE 8: WHERE TO INVEST ──
  doc.addPage();
  bg();
  header('Where To Invest');

  doc.rect(0, 40, PW, 90).fill('#0E0C0A');
  doc.moveTo(0, 130).lineTo(PW, 130).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold').text('WHERE TO', PAD, 52);
  doc.fontSize(22).fillColor(GREEN).font('Helvetica-Bold').text('INVEST', PAD, 78);

  const shopColW = (IW - 12) / 2;
  const shopItems = (content.whereToInvest || []).slice(0, 4);

  // Pre-calculate heights
  const shopHeights = shopItems.map(shop => {
    const whyH = doc.fontSize(9).heightOfString(shop.why || '', { width: shopColW - 28, lineGap: 2 });
    const bestForH = doc.fontSize(8).heightOfString(`Best for: ${shop.bestFor || ''}`, { width: shopColW - 28, lineGap: 2 });
    return Math.max(whyH + bestForH + 80, 100);
  });
  const row0H = Math.max(shopHeights[0] || 0, shopHeights[1] || 0);
  const row1H = Math.max(shopHeights[2] || 0, shopHeights[3] || 0);

  shopItems.forEach((shop, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const sx = PAD + col * (shopColW + 12);
    const rowH = row === 0 ? row0H : row1H;
    const cardY = 144 + (row === 0 ? 0 : row0H + 12);

    doc.rect(sx, cardY, shopColW, rowH).fill(CARD);
    doc.rect(sx, cardY, 2, rowH).fill(GREEN);

    doc.fontSize(32).fillColor(GREEN).font('Helvetica-Bold')
       .text(`0${i + 1}`, sx + 14, cardY + 14, { lineBreak: false });
    doc.fontSize(13).fillColor(WHITE).font('Helvetica-Bold')
       .text(shop.brand || '', sx + 14, cardY + 54, { width: shopColW - 28, lineBreak: false });
    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
       .text(shop.why || '', sx + 14, cardY + 74, { width: shopColW - 28, lineGap: 2 });
    const shopWhyH = doc.fontSize(9).heightOfString(shop.why || '', { width: shopColW - 28, lineGap: 2 });
    doc.fontSize(8).fillColor(GREEN).font('Helvetica-Oblique')
       .text(`Best for: ${shop.bestFor || ''}`, sx + 14, cardY + 76 + shopWhyH, { width: shopColW - 28, lineGap: 2 });
  });

  // CTA pinned to bottom
  const ctaY = PH - 28 - 12 - 44;
  doc.rect(PAD, ctaY, IW, 44).fill(CARD2);
  doc.rect(PAD, ctaY, IW, 44).strokeColor(GREEN).lineWidth(0.5).stroke();
  doc.fontSize(11).fillColor(WHITE).font('Helvetica-Bold')
     .text('Ready to level up further?', PAD, ctaY + 10, { width: IW, align: 'center' });
  doc.fontSize(9).fillColor(GREEN).font('Helvetica')
     .text('Retake the quiz anytime at outfitify.co.uk', PAD, ctaY + 26, { width: IW, align: 'center' });

  footer();
  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(pdfPath));
    stream.on('error', reject);
  });
}

// ════════════════════════════════════════
// Send email via ZeptoMail HTTP API
// ════════════════════════════════════════
async function sendEmail(toEmail, downloadUrl, styleIdentityName) {
  const emailBody = {
    from: { address: 'outfitify@outfitify.co.uk', name: 'Outfitify' },
    to: [{ email_address: { address: toEmail } }],
    subject: `Your ${styleIdentityName} Style Blueprint is Ready`,
    htmlbody: `
      <div style="background:#0A0A0A;padding:0;font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #2A2520">
        <div style="background:#111111;padding:28px 40px;border-bottom:1px solid #2A2520;text-align:center">
          <p style="color:#7A6E66;font-size:10px;letter-spacing:4px;margin:0 0 4px">YOUR PERSONAL STYLE BLUEPRINT</p>
          <h1 style="color:#F2EDE6;font-size:14px;letter-spacing:5px;margin:0;font-weight:600">OUTFITIFY</h1>
        </div>
        <div style="padding:44px 40px">
          <h2 style="color:#F2EDE6;font-size:26px;font-weight:300;margin:0 0 12px;line-height:1.2">Your blueprint is ready.</h2>
          <p style="color:#7A6E66;font-size:14px;line-height:1.7;margin:0 0 32px">
            Your <span style="color:#C8BFB5">${styleIdentityName}</span> personal style blueprint has been generated — your diagnosis, style DNA, wardrobe formula, outfit examples and where to invest, all built specifically around you.
          </p>
          <a href="${downloadUrl}" style="display:block;background:#F2EDE6;color:#0A0A0A;text-align:center;padding:16px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;margin:0 0 32px;text-transform:uppercase">
            DOWNLOAD MY STYLE BLUEPRINT →
          </a>
          <p style="color:#4A4440;font-size:12px;text-align:center;border-top:1px solid #2A2520;padding-top:20px;margin:0">
            This link is unique to you. If you have any issues, reply to this email.
          </p>
        </div>
        <div style="background:#111111;border-top:1px solid #2A2520;padding:16px 40px;text-align:center">
          <p style="color:#4A4440;font-size:10px;letter-spacing:2px;margin:0">OUTFITIFY · MAKING STYLE EFFORTLESS · OUTFITIFY.CO.UK</p>
        </div>
      </div>
    `
  };

  const response = await axios.post('https://api.zeptomail.eu/v1.1/email', emailBody, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': process.env.ZEPTO_SMTP_PASS,
    }
  });

  console.log('Email sent:', response.data);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Outfitify backend running on port ${PORT}`));
