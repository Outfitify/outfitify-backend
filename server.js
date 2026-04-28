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

const FREE_SESSIONS_DIR = path.join(os.tmpdir(), 'outfitify-free-sessions');
if (!fs.existsSync(FREE_SESSIONS_DIR)) fs.mkdirSync(FREE_SESSIONS_DIR, { recursive: true });

function saveFreeSession(sessionId, data) {
  fs.writeFileSync(path.join(FREE_SESSIONS_DIR, `${sessionId}.json`), JSON.stringify(data));
}
function getFreeSession(sessionId) {
  const p = path.join(FREE_SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Date.now() - data.createdAt > 604800000) { fs.unlinkSync(p); return null; }
    return data;
  } catch { return null; }
}

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

async function addToMailchimp(email, quizData, tier = 'free') {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  const server = process.env.MAILCHIMP_SERVER || 'us18';

  if (!apiKey || !audienceId) { console.log('Mailchimp not configured — skipping'); return; }

  const tag = tier === 'premium' ? 'premium-customer' : tier === 'standard' ? 'standard-customer' : 'free-tier';

  try {
    const response = await axios.post(
      `https://${server}.api.mailchimp.com/3.0/lists/${audienceId}/members`,
      {
        email_address: email,
        status: 'subscribed',
        merge_fields: { BUDGET: quizData.budget || '', LIFESTYLE: quizData.lifestyle || '', GOAL: quizData.goal || '', FIT: quizData.fit || '' },
        tags: [tag],
      },
      { auth: { username: 'anystring', password: apiKey }, headers: { 'Content-Type': 'application/json' }, validateStatus: (s) => s < 500 }
    );
    if (response.status === 200 || response.status === 204) {
      console.log(`Mailchimp: added ${email} with tag [${tag}]`);
    } else if (response.data?.title === 'Member Exists') {
      console.log(`Mailchimp: ${email} already subscribed — updating tag to [${tag}]`);
      const emailHash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
      await axios.post(
        `https://${server}.api.mailchimp.com/3.0/lists/${audienceId}/members/${emailHash}/tags`,
        { tags: [{ name: tag, status: 'active' }] },
        { auth: { username: 'anystring', password: apiKey } }
      );
    } else {
      console.error(`Mailchimp error: ${response.status}`, response.data?.detail || response.data?.title);
    }
  } catch (err) { console.error('Mailchimp request failed:', err.message); }
}

app.post('/api/free-report', async (req, res) => {
  const { budget, struggles, lifestyle, goal, fit, email } = req.body;
  if (!budget || !email) return res.status(400).json({ error: 'Missing required fields' });
  const sessionId = crypto.randomBytes(16).toString('hex');
  const quizData = { budget, struggles, lifestyle, goal, fit };
  saveFreeSession(sessionId, { ...quizData, email, createdAt: Date.now() });
  res.json({ success: true, sessionId });
  addToMailchimp(email, quizData).catch(err => console.error('Mailchimp failed:', err));
  generateAndStoreReport(sessionId, quizData, email, 'free').catch(err => {
    console.error(`Free report generation failed for ${sessionId}:`, err);
  });
});

app.post('/api/create-checkout', async (req, res) => {
  const { sessionId, tier } = req.body;
  const resolvedTier = tier || 'standard';
  console.log(`Creating ${resolvedTier} checkout for session ${sessionId}`);
  const quizData = sessions.get(sessionId) || getFreeSession(sessionId);
  if (!quizData) return res.status(400).json({ error: 'Session not found or expired' });

  const tierConfig = {
    standard: { amount: 499, name: 'Outfitify Personal Style Blueprint — Standard' },
    premium:  { amount: 999, name: 'Outfitify Personal Style Blueprint — Premium' },
  };
  const config = tierConfig[resolvedTier] || tierConfig.standard;

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_creation: 'always',
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: config.name,
            description: 'Your personalised style diagnosis, blueprint, wardrobe formula and outfit examples — built around you.',
            images: ['https://outfitify.co.uk/assets/images/image04.png']
          },
          unit_amount: config.amount
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || "https://success.outfitify.co.uk"}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}`,
      cancel_url: `${process.env.UNLOCK_PAGE_URL || "https://quiz.outfitify.co.uk"}?cancelled=true`,
      metadata: {
        sessionId, tier: resolvedTier,
        budget: quizData.budget || '', struggles: quizData.struggles || '',
        lifestyle: quizData.lifestyle || '', goal: quizData.goal || '', fit: quizData.fit || '',
      },
    });
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
});

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
    const userEmail = session.customer_email || session.customer_details?.email || session.metadata.email || null;
    console.log(`Webhook received for session ${sessionId}, email: ${userEmail}`);
    if (!userEmail) console.error(`No email found for session ${sessionId} — cannot send report`);
    const quizData = {
      budget: session.metadata.budget, struggles: session.metadata.struggles,
      lifestyle: session.metadata.lifestyle, goal: session.metadata.goal, fit: session.metadata.fit,
    };
    const tier = session.metadata.tier || 'standard';
    generateAndStoreReport(sessionId, quizData, userEmail, tier).catch(err => {
      console.error(`Unhandled error in generateAndStoreReport for ${sessionId}:`, err);
    });
  }
  res.json({ received: true });
});

app.get('/api/report-status/:sessionId', (req, res) => {
  const dl = getDownload(req.params.sessionId);
  if (dl) res.json({ ready: true, downloadToken: dl.token });
  else res.json({ ready: false });
});

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

app.get('/api/upgrade-to-premium/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const dl = getDownload(sessionId);
  const quizData = dl?.quizData || sessions.get(sessionId) || getFreeSession(sessionId);
  if (!quizData) {
    console.log(`Upgrade attempt for expired session ${sessionId}`);
    return res.redirect('https://quiz.outfitify.co.uk?msg=session_expired');
  }
  try {
    console.log(`Creating direct premium upgrade checkout for session ${sessionId}`);
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_creation: 'always',
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: 'Outfitify Personal Style Blueprint — Premium',
            description: 'Complete style system: 9 product picks, brand guide, never buy again list, and cost per wear insight.',
            images: ['https://outfitify.co.uk/assets/images/image04.png']
          },
          unit_amount: 999
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || 'https://success.outfitify.co.uk'}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}`,
      cancel_url: `https://unlock.outfitify.co.uk?sid=${sessionId}&cancelled=true`,
      metadata: {
        sessionId, tier: 'premium',
        budget: quizData.budget || '', struggles: quizData.struggles || '',
        lifestyle: quizData.lifestyle || '', goal: quizData.goal || '', fit: quizData.fit || '',
      },
    });
    res.redirect(checkoutSession.url);
  } catch (err) {
    console.error('Upgrade checkout error:', err);
    res.redirect(`https://unlock.outfitify.co.uk?sid=${sessionId}`);
  }
});

async function generateAndStoreReport(sessionId, quizData, userEmail, tier = 'standard') {
  activeJobs++;
  console.log(`Generating ${tier} report for session ${sessionId}... (active jobs: ${activeJobs})`);
  const existingPath = downloadsPath(sessionId);
  if (fs.existsSync(existingPath)) {
    fs.unlinkSync(existingPath);
    console.log(`Cleared existing download record for session ${sessionId} (upgrade flow)`);
  }
  try {
    const products = await fetchProducts(quizData.budget, quizData.goal);
    const reportContent = await generateReportContent(quizData, products, tier);
    const pdfPath = await buildPDF(reportContent, quizData, products, tier);
    const token = crypto.randomBytes(32).toString('hex');
    saveDownload(sessionId, { token, pdfPath, email: userEmail, quizData, tier, createdAt: Date.now() });
    const downloadUrl = `${process.env.BASE_URL}/api/download/${token}`;
    await sendEmail(userEmail, downloadUrl, reportContent.styleIdentity.name, tier, sessionId);
    if (userEmail && (tier === 'standard' || tier === 'premium')) {
      addToMailchimp(userEmail, quizData, tier).catch(err => console.error('Mailchimp paid tag failed:', err));
    }
    console.log(`${tier} report ready for session ${sessionId}`);
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
    if (/smart\s*casual|business\s*casual|work|office|professional|corporate|hybrid/.test(g)) {
      return { primary: ['Smart Casual/Workwear'], fallback: ['Everyday Fits', 'Date Night/Going Out'] };
    }
    if (/old money|quiet luxury|minimal|heritage|classic|preppy|trad/.test(g)) {
      return { primary: ['Smart Casual/Workwear', 'Date Night/Going Out'], fallback: ['Everyday Fits'] };
    }
    if (/street|hype|urban|skate|oversized|effortlessly cool/.test(g)) {
      return { primary: ['Streetwear'], fallback: ['Everyday Fits'] };
    }
    if (/gym|athletic|sport|active|train|workout|performance|fitness/.test(g)) {
      return { primary: ['Active/Gym wear'], fallback: ['Everyday Fits', 'Streetwear'] };
    }
    if (/date|going out|night out|social|evening|party/.test(g)) {
      return { primary: ['Date Night/Going Out'], fallback: ['Everyday Fits', 'Smart Casual/Workwear'] };
    }
    if (/sharp|edge|relaxed/.test(g)) {
      return { primary: ['Smart Casual/Workwear', 'Everyday Fits'], fallback: ['Date Night/Going Out'] };
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
        p['Category'] === cat && matchesStyle(p, fallback) && !pool.find(q => q['Item Name'] === p['Item Name'])
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

async function generateReportContent(quizData, products, tier = 'standard') {
  const productSummary = {};
  for (const [cat, items] of Object.entries(products)) {
    productSummary[cat] = items.slice(0, 4).map(p => ({
      name: p['Item Name'], brand: p['Brand'], price: `£${p['Price']}`, url: p['Product URL'],
      ...(p._overBudget ? { note: 'slightly over budget — only option available in this category' } : {})
    }));
  }

  const allAvailableProducts = [];
  for (const [cat, items] of Object.entries(productSummary)) {
    items.forEach(p => allAvailableProducts.push({ ...p, category: cat }));
  }

  const tierInstructions = {
    free: `
REPORT TIER: FREE
Generate a basic style starter report. Keep it simple and surface-level — enough to make the customer feel understood but not enough to fully solve their problem. This creates desire to upgrade.
- styleIdentity: name and tagline only — make it compelling so they want the full report
- colourPalette: exactly 3 colours, no rationale text (leave rationale as empty string "")
- diagnosis: headline only + 2-sentence body — identify the problem but don't solve it. Leave theTruth as empty string ""
- styleDNA: leave ALL fields as empty strings — not included in free tier
- wardrobeBlueprint: leave headline and ALL priorities as empty/null — not included in free tier. Leave neverBuyAgain and costPerWear as empty strings
- recommendedPieces: exactly 2 items. NO url (set to ""), NO brand (set to ""), NO price (set to ""). Name should be a generic description only e.g. "A fitted white crew neck t-shirt in breathable cotton" — do NOT use actual product names from the list
- whereToInvest: empty array []`,
    standard: `
REPORT TIER: STANDARD
Generate the full report EXCEPT whereToInvest. Include everything else at full detail.
- recommendedPieces: exactly 5 items with full brand, price and URL from the product list
- whereToInvest: empty array [] — not included in standard tier
- All other sections: full detail as normal`,
    premium: `
REPORT TIER: PREMIUM
Generate the complete full report with everything included at maximum detail.
- recommendedPieces: between 7 and 9 items with full brand, price and URL
- whereToInvest: exactly 4 brands — full detail
- wardrobeBlueprint: include neverBuyAgain and costPerWear at full detail
- All sections: maximum depth and specificity`,
  };

  const prompt = `You are the Outfitify AI stylist. You write like a senior personal stylist who has worked with hundreds of men — direct, confident, specific and authoritative. You never write generic advice. Every single sentence must be tied to this customer's specific answers.

${tierInstructions[tier] || tierInstructions.standard}

CUSTOMER PROFILE:
- Budget per item: ${quizData.budget}
- Style struggles (what they selected — address these directly): ${quizData.struggles}
- Lifestyle: ${quizData.lifestyle}
- Style goal and aesthetic direction: ${quizData.goal}
- How clothes fit them: ${quizData.fit}

AVAILABLE PRODUCTS — You MUST only recommend products from this exact list (for paid tiers):
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
  "styleIdentity": { "name": "2-3 word style identity", "tagline": "One punchy sentence", "intro": "3 sentences." },
  "colourPalette": { "colours": ["#hex1","#hex2","#hex3","#hex4","#hex5"], "labels": ["name1","name2","name3","name4","name5"], "rationale": "2 sentences." },
  "diagnosis": { "headline": "One direct punchy headline", "body": "4-5 sentences.", "theTruth": "One bold statement." },
  "styleDNA": { "silhouette": "...", "fitLanguage": "...", "fabrics": "...", "colourUsage": "...", "avoid": "..." },
  "wardrobeBlueprint": {
    "headline": "One sentence",
    "priorities": [
      { "order": 1, "item": "item", "why": "why", "howToShop": "guidance" },
      { "order": 2, "item": "item", "why": "why", "howToShop": "guidance" },
      { "order": 3, "item": "item", "why": "why", "howToShop": "guidance" },
      { "order": 4, "item": "item", "why": "why", "howToShop": "guidance" },
      { "order": 5, "item": "item", "why": "why", "howToShop": "guidance" }
    ],
    "neverBuyAgain": "2-3 specific things",
    "costPerWear": "One insight"
  },
  "recommendedPieces": [
    { "category": "Top/Bottoms/Shoes/Hoodie/Jacket", "name": "exact product name", "brand": "brand", "price": "£XX", "url": "exact url", "why": "One sentence" }
  ],
  "whereToInvest": [
    { "brand": "Brand", "why": "One sentence", "bestFor": "Specific product type" }
  ]
}

Rules:
- wardrobeBlueprint.priorities must contain exactly 5 items
- recommendedPieces: 6-9 pieces for paid tiers. Quality over quantity.
- whereToInvest: exactly 4 brands, UK-accessible only
- JSON only, no markdown, no preamble`;

  let parsed = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = message.content[0].text.trim();
      const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(text);
      console.log(`=== CLAUDE OUTPUT (attempt ${attempt}) ===`);
      console.log(JSON.stringify(parsed, null, 2));
      console.log('=== END OUTPUT ===');
      break;
    } catch (err) {
      lastError = err;
      console.error(`Claude JSON parse failed on attempt ${attempt}:`, err.message);
      if (attempt < 3) console.log('Retrying...');
    }
  }

  if (!parsed) throw new Error(`Claude failed to return valid JSON after 3 attempts: ${lastError?.message}`);
  return parsed;
}

async function buildPDF(content, quizData, products, tier = 'standard') {
  const pdfPath = path.join(os.tmpdir(), `outfitify-${Date.now()}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  const BG = '#0A0A0A', HEADER = '#111111', BORDER = '#2A2520', GREEN = '#B8A898';
  const WHITE = '#F2EDE6', GREY = '#7A6E66', MUTED = '#C8BFB5';
  const CARD = '#141210', CARD2 = '#1C1916', RED = '#C4886A';
  const PW = 595, PH = 842, PAD = 50, IW = 495;

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
  function lcard(x, y, w, h, accent) {
    doc.rect(x, y, w, h).fill(CARD);
    doc.rect(x, y, 2, h).fill(accent || GREEN);
  }
  function textH(str, fontSize, fontName, width) {
    doc.fontSize(fontSize).font(fontName || 'Helvetica');
    return doc.heightOfString(str || '', { width, lineGap: 2 });
  }

  if (tier === 'free') {
    bg();
    doc.rect(0, 40, PW, 200).fill('#0E0C0A');
    doc.moveTo(0, 240).lineTo(PW, 240).strokeColor(BORDER).lineWidth(0.5).stroke();
    pageHeader('Your Free Style Starter');
    const nameParts = (content.styleIdentity?.name || 'YOUR STYLE').split(' ');
    doc.fontSize(54).fillColor(WHITE).font('Helvetica-Bold').text((nameParts[0] || '').toUpperCase(), PAD, 60);
    doc.fontSize(54).fillColor(GREEN).font('Helvetica-Bold').text((nameParts.slice(1).join(' ') || '').toUpperCase(), PAD, 118);
    doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique').text(content.styleIdentity?.tagline || '', PAD, 194, { width: IW });
    const paletteY = 256;
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold').text('YOUR COLOUR PALETTE', PAD, paletteY, { characterSpacing: 3 });
    doc.moveTo(PAD, paletteY + 12).lineTo(PAD + IW, paletteY + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
    const sw = 80, swGap = 16, swatchY = paletteY + 24;
    (content.colourPalette?.colours || []).slice(0, 3).forEach((hex, i) => {
      doc.rect(PAD + i * (sw + swGap), swatchY, sw, sw).fill(hex);
    });
    const diagY = swatchY + sw + 32;
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold').text('YOUR DIAGNOSIS', PAD, diagY, { characterSpacing: 3 });
    doc.moveTo(PAD, diagY + 12).lineTo(PAD + IW, diagY + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
    lcard(PAD, diagY + 20, IW, 52, GREEN);
    doc.fontSize(12).fillColor(WHITE).font('Helvetica-Bold').text(content.diagnosis?.headline || '', PAD + 16, diagY + 32, { width: IW - 32, lineGap: 2 });
    const bodyY = diagY + 88;
    doc.fontSize(10).fillColor(MUTED).font('Helvetica').text(content.diagnosis?.body || '', PAD, bodyY, { width: IW, lineGap: 4 });
    const prodY = bodyY + textH(content.diagnosis?.body || '', 10, 'Helvetica', IW) + 32;
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold').text('STYLE SUGGESTIONS', PAD, prodY, { characterSpacing: 3 });
    doc.moveTo(PAD, prodY + 12).lineTo(PAD + IW, prodY + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
    (content.recommendedPieces || []).slice(0, 2).forEach((piece, i) => {
      const cy = prodY + 24 + i * 68;
      doc.rect(PAD, cy, IW, 60).fill(CARD);
      doc.rect(PAD, cy, 2, 60).fill(GREEN);
      doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold').text((piece.category || '').toUpperCase(), PAD + 14, cy + 10, { characterSpacing: 1.5 });
      doc.fontSize(10).fillColor(WHITE).font('Helvetica-Bold').text(piece.name || '', PAD + 14, cy + 24, { width: IW - 28 });
      doc.fontSize(8.5).fillColor(GREY).font('Helvetica').text(piece.why || '', PAD + 14, cy + 40, { width: IW - 28 });
    });
    footer();
    doc.addPage(); bg(); pageHeader('Unlock Your Full Blueprint');
    doc.rect(0, 40, PW, 120).fill('#0E0C0A');
    doc.moveTo(0, 160).lineTo(PW, 160).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.fontSize(32).fillColor(WHITE).font('Helvetica-Bold').text('WANT THE FULL', PAD, 60);
    doc.fontSize(32).fillColor(GREEN).font('Helvetica-Bold').text('PICTURE?', PAD, 98);
    const lockedItems = [
      ['STYLE DNA', 'Your silhouette, fit language, fabrics and exactly what to avoid'],
      ['WARDROBE BLUEPRINT', '5 priorities in order — what to buy first and why'],
      ['5 PRODUCT PICKS', 'Hand-picked with brand, price and clickable links'],
      ['WHERE TO INVEST', '4 brands suited to your goal and budget'],
    ];
    let lockY = 180;
    lockedItems.forEach(([label, desc]) => {
      doc.rect(PAD, lockY, IW, 52).fill(CARD2);
      doc.rect(PAD, lockY, 2, 52).fill(BORDER);
      doc.fontSize(7).fillColor(GREY).font('Helvetica-Bold').text('[ LOCKED ]  ' + label, PAD + 14, lockY + 10, { characterSpacing: 2 });
      doc.fontSize(9).fillColor(GREY).font('Helvetica').text(desc, PAD + 14, lockY + 26, { width: IW - 28 });
      lockY += 60;
    });
    const ctaY = lockY + 20;
    doc.rect(PAD, ctaY, IW, 120).fill(GREEN);
    doc.fontSize(18).fillColor(BG).font('Helvetica-Bold').text('UNLOCK YOUR FULL BLUEPRINT', PAD + 20, ctaY + 18, { width: IW - 40, align: 'center' });
    doc.fontSize(12).fillColor(BG).font('Helvetica').text('Everything above. 6-page PDF. Built around your answers.', PAD + 20, ctaY + 50, { width: IW - 40, align: 'center' });
    doc.fontSize(28).fillColor(BG).font('Helvetica-Bold').text('Standard £4.99  ·  Premium £9.99', PAD + 20, ctaY + 78, { width: IW - 40, align: 'center' });
    doc.fontSize(10).fillColor(GREY).font('Helvetica').text('Visit outfitify.co.uk to unlock your report', PAD, ctaY + 136, { width: IW, align: 'center' });
    footer();
    doc.end();
    return new Promise((resolve, reject) => {
      stream.on('finish', () => resolve(pdfPath));
      stream.on('error', reject);
    });
  }

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
  function sectionLabel(text, y) {
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold').text(text, PAD, y, { characterSpacing: 3 });
    doc.moveTo(PAD, y + 12).lineTo(PAD + IW, y + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
  }
  function heroBlock(line1, line2, sub) {
    doc.rect(0, 40, PW, 90).fill('#0E0C0A');
    doc.moveTo(0, 130).lineTo(PW, 130).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.fontSize(24).fillColor(WHITE).font('Helvetica-Bold').text(line1, PAD, 52);
    doc.fontSize(24).fillColor(GREEN).font('Helvetica-Bold').text(line2, PAD, 80);
    if (sub) doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique').text(sub, PAD, 118, { width: IW });
  }

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
    doc.rect(x, y, cardW, 46).fill(CARD2); doc.rect(x, y, 2, 46).fill(GREEN);
    doc.fontSize(9.5).fillColor(WHITE).font('Helvetica-Bold').text(title, x + 14, y + 8, { width: cardW - 24 });
    doc.fontSize(8).fillColor(GREY).font('Helvetica').text(desc, x + 14, y + 26, { width: cardW - 24 });
  });
  footer();

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
    doc.rect(PAD, bpY, IW, h).fill(CARD2); doc.rect(PAD, bpY, 2, h).fill(GREEN);
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

  if (tier === 'premium') {
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
      doc.rect(sx, cardY, shopColW, rowH).fill(CARD); doc.rect(sx, cardY, 2, rowH).fill(GREEN);
      doc.fontSize(30).fillColor(GREEN).font('Helvetica-Bold').text(`0${i + 1}`, sx + 14, cardY + 14, { lineBreak: false });
      doc.fontSize(13).fillColor(WHITE).font('Helvetica-Bold').text(shop.brand || '', sx + 14, cardY + 52, { width: shopColW - 28, lineBreak: false });
      doc.fontSize(9).fillColor(MUTED).font('Helvetica').text(shop.why || '', sx + 14, cardY + 72, { width: shopColW - 28, lineGap: 2 });
      const shopWhyH = textH(shop.why || '', 9, 'Helvetica', shopColW - 28);
      doc.fontSize(8).fillColor(GREEN).font('Helvetica-Oblique').text(`Best for: ${shop.bestFor || ''}`, sx + 14, cardY + 74 + shopWhyH, { width: shopColW - 28, lineGap: 2 });
    });
    const ctaY = PH - 28 - 12 - 56;
    doc.rect(PAD, ctaY, IW, 56).fill(CARD2); doc.rect(PAD, ctaY, IW, 56).strokeColor(GREEN).lineWidth(0.5).stroke(); doc.rect(PAD, ctaY, 2, 56).fill(GREEN);
    doc.fontSize(11).fillColor(WHITE).font('Helvetica-Bold').text('Know someone who needs this?', PAD + 16, ctaY + 12, { width: IW - 32 });
    doc.fontSize(9).fillColor(MUTED).font('Helvetica').text('Share outfitify.co.uk — every report is built fresh, personalised to whoever takes the quiz.', PAD + 16, ctaY + 30, { width: IW - 32 });
    footer();
  } else {
    doc.addPage(); bg(); pageHeader('Unlock The Complete System');
    doc.rect(0, 40, PW, 120).fill('#0E0C0A');
    doc.moveTo(0, 160).lineTo(PW, 160).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.fontSize(32).fillColor(WHITE).font('Helvetica-Bold').text('WANT MORE?', PAD, 60);
    doc.fontSize(32).fillColor(GREEN).font('Helvetica-Bold').text('UPGRADE TO PREMIUM', PAD, 98);
    const upgradeItems = [
      ['9 PRODUCT PICKS', '4 more hand-picked products — full wardrobe coverage across every category'],
      ['WHERE TO INVEST', '4 brands specifically suited to your goal, lifestyle and budget'],
      ['NEVER BUY AGAIN', 'The exact items to cut from your wardrobe immediately and why'],
      ['COST PER WEAR', 'How to think about spending at your specific budget level'],
    ];
    let uY = 180;
    upgradeItems.forEach(([label, desc]) => {
      doc.rect(PAD, uY, IW, 56).fill(CARD2); doc.rect(PAD, uY, 2, 56).fill(GREEN);
      doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold').text(label, PAD + 14, uY + 10, { characterSpacing: 2 });
      doc.fontSize(9).fillColor(MUTED).font('Helvetica').text(desc, PAD + 14, uY + 26, { width: IW - 28 });
      uY += 64;
    });
    const uCtaY = uY + 20;
    doc.rect(PAD, uCtaY, IW, 100).fill(GREEN);
    doc.fontSize(20).fillColor(BG).font('Helvetica-Bold').text('UPGRADE TO PREMIUM', PAD + 20, uCtaY + 16, { width: IW - 40, align: 'center' });
    doc.fontSize(13).fillColor(BG).font('Helvetica').text('Everything above included. Just £5 more.', PAD + 20, uCtaY + 46, { width: IW - 40, align: 'center' });
    doc.fontSize(22).fillColor(BG).font('Helvetica-Bold').text('£9.99  ·  outfitify.co.uk', PAD + 20, uCtaY + 68, { width: IW - 40, align: 'center' });
    footer();
  }

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(pdfPath));
    stream.on('error', reject);
  });
}

async function sendEmail(toEmail, downloadUrl, styleIdentityName, tier = 'standard', sessionId = '') {
  const upgradeUrl = `https://unlock.outfitify.co.uk?sid=${sessionId}`;
  const tierContent = {
    free: {
      subject: `Your ${styleIdentityName} Style Starter is Ready`,
      headline: 'Your free style report is ready.',
      body: `Your <span style="color:#C8BFB5">${styleIdentityName}</span> style starter has been built — your style identity, colour palette and diagnosis, all based on your answers.`,
      downloadLabel: 'DOWNLOAD MY FREE REPORT →',
      upsell: `
        <div style="background:#111111;border:1px solid #2A2520;border-left:3px solid #B8A898;padding:24px;margin:0 0 24px">
          <p style="color:#B8A898;font-size:10px;letter-spacing:3px;font-weight:600;margin:0 0 10px;text-transform:uppercase">Want the full picture?</p>
          <p style="color:#C8BFB5;font-size:13px;line-height:1.7;margin:0 0 16px">Your free report shows you the problem. Your full blueprint shows you exactly how to fix it — with your complete Style DNA, wardrobe priorities, and hand-picked products with links and prices.</p>
          <a href="${upgradeUrl}" style="display:block;background:#B8A898;color:#0A0A0A;text-align:center;padding:14px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;text-transform:uppercase">UNLOCK YOUR FULL BLUEPRINT — £4.99 →</a>
        </div>`,
    },
    standard: {
      subject: `Your ${styleIdentityName} Style Blueprint is Ready`,
      headline: 'Your blueprint is ready.',
      body: `Your <span style="color:#C8BFB5">${styleIdentityName}</span> personal style blueprint has been generated — your diagnosis, Style DNA, wardrobe blueprint and 5 hand-picked products, all built specifically around you.`,
      downloadLabel: 'DOWNLOAD MY STYLE BLUEPRINT →',
      upsell: `
        <div style="background:#111111;border:1px solid #2A2520;border-left:3px solid #B8A898;padding:24px;margin:0 0 24px">
          <p style="color:#B8A898;font-size:10px;letter-spacing:3px;font-weight:600;margin:0 0 10px;text-transform:uppercase">Want the complete system?</p>
          <p style="color:#C8BFB5;font-size:13px;line-height:1.7;margin:0 0 16px">Upgrade to Premium for 9 product recommendations, 4 brand picks tailored to your style, the never buy again list, and cost per wear insight — all for just £5 more.</p>
          <a href="${process.env.BASE_URL || 'https://outfitify-backend-production.up.railway.app'}/api/upgrade-to-premium/${sessionId}" style="display:block;background:#B8A898;color:#0A0A0A;text-align:center;padding:14px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;text-transform:uppercase">UPGRADE TO PREMIUM — £9.99 →</a>
        </div>`,
    },
    premium: {
      subject: `Your ${styleIdentityName} Complete Style System is Ready`,
      headline: 'Your complete style system is ready.',
      body: `Your <span style="color:#C8BFB5">${styleIdentityName}</span> premium style blueprint has been generated — the full system, 9 hand-picked products, brand guide, and everything you need to sort your wardrobe for good.`,
      downloadLabel: 'DOWNLOAD MY COMPLETE BLUEPRINT →',
      upsell: `
        <div style="background:#111111;border:1px solid #2A2520;padding:20px 24px;margin:0 0 24px;text-align:center">
          <p style="color:#7A6E66;font-size:12px;line-height:1.6;margin:0">Know someone who needs this? Share <span style="color:#B8A898">outfitify.co.uk</span> — every report is built fresh, personalised to whoever takes the quiz.</p>
        </div>`,
    },
  };

  const content = tierContent[tier] || tierContent.standard;
  const emailBody = {
    from: { address: 'outfitify@outfitify.co.uk', name: 'Outfitify' },
    to: [{ email_address: { address: toEmail } }],
    subject: content.subject,
    htmlbody: `
      <div style="background:#0A0A0A;padding:0;font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #2A2520">
        <div style="background:#111111;padding:28px 40px;border-bottom:1px solid #2A2520;text-align:center">
          <p style="color:#7A6E66;font-size:10px;letter-spacing:4px;margin:0 0 4px;text-transform:uppercase">Your Personal Style Report</p>
          <h1 style="color:#F2EDE6;font-size:14px;letter-spacing:5px;margin:0;font-weight:600">OUTFITIFY</h1>
        </div>
        <div style="padding:44px 40px">
          <h2 style="color:#F2EDE6;font-size:26px;font-weight:300;margin:0 0 12px;line-height:1.2">${content.headline}</h2>
          <p style="color:#7A6E66;font-size:14px;line-height:1.7;margin:0 0 32px">${content.body}</p>
          <a href="${downloadUrl}" style="display:block;background:#F2EDE6;color:#0A0A0A;text-align:center;padding:16px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;margin:0 0 32px;text-transform:uppercase">${content.downloadLabel}</a>
          ${content.upsell}
          <p style="color:#4A4440;font-size:12px;text-align:center;border-top:1px solid #2A2520;padding-top:20px;margin:0">This link is unique to you. If you have any issues, reply to this email.</p>
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
  console.log(`${tier} email sent to ${toEmail}:`, response.data);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Outfitify backend running on port ${PORT}`));
