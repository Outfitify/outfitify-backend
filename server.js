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

let activeJobs = 0;

process.on('SIGTERM', () => {
  console.log(`SIGTERM received. Active jobs: ${activeJobs}. Waiting before exit...`);
  const wait = () => {
    if (activeJobs === 0) { console.log('All jobs done, exiting.'); process.exit(0); }
    else { console.log(`Still waiting on ${activeJobs} job(s)...`); setTimeout(wait, 5000); }
  };
  wait();
});

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

// STEP 1 — Save quiz answers (email removed — captured by Stripe at checkout)
app.post('/api/save-session', (req, res) => {
  const { budget, struggles, lifestyle, goal, fit } = req.body;
  if (!budget) return res.status(400).json({ error: 'Missing required fields' });
  const sessionId = crypto.randomBytes(16).toString('hex');
  sessions.set(sessionId, { budget, struggles, lifestyle, goal, fit, createdAt: Date.now() });
  for (const [id, data] of sessions.entries()) {
    if (Date.now() - data.createdAt > 7200000) sessions.delete(id);
  }
  res.json({ sessionId });
});

// STEP 2 — Create Stripe Checkout Session
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
          unit_amount: 1499
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || "https://success.outfitify.co.uk"}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}`,
      cancel_url: `${process.env.UNLOCK_PAGE_URL}?sid=${sessionId}&cancelled=true`,
      metadata: {
        sessionId,
        budget:    quizData.budget    || '',
        struggles: quizData.struggles || '',
        lifestyle: quizData.lifestyle || '',
        goal:      quizData.goal      || '',
        fit:       quizData.fit       || '',
      },
    });
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
});

// STEP 3 — Stripe Webhook
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
    };
    generateAndStoreReport(sessionId, quizData, userEmail).catch(err => {
      console.error(`Unhandled error in generateAndStoreReport for ${sessionId}:`, err);
    });
  }
  res.json({ received: true });
});

// STEP 4 — Poll for PDF readiness
app.get('/api/report-status/:sessionId', (req, res) => {
  const dl = getDownload(req.params.sessionId);
  if (dl) res.json({ ready: true, downloadToken: dl.token });
  else res.json({ ready: false });
});

// STEP 5 — Serve PDF download
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

async function generateAndStoreReport(sessionId, quizData, userEmail) {
  activeJobs++;
  console.log(`Generating report for session ${sessionId}... (active jobs: ${activeJobs})`);
  try {
    const products = await fetchProducts(quizData.budget, quizData.goal);
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

async function fetchProducts(budget, goal) {
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

  function getStyleTags(goal) {
    const g = (goal || '').toLowerCase();
    if (/street|hype|urban|skate|oversized|relaxed.*casual|casual.*relaxed/.test(g)) {
      return { primary: ['Streetwear'], fallback: ['Everyday Fits'] };
    }
    if (/gym|athletic|sport|active|train|workout|performance|fitness/.test(g)) {
      return { primary: ['Active/Gym wear'], fallback: ['Everyday Fits', 'Streetwear'] };
    }
    if (/smart.*casual|business.*casual|work|office|professional|corporate|hybrid/.test(g)) {
      return { primary: ['Smart Casual/Workwear'], fallback: ['Everyday Fits', 'Date Night/Going Out'] };
    }
    if (/old money|quiet luxury|minimal|heritage|classic|preppy|trad/.test(g)) {
      return { primary: ['Smart Casual/Workwear', 'Date Night/Going Out'], fallback: ['Everyday Fits'] };
    }
    if (/date|going out|night out|social|evening|party/.test(g)) {
      return { primary: ['Date Night/Going Out'], fallback: ['Everyday Fits', 'Smart Casual/Workwear'] };
    }
    return { primary: ['Everyday Fits', 'Smart Casual/Workwear'], fallback: ['Streetwear', 'Date Night/Going Out'] };
  }

  const { primary, fallback } = getStyleTags(goal);
  console.log(`[fetchProducts] goal="${goal}" → primary styles: [${primary}], fallback: [${fallback}]`);

  function matchesStyle(p, tags) {
    const s = (p['Style'] || '').trim();
    return tags.some(t => s === t);
  }

  const inBudget = products.filter(p => {
    const price = parseFloat(p['Price']) || 0;
    const active = !p['Status'] || p['Status'].toLowerCase() === 'active';
    return price <= maxPrice && p['Item Name'] && active;
  });

  const allActive = products.filter(p => {
    const active = !p['Status'] || p['Status'].toLowerCase() === 'active';
    return p['Item Name'] && active;
  });

  console.log(`[fetchProducts] budget=£${maxPrice}, in-budget items=${inBudget.length}`);

  const categories = ['Top', 'Bottoms', 'Shoes', 'Hoodie/Jacket'];
  const selected = {};

  categories.forEach(cat => {
    let pool = inBudget.filter(p => p['Category'] === cat && matchesStyle(p, primary));
    if (pool.length < 4) {
      const fallbackItems = inBudget.filter(p =>
        p['Category'] === cat && matchesStyle(p, fallback) &&
        !pool.find(q => q['Item Name'] === p['Item Name'])
      );
      pool = [...pool, ...fallbackItems];
    }
    if (pool.length < 4) {
      const anyStyle = inBudget.filter(p =>
        p['Category'] === cat && !pool.find(q => q['Item Name'] === p['Item Name'])
      );
      pool = [...pool, ...anyStyle];
    }
    if (pool.length < 2) {
      const overBudget = allActive
        .filter(p => p['Category'] === cat && !pool.find(q => q['Item Name'] === p['Item Name']))
        .sort((a, b) => (parseFloat(a['Price']) || 0) - (parseFloat(b['Price']) || 0));
      const needed = Math.max(2 - pool.length, 0);
      const extras = overBudget.slice(0, needed).map(p => ({ ...p, _overBudget: true }));
      pool = [...pool, ...extras];
    }
    selected[cat] = pool.sort(() => Math.random() - 0.5).slice(0, 8);
    console.log(`[fetchProducts] category="${cat}" final pool size: ${selected[cat].length}`);
  });

  return selected;
}

async function generateReportContent(quizData, products) {
  const productSummary = {};
  for (const [cat, items] of Object.entries(products)) {
    productSummary[cat] = items.slice(0, 4).map(p => ({
      name: p['Item Name'],
      brand: p['Brand'],
      price: `£${p['Price']}`,
      url: p['Product URL'],
      ...(p._overBudget ? { note: 'slightly over budget — only option available in this category' } : {})
    }));
  }

  const allAvailableProducts = [];
  for (const [cat, items] of Object.entries(productSummary)) {
    items.forEach(p => allAvailableProducts.push({ ...p, category: cat }));
  }

  const prompt = `You are the Outfitify AI stylist. You write like a senior personal stylist who has worked with hundreds of men — direct, confident, specific and authoritative. You never write generic advice. Every single sentence must be tied to this customer's specific answers.

CUSTOMER PROFILE:
- Budget per item: ${quizData.budget}
- Style struggles (what they selected — address these directly): ${quizData.struggles}
- Lifestyle: ${quizData.lifestyle}
- Style goal and aesthetic direction: ${quizData.goal}
- How clothes fit them: ${quizData.fit}

AVAILABLE PRODUCTS — You MUST only recommend products from this exact list:
${JSON.stringify(allAvailableProducts, null, 2)}

ONE BRAND PER SLOT — do not recommend the same brand twice within the same category.

CRITICAL CONSISTENCY RULES:
FIT NAME CHECK — if style advice says fitted/structured/tailored, SKIP products with: "loose", "boxy", "relaxed", "oversized", "baggy", "wide", "slouch", "regular fit". If relaxed/oversized, SKIP: "slim", "skinny", "fitted", "tapered".
FABRIC CHECK — match fabrics to lifestyle and style DNA advice.
PATTERN AND DETAIL CHECK — if minimal aesthetic, avoid "stripe", "logo", "graphic", "print", "check", "plaid", "pattern".
COLOUR CHECK — only recommend products within the defined palette.
SPORTSWEAR CHECK — no activewear unless customer explicitly mentions gym/sport.
BRAND CHECK — no ultra-fast-fashion brands in quality-focused reports.
OVER-BUDGET CHECK — acknowledge over-budget picks in the "why" field.
FINAL SENSE CHECK — every pick must be consistent with the style DNA and blueprint.

TONE RULES:
- Second person only ("you", "your")
- Never use: "it's important to", "consider", "you might want to", "here are some tips", "great", "amazing", "awesome", "key pieces", "wardrobe staples", "elevate your look", "game changer"
- Never start with "Remember" or "Note that"
- Every sentence must be specific to this customer
- Be direct and authoritative

Generate a style report with exactly this JSON structure (JSON only, no markdown, no preamble):
{
  "styleIdentity": {
    "name": "2-3 word style identity derived from their goal and lifestyle",
    "tagline": "One punchy sentence specific to their goal",
    "intro": "3 sentences. Acknowledge their struggles, name what held them back, tell them what changes."
  },
  "colourPalette": {
    "colours": ["#hex1", "#hex2", "#hex3", "#hex4", "#hex5"],
    "labels": ["name1", "name2", "name3", "name4", "name5"],
    "rationale": "2 sentences. Why these colours, how to use them together."
  },
  "diagnosis": {
    "headline": "One direct punchy headline — make it feel like a revelation",
    "body": "4-5 sentences addressing their specific struggles. Root cause not symptom.",
    "theTruth": "One bold statement that reframes their style problem."
  },
  "styleDNA": {
    "silhouette": "Specific silhouette advice based on their fit answer",
    "fitLanguage": "Exact fit vocabulary to use when shopping",
    "fabrics": "Fabrics for their specific lifestyle",
    "colourUsage": "How to use the palette day to day — ratios and combinations",
    "avoid": "What to stop wearing immediately and exactly why"
  },
  "wardrobeBlueprint": {
    "headline": "One sentence framing their wardrobe strategy",
    "priorities": [
      { "order": 1, "item": "item", "why": "why", "howToShop": "guidance" },
      { "order": 2, "item": "item", "why": "why", "howToShop": "guidance" },
      { "order": 3, "item": "item", "why": "why", "howToShop": "guidance" },
      { "order": 4, "item": "item", "why": "why", "howToShop": "guidance" },
      { "order": 5, "item": "item", "why": "why", "howToShop": "guidance" }
    ],
    "neverBuyAgain": "2-3 specific things to stop buying and exactly why",
    "costPerWear": "One insight about spending for their exact budget level"
  },
  "recommendedPieces": [
    {
      "category": "Top/Bottoms/Shoes/Hoodie/Jacket",
      "name": "exact product name from available products list",
      "brand": "brand name",
      "price": "£XX",
      "url": "exact product url from available products list",
      "why": "One sentence — specific fit, fabric or detail that makes it right for them"
    }
  ],
  "whereToInvest": [
    {
      "brand": "Brand name",
      "why": "One specific sentence on why this brand suits their goal and budget",
      "bestFor": "Specific product type this brand does best for their style direction"
    }
  ]
}

Rules:
- wardrobeBlueprint.priorities must contain exactly 5 items
- recommendedPieces: 6-9 pieces, targeting 3 tops, 2 bottoms, 2 shoes, 2 layers. Quality over quantity.
- whereToInvest: exactly 4 brands, UK-accessible only
- JSON only, no markdown, no preamble`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = message.content[0].text.trim();
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(text);

  console.log('=== CLAUDE OUTPUT ===');
  console.log(JSON.stringify(parsed, null, 2));
  console.log('=== END OUTPUT ===');

  return parsed;
}

async function buildPDF(content, quizData, products) {
  const pdfPath = path.join(os.tmpdir(), `outfitify-${Date.now()}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  const BG = '#0A0A0A', HEADER = '#111111', BORDER = '#2A2520', GREEN = '#B8A898';
  const WHITE = '#F2EDE6', GREY = '#7A6E66', MUTED = '#C8BFB5';
  const CARD = '#141210', CARD2 = '#1C1916', RED = '#C4886A';
  const PW = 595, PH = 842, PAD = 50, IW = 495;

  function truncateToFit(str, maxWidth, fontSize, fontName, maxLines) {
    if (!str) return '';
    doc.fontSize(fontSize).font(fontName || 'Helvetica');
    const maxH = maxLines * fontSize * 1.2;
    if (doc.heightOfString(str, { width: maxWidth }) <= maxH) return str;
    const words = str.split(' ');
    let lo = 1, hi = words.length, best = words[0];
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = words.slice(0, mid).join(' ') + '\u2026';
      if (doc.heightOfString(candidate, { width: maxWidth }) <= maxH) { best = candidate; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  function bg() { doc.rect(0, 0, PW, PH).fill(BG); }
  function pageHeader(sub) {
    doc.rect(0, 0, PW, 36).fill(HEADER);
    doc.rect(0, 35, PW, 1).fill(BORDER);
    doc.fontSize(8).fillColor(WHITE).font('Helvetica-Bold').text('OUTFITIFY', 0, 11, { width: PW, align: 'center', characterSpacing: 6 });
    if (sub) doc.fontSize(6.5).fillColor(GREY).font('Helvetica').text(sub.toUpperCase(), 0, 22, { width: PW, align: 'center', characterSpacing: 2 });
  }
  function footer() {
    doc.rect(0, PH - 28, PW, 28).fill(HEADER);
    doc.rect(0, PH - 28, PW, 1).fill(BORDER);
    doc.fontSize(7).fillColor(GREY).font('Helvetica').text('OUTFITIFY.CO.UK  ·  MAKING STYLE EFFORTLESS', 0, PH - 15, { width: PW, align: 'center', characterSpacing: 1 });
  }
  function sectionLabel(text, y) {
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold').text(text, PAD, y, { characterSpacing: 3 });
    doc.moveTo(PAD, y + 12).lineTo(PAD + IW, y + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
  }
  function lcard(x, y, w, h, accent) {
    doc.rect(x, y, w, h).fill(CARD);
    doc.rect(x, y, 2, h).fill(accent || GREEN);
  }
  function textH(str, fontSize, fontName, width) {
    doc.fontSize(fontSize).font(fontName || 'Helvetica');
    return doc.heightOfString(str || '', { width, lineGap: 2 });
  }
  function heroBlock(line1, line2, sub) {
    doc.rect(0, 40, PW, 90).fill('#0E0C0A');
    doc.moveTo(0, 130).lineTo(PW, 130).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.fontSize(24).fillColor(WHITE).font('Helvetica-Bold').text(line1, PAD, 52);
    doc.fontSize(24).fillColor(GREEN).font('Helvetica-Bold').text(line2, PAD, 80);
    if (sub) doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique').text(sub, PAD, 118, { width: IW });
  }

  // PAGE 1
  bg();
  doc.rect(0, 40, PW, 200).fill('#0E0C0A');
  doc.moveTo(0, 240).lineTo(PW, 240).strokeColor(BORDER).lineWidth(0.5).stroke();
  pageHeader();
  const nameParts = (content.styleIdentity?.name || 'YOUR STYLE').split(' ');
  doc.fontSize(54).fillColor(WHITE).font('Helvetica-Bold').text((nameParts[0] || '').toUpperCase(), PAD, 60);
  doc.fontSize(54).fillColor(GREEN).font('Helvetica-Bold').text((nameParts.slice(1).join(' ') || '').toUpperCase(), PAD, 118);
  doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique').text(content.styleIdentity?.tagline || '', PAD, 194, { width: IW });
  const introText = content.styleIdentity?.intro || '';
  const introH = Math.max(textH(introText, 10, 'Helvetica', IW - 28) + 36, 88);
  lcard(PAD, 256, IW, introH, GREEN);
  doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold').text('ABOUT YOUR REPORT', PAD + 14, 266, { characterSpacing: 2 });
  doc.fontSize(10).fillColor(MUTED).font('Helvetica').text(introText, PAD + 14, 282, { width: IW - 28, lineGap: 3 });
  const paletteY = 256 + introH + 20;
  sectionLabel('YOUR COLOUR PALETTE', paletteY);
  const sw = 58, swGap = 10, swatchY = paletteY + 20;
  (content.colourPalette?.colours || []).forEach((hex, i) => {
    const x = PAD + i * (sw + swGap);
    doc.rect(x, swatchY, sw, sw).fill(hex);
    doc.fontSize(7.5).fillColor(GREY).font('Helvetica').text((content.colourPalette?.labels || [])[i] || '', x, swatchY + sw + 6, { width: sw, align: 'center' });
  });
  const rationaleY = swatchY + sw + 22;
  doc.fontSize(9.5).fillColor(MUTED).font('Helvetica').text(content.colourPalette?.rationale || '', PAD, rationaleY, { width: IW, lineGap: 3 });
  const rationaleH = textH(content.colourPalette?.rationale || '', 9.5, 'Helvetica', IW);
  const insideY = rationaleY + rationaleH + 24;
  sectionLabel("WHAT'S INSIDE", insideY);
  [["Why You've Been Getting It Wrong", 'Your personal style diagnosis'], ['Your Style DNA', 'Silhouette, fit, fabrics & colour'], ['Your Wardrobe Blueprint', '5 priorities & what to buy first'], ['Recommended Pieces', 'Hand-picked for your style & budget']].forEach(([title, desc], i) => {
    const col = i % 2, row = Math.floor(i / 2), cardW = (IW - 10) / 2;
    const x = PAD + col * (cardW + 10), y = insideY + 18 + row * 54;
    doc.rect(x, y, cardW, 46).fill(CARD2);
    doc.rect(x, y, 2, 46).fill(GREEN);
    doc.fontSize(9.5).fillColor(WHITE).font('Helvetica-Bold').text(title, x + 14, y + 8, { width: cardW - 24 });
    doc.fontSize(8).fillColor(GREY).font('Helvetica').text(desc, x + 14, y + 26, { width: cardW - 24 });
  });
  footer();

  // PAGE 2
  doc.addPage(); bg(); pageHeader("Why You've Been Getting It Wrong");
  heroBlock("WHY YOU'VE BEEN", "GETTING IT WRONG");
  lcard(PAD, 144, IW, 52, GREEN);
  doc.fontSize(13).fillColor(WHITE).font('Helvetica-Bold').text(content.diagnosis?.headline || '', PAD + 16, 158, { width: IW - 32, lineGap: 2 });
  const diagBodyH = textH(content.diagnosis?.body || '', 10.5, 'Helvetica', IW) + 8;
  doc.fontSize(10.5).fillColor(MUTED).font('Helvetica').text(content.diagnosis?.body || '', PAD, 212, { width: IW, lineGap: 4 });
  const truthY = 220 + diagBodyH;
  doc.rect(PAD, truthY, IW, 1).fill(GREEN);
  doc.fontSize(13).fillColor(GREEN).font('Helvetica-Bold').text(content.diagnosis?.theTruth || '', PAD, truthY + 16, { width: IW, lineGap: 3 });
  footer();

  // PAGE 3
  doc.addPage(); bg(); pageHeader('Your Style DNA');
  heroBlock('YOUR', 'STYLE DNA');
  let dnaY = 144;
  [['SILHOUETTE', content.styleDNA?.silhouette || '', GREEN], ['FIT LANGUAGE', content.styleDNA?.fitLanguage || '', GREEN], ['FABRICS', content.styleDNA?.fabrics || '', GREEN], ['COLOUR USAGE', content.styleDNA?.colourUsage || '', GREEN], ['STOP WEARING', content.styleDNA?.avoid || '', RED]].forEach(([label, text, accent]) => {
    const h = Math.max(textH(text, 9.5, 'Helvetica', IW - 28) + 32, 52);
    if (dnaY + h > PH - 40) return;
    lcard(PAD, dnaY, IW, h, accent);
    doc.fontSize(6.5).fillColor(accent).font('Helvetica-Bold').text(label, PAD + 14, dnaY + 10, { characterSpacing: 2 });
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica').text(text, PAD + 14, dnaY + 24, { width: IW - 28, lineGap: 3 });
    dnaY += h + 8;
  });
  footer();

  // PAGE 4
  doc.addPage(); bg(); pageHeader('Your Wardrobe Blueprint');
  heroBlock('YOUR WARDROBE', 'BLUEPRINT');
  doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique').text(content.wardrobeBlueprint?.headline || '', PAD, 144, { width: IW });
  let bpY = 168;
  (content.wardrobeBlueprint?.priorities || []).forEach((p) => {
    const textW = IW - 72;
    const whyH = textH(p.why || '', 9, 'Helvetica', textW);
    const shopH = textH(p.howToShop || '', 8, 'Helvetica-Oblique', textW);
    const h = Math.max(whyH + shopH + 36, 60);
    if (bpY + h > PH - 80) return;
    doc.rect(PAD, bpY, IW, h).fill(CARD2);
    doc.rect(PAD, bpY, 2, h).fill(GREEN);
    doc.fontSize(24).fillColor(GREEN).font('Helvetica-Bold').text(`0${p.order}`, PAD + 10, bpY + (h - 24) / 2, { lineBreak: false });
    doc.fontSize(10).fillColor(WHITE).font('Helvetica-Bold').text(p.item || '', PAD + 52, bpY + 10, { width: textW, lineBreak: false });
    doc.fontSize(9).fillColor(MUTED).font('Helvetica').text(p.why || '', PAD + 52, bpY + 26, { width: textW, lineGap: 2 });
    doc.fontSize(8).fillColor(GREEN).font('Helvetica-Oblique').text(p.howToShop || '', PAD + 52, bpY + 28 + whyH, { width: textW, lineGap: 2 });
    bpY += h + 5;
  });
  const neverY = Math.min(bpY + 8, PH - 100);
  doc.rect(PAD, neverY, IW, 1).fill(RED);
  doc.fontSize(7).fillColor(RED).font('Helvetica-Bold').text('NEVER BUY AGAIN', PAD, neverY + 10, { characterSpacing: 2 });
  doc.fontSize(9.5).fillColor(MUTED).font('Helvetica').text(content.wardrobeBlueprint?.neverBuyAgain || '', PAD, neverY + 24, { width: IW, lineGap: 3 });
  footer();

  // PAGE 5
  doc.addPage(); bg();
  const pieces = (content.recommendedPieces || []).slice(0, 9);
  pageHeader('Your Recommended Pieces');
  heroBlock(`${pieces.length} PIECES BUILT`, 'AROUND YOU', 'Hand-picked from our database to match your style DNA and budget');
  const imageBuffers = await Promise.all(pieces.map(async piece => {
    let imageUrl = null;
    for (const catItems of Object.values(products)) {
      const match = catItems.find(p => p['Item Name'] === piece.name);
      if (match) { imageUrl = match['Image URL']; break; }
    }
    if (!imageUrl) return null;
    try { const r = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 5000 }); return Buffer.from(r.data); } catch { return null; }
  }));
  const CARD_H = 70, IMG_W = 64, IMG_PAD = 8;
  let pieceY = 148;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (pieceY + CARD_H > PH - 36) break;
    const tx = PAD + IMG_PAD + IMG_W + 12, priceColX = PAD + IW - 88, textW = priceColX - tx - 8;
    doc.rect(PAD, pieceY, IW, CARD_H).fill(CARD);
    doc.rect(PAD, pieceY, IW, CARD_H).strokeColor(BORDER).lineWidth(0.5).stroke();
    const imgY = pieceY + (CARD_H - IMG_W) / 2;
    if (imageBuffers[i]) {
      try { doc.save(); doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).clip(); doc.image(imageBuffers[i], PAD + IMG_PAD, imgY, { width: IMG_W, height: IMG_W, cover: [IMG_W, IMG_W] }); doc.restore(); }
      catch { doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).fill(CARD2); }
    } else { doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).fill(CARD2); }
    let productUrl = piece.url || null;
    if (!productUrl) { for (const catItems of Object.values(products)) { const match = catItems.find(p => p['Item Name'] === piece.name); if (match?.['Product URL']) { productUrl = match['Product URL']; break; } } }
    doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold').text((piece.category || '').toUpperCase(), tx, pieceY + 8, { width: textW, lineBreak: false, characterSpacing: 1.5 });
    const nameStr = truncateToFit(piece.name || '', textW, 10, 'Helvetica-Bold', 1);
    doc.fontSize(10).fillColor(productUrl ? GREEN : WHITE).font('Helvetica-Bold').text(nameStr, tx, pieceY + 20, { width: textW, lineBreak: false, ...(productUrl ? { link: productUrl, underline: true } : {}) });
    doc.fontSize(8.5).fillColor(GREY).font('Helvetica').text(truncateToFit(piece.why || '', textW, 8.5, 'Helvetica', 2), tx, pieceY + 36, { width: textW, lineGap: 1.5 });
    doc.fontSize(15).fillColor(GREEN).font('Helvetica-Bold').text(piece.price || '', priceColX, pieceY + 12, { width: 86, align: 'right', lineBreak: false, ...(productUrl ? { link: productUrl } : {}) });
    doc.fontSize(8).fillColor(GREY).font('Helvetica').text(piece.brand || '', priceColX, pieceY + 34, { width: 86, align: 'right', lineBreak: false });
    pieceY += CARD_H + 3;
  }
  footer();

  // PAGE 6
  doc.addPage(); bg(); pageHeader('Where To Invest');
  heroBlock('WHERE TO', 'INVEST', 'Brands suited to your goal and budget');
  const shopItems = (content.whereToInvest || []).slice(0, 4);
  const shopColW = (IW - 12) / 2;
  const shopHeights = shopItems.map(s => Math.max(textH(s.why || '', 9, 'Helvetica', shopColW - 28) + textH(`Best for: ${s.bestFor || ''}`, 8, 'Helvetica-Oblique', shopColW - 28) + 80, 100));
  const row0H = Math.max(shopHeights[0] || 100, shopHeights[1] || 100);
  const row1H = Math.max(shopHeights[2] || 100, shopHeights[3] || 100);
  shopItems.forEach((shop, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const sx = PAD + col * (shopColW + 12), rowH = row === 0 ? row0H : row1H;
    const cardY = 144 + (row === 0 ? 0 : row0H + 12);
    doc.rect(sx, cardY, shopColW, rowH).fill(CARD);
    doc.rect(sx, cardY, 2, rowH).fill(GREEN);
    doc.fontSize(30).fillColor(GREEN).font('Helvetica-Bold').text(`0${i + 1}`, sx + 14, cardY + 14, { lineBreak: false });
    doc.fontSize(13).fillColor(WHITE).font('Helvetica-Bold').text(shop.brand || '', sx + 14, cardY + 52, { width: shopColW - 28, lineBreak: false });
    doc.fontSize(9).fillColor(MUTED).font('Helvetica').text(shop.why || '', sx + 14, cardY + 72, { width: shopColW - 28, lineGap: 2 });
    const shopWhyH = textH(shop.why || '', 9, 'Helvetica', shopColW - 28);
    doc.fontSize(8).fillColor(GREEN).font('Helvetica-Oblique').text(`Best for: ${shop.bestFor || ''}`, sx + 14, cardY + 74 + shopWhyH, { width: shopColW - 28, lineGap: 2 });
  });
  const ctaY = PH - 28 - 12 - 56;
  doc.rect(PAD, ctaY, IW, 56).fill(CARD2);
  doc.rect(PAD, ctaY, IW, 56).strokeColor(GREEN).lineWidth(0.5).stroke();
  doc.rect(PAD, ctaY, 2, 56).fill(GREEN);
  doc.fontSize(11).fillColor(WHITE).font('Helvetica-Bold').text('Know someone who needs this?', PAD + 16, ctaY + 12, { width: IW - 32 });
  doc.fontSize(9).fillColor(MUTED).font('Helvetica').text('Share outfitify.co.uk — every report is built fresh, personalised to whoever takes the quiz.', PAD + 16, ctaY + 30, { width: IW - 32 });
  footer();
  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(pdfPath));
    stream.on('error', reject);
  });
}

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
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': process.env.ZEPTO_SMTP_PASS }
  });
  console.log('Email sent:', response.data);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Outfitify backend running on port ${PORT}`));
