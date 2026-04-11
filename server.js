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

  const filtered = products.filter(p => {
    const price = parseFloat(p['Price']) || 0;
    const active = !p['Status'] || p['Status'].toLowerCase() === 'active';
    return price <= maxPrice && p['Item Name'] && active;
  });

  console.log(`[fetchProducts] budget=${maxPrice}, filtered=${filtered.length} active products`);

  const byCategory = {};
  filtered.forEach(p => {
    const cat = p['Category'] || 'Other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  });

  // Also build an unfiltered-by-price lookup so we can fall back per category
  const allByCategory = {};
  products.forEach(p => {
    if (!p['Item Name']) return;
    const active = !p['Status'] || p['Status'].toLowerCase() === 'active';
    if (!active) return;
    const cat = p['Category'] || 'Other';
    if (!allByCategory[cat]) allByCategory[cat] = [];
    allByCategory[cat].push(p);
  });

  const categories = ['Top', 'Bottoms', 'Shoes', 'Hoodie/Jacket'];
  const selected = {};
  categories.forEach(cat => {
    let pool = (byCategory[cat] || []).sort(() => Math.random() - 0.5);

    // If a category has fewer than 2 in-budget options, top up with the
    // cheapest items from that category regardless of budget. This prevents
    // Claude having no choice but to recommend an over-budget item, or worse,
    // having nothing to recommend at all. Items added via fallback are flagged
    // so the prompt can note they're slightly over budget.
    if (pool.length < 2 && allByCategory[cat]) {
      const overBudget = allByCategory[cat]
        .filter(p => !pool.find(q => q['Item Name'] === p['Item Name']))
        .sort((a, b) => (parseFloat(a['Price']) || 0) - (parseFloat(b['Price']) || 0));
      const needed = Math.max(2 - pool.length, 0);
      const extras = overBudget.slice(0, needed).map(p => ({ ...p, _overBudget: true }));
      pool = [...pool, ...extras];
      if (extras.length) {
        console.log(`[fetchProducts] category="${cat}" short on budget options — added ${extras.length} fallback item(s): ${extras.map(p => p['Item Name']).join(', ')}`);
      }
    }

    selected[cat] = pool.slice(0, 8);
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
      url: p['Product URL'],
      ...(p._overBudget ? { note: 'slightly over budget — only option available in this category' } : {})
    }));
  }

  // Build a flat list of all available product names so Claude knows exactly
  // what it can pick from — prevents hallucinated or off-list picks
  const allAvailableProducts = [];
  for (const [cat, items] of Object.entries(productSummary)) {
    items.forEach(p => allAvailableProducts.push({ ...p, category: cat }));
  }

  const prompt = `You are the Outfitify AI stylist. You write like a senior personal stylist who has worked with hundreds of men — direct, confident, specific and authoritative. You never write generic advice. Every single sentence must be tied to this customer's specific answers.

CUSTOMER PROFILE:
- Budget per item: ${quizData.budget}
- Style struggles (what they selected — address these directly): ${quizData.struggles}
- Lifestyle: ${quizData.lifestyle}
- Style goal and aesthetic direction: ${quizData.goal} (use this to drive the entire style identity — if they said old money/quiet luxury, the report should reflect that aesthetic; if streetwear/oversized, reflect that; if gym-to-street, reflect that. This is the north star for everything.)
- How clothes fit them: ${quizData.fit}

AVAILABLE PRODUCTS — you MUST only recommend products from this exact list. Do not recommend any product not listed here:
${JSON.stringify(allAvailableProducts, null, 2)}

CRITICAL CONSISTENCY RULES — violations will break the customer's trust:
1. Your recommended pieces MUST be consistent with the style advice in the report. If the report tells the customer to avoid oversized fits, do NOT recommend any product with "oversized" in the name. If the report says to avoid loose fits, do not recommend "relaxed fit" items. Every recommended piece must be an example of the advice you gave, not a contradiction of it.
2. Only recommend products whose colours appear in the colour palette you defined. If you define a palette of charcoal, white, navy and brown, do not recommend a pink shirt or a bright orange jacket.
3. The "why" for each recommended piece must reference a specific detail — fit, fabric, or construction detail — that makes it right for this customer. Never write generic praise like "this is a great piece" or "this will work well for you".
4. Never recommend a product just because it exists in the list. Only recommend it if it genuinely fits the customer's style DNA and goal.
5. Do NOT recommend sportswear, activewear, gym wear, or athletic/performance products (e.g. Dri-FIT, training tops, running gear, gym shorts) UNLESS the customer's lifestyle or goal explicitly mentions sport, gym, or athletic activity. A "varied lifestyle" or "active social life" does NOT count — those are style contexts, not gym contexts. If in doubt, skip the athletic product and pick something more versatile.
6. Do NOT recommend products with "jogger", "comfort waist", "sweatpant", or "lounge" in the name when the report's style advice calls for tailored, structured, or smart-casual silhouettes. These descriptors directly contradict structured style advice.
7. Brand credibility must match the report's positioning. Do not recommend ultra-fast-fashion brands (e.g. BoohooMan, Shein, PrettyLittleThing) in a report positioned as intentional, premium, or quality-focused — it undermines the entire tone. Stick to high-street brands with genuine credibility at the relevant price point.
8. Some products in the list are marked with a note: "slightly over budget — only option available in this category". If you recommend one of these, acknowledge it honestly in the "why" field — e.g. "This is slightly above your usual budget but it is the strongest option in this category and worth the investment for the quality." Never silently recommend an over-budget item as if it is within budget.

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
    "silhouette": "Exactly what silhouette works for their body, goal and lifestyle — use their fit answer to give specific proportions advice. E.g. if clothes are baggy, recommend slimmer cuts and layering to add structure. If tight on arms/shoulders, recommend relaxed fits with more room through the chest and shoulder. Be specific about what to look for and what to avoid.",
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
  "recommendedPieces": [
    {
      "category": "Top/Bottoms/Shoes/Hoodie/Jacket",
      "name": "exact product name from the available products list above",
      "brand": "brand name",
      "price": "£XX",
      "url": "exact product url from the available products list above",
      "why": "One sentence — why this specific piece works for their style DNA, goal and lifestyle. Reference the specific fit, fabric or detail that makes it right for them. Must be consistent with the style advice in this report — if the report says avoid oversized, do not pick an oversized item."
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
- recommendedPieces must contain exactly 9 pieces selected from the products above — 3 tops, 2 bottoms, 2 shoes, 2 layers/jackets. Choose pieces that align with their style DNA and goal. They do not need to form complete outfits — they should be the 9 best individual pieces for this customer
- whereToInvest must contain exactly 4 brands — real UK-accessible brands only
- Include the exact product URL for each recommended piece from the list above
- Keep language simple and direct — write for someone who knows nothing about fashion
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

  console.log('=== CLAUDE OUTPUT ===');
  console.log(JSON.stringify(parsed, null, 2));
  console.log('=== END OUTPUT ===');

  return parsed;
}

// ════════════════════════════════════════
// Build PDF — 6 page clean version
// ════════════════════════════════════════
async function buildPDF(content, quizData, products) {
  const pdfPath = path.join(os.tmpdir(), `outfitify-${Date.now()}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  // ── Design tokens ──
  const BG     = '#0A0A0A';
  const HEADER = '#111111';
  const BORDER = '#2A2520';
  const GREEN  = '#B8A898';
  const PURPLE = '#8C7B6B';
  const WHITE  = '#F2EDE6';
  const GREY   = '#7A6E66';
  const MUTED  = '#C8BFB5';
  const CARD   = '#141210';
  const CARD2  = '#1C1916';
  const RED    = '#C4886A';

  const PW = 595, PH = 842, PAD = 50, IW = 495;

  // FIX: Replaced character-count-based truncation with PDFKit's own heightOfString
  // to determine if text fits, then truncate by word rather than raw character slice.
  // This prevents mid-word cuts and the ellipsis appearing mid-sentence.
  function truncateToFit(str, maxWidth, fontSize, fontName, maxLines) {
    if (!str) return '';
    doc.fontSize(fontSize).font(fontName || 'Helvetica');
    const lineH = fontSize * 1.2;
    const maxH = maxLines * lineH;
    if (doc.heightOfString(str, { width: maxWidth }) <= maxH) return str;
    // Binary-search on word count until it fits
    const words = str.split(' ');
    let lo = 1, hi = words.length, best = words[0];
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = words.slice(0, mid).join(' ') + '\u2026';
      if (doc.heightOfString(candidate, { width: maxWidth }) <= maxH) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function bg() { doc.rect(0, 0, PW, PH).fill(BG); }

  function pageHeader(sub) {
    doc.rect(0, 0, PW, 36).fill(HEADER);
    doc.rect(0, 35, PW, 1).fill(BORDER);
    doc.fontSize(8).fillColor(WHITE).font('Helvetica-Bold')
       .text('OUTFITIFY', 0, 11, { width: PW, align: 'center', characterSpacing: 6 });
    if (sub) doc.fontSize(6.5).fillColor(GREY).font('Helvetica')
       .text(sub.toUpperCase(), 0, 22, { width: PW, align: 'center', characterSpacing: 2 });
  }

  function footer() {
    doc.rect(0, PH - 28, PW, 28).fill(HEADER);
    doc.rect(0, PH - 28, PW, 1).fill(BORDER);
    doc.fontSize(7).fillColor(GREY).font('Helvetica')
       .text('OUTFITIFY.CO.UK  ·  MAKING STYLE EFFORTLESS', 0, PH - 15, { width: PW, align: 'center', characterSpacing: 1 });
  }

  function sectionLabel(text, y) {
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold')
       .text(text, PAD, y, { characterSpacing: 3 });
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

  // ════════════════════════════════════════
  // PAGE 1: COVER
  // Redesigned for breathing room — hero is taller, sections have generous
  // vertical gaps, "What's Inside" cards are larger and sit near the bottom
  // ════════════════════════════════════════
  bg();

  // Hero band — taller (40→240) gives the identity name room to breathe
  doc.rect(0, 40, PW, 200).fill('#0E0C0A');
  doc.moveTo(0, 240).lineTo(PW, 240).strokeColor(BORDER).lineWidth(0.5).stroke();
  pageHeader();

  // Style identity name — split across two lines with more vertical space
  const nameParts = (content.styleIdentity?.name || 'YOUR STYLE').split(' ');
  const nameL1 = nameParts[0] || '';
  const nameL2 = nameParts.slice(1).join(' ') || '';
  doc.fontSize(54).fillColor(WHITE).font('Helvetica-Bold').text(nameL1.toUpperCase(), PAD, 60);
  doc.fontSize(54).fillColor(GREEN).font('Helvetica-Bold').text(nameL2.toUpperCase(), PAD, 118);

  // Tagline sits inside the hero band with clear separation
  doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique')
     .text(content.styleIdentity?.tagline || '', PAD, 194, { width: IW });

  // About card — starts 24px below the hero divider, taller to avoid cramping
  const introText = content.styleIdentity?.intro || '';
  const introH = Math.max(textH(introText, 10, 'Helvetica', IW - 28) + 36, 88);
  lcard(PAD, 256, IW, introH, GREEN);
  doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold')
     .text('ABOUT YOUR REPORT', PAD + 14, 266, { characterSpacing: 2 });
  doc.fontSize(10).fillColor(MUTED).font('Helvetica')
     .text(introText, PAD + 14, 282, { width: IW - 28, lineGap: 3 });

  // Colour palette — 20px gap below intro card
  const paletteY = 256 + introH + 20;
  sectionLabel('YOUR COLOUR PALETTE', paletteY);
  const sw = 58, swGap = 10;
  const swatchY = paletteY + 20;
  (content.colourPalette?.colours || []).forEach((hex, i) => {
    const x = PAD + i * (sw + swGap);
    doc.rect(x, swatchY, sw, sw).fill(hex);
    doc.fontSize(7.5).fillColor(GREY).font('Helvetica')
       .text((content.colourPalette?.labels || [])[i] || '', x, swatchY + sw + 6, { width: sw, align: 'center' });
  });
  const rationaleY = swatchY + sw + 22;
  doc.fontSize(9.5).fillColor(MUTED).font('Helvetica')
     .text(content.colourPalette?.rationale || '', PAD, rationaleY, { width: IW, lineGap: 3 });

  // "What's Inside" — flows naturally 24px below the rationale text.
  // No pinning to bottom — content distributes evenly down the page.
  const rationaleH = textH(content.colourPalette?.rationale || '', 9.5, 'Helvetica', IW);
  const insideY = rationaleY + rationaleH + 24;
  sectionLabel("WHAT'S INSIDE", insideY);
  const insideItems = [
    ['Why You\'ve Been Getting It Wrong', 'Your personal style diagnosis'],
    ['Your Style DNA', 'Silhouette, fit, fabrics & colour'],
    ['Your Wardrobe Blueprint', '5 priorities & what to buy first'],
    ['9 Recommended Pieces', 'Hand-picked for your style & budget'],
  ];
  insideItems.forEach(([title, desc], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const cardW = (IW - 10) / 2;
    const x = PAD + col * (cardW + 10);
    const y = insideY + 18 + row * 54;
    doc.rect(x, y, cardW, 46).fill(CARD2);
    doc.rect(x, y, 2, 46).fill(GREEN);
    doc.fontSize(9.5).fillColor(WHITE).font('Helvetica-Bold').text(title, x + 14, y + 8, { width: cardW - 24 });
    doc.fontSize(8).fillColor(GREY).font('Helvetica').text(desc, x + 14, y + 26, { width: cardW - 24 });
  });

  footer();

  // ════════════════════════════════════════
  // PAGE 2: WHY YOU'VE BEEN GETTING IT WRONG
  // ════════════════════════════════════════
  doc.addPage();
  bg();
  pageHeader("Why You've Been Getting It Wrong");
  heroBlock("WHY YOU'VE BEEN", "GETTING IT WRONG");

  const diagHeadline = content.diagnosis?.headline || '';
  lcard(PAD, 144, IW, 52, GREEN);
  doc.fontSize(13).fillColor(WHITE).font('Helvetica-Bold')
     .text(diagHeadline, PAD + 16, 158, { width: IW - 32, lineGap: 2 });

  const diagBody = content.diagnosis?.body || '';
  const diagBodyH = textH(diagBody, 10.5, 'Helvetica', IW) + 8;
  doc.fontSize(10.5).fillColor(MUTED).font('Helvetica')
     .text(diagBody, PAD, 212, { width: IW, lineGap: 4 });

  const truthY = 220 + diagBodyH;
  doc.rect(PAD, truthY, IW, 1).fill(GREEN);
  const theTruth = content.diagnosis?.theTruth || '';
  doc.fontSize(13).fillColor(GREEN).font('Helvetica-Bold')
     .text(theTruth, PAD, truthY + 16, { width: IW, lineGap: 3 });

  footer();

  // ════════════════════════════════════════
  // PAGE 3: YOUR STYLE DNA
  // ════════════════════════════════════════
  doc.addPage();
  bg();
  pageHeader('Your Style DNA');
  heroBlock('YOUR', 'STYLE DNA');

  const dnaItems = [
    ['SILHOUETTE', content.styleDNA?.silhouette || '', GREEN],
    ['FIT LANGUAGE', content.styleDNA?.fitLanguage || '', GREEN],
    ['FABRICS', content.styleDNA?.fabrics || '', GREEN],
    ['COLOUR USAGE', content.styleDNA?.colourUsage || '', GREEN],
    ['STOP WEARING', content.styleDNA?.avoid || '', RED],
  ];

  let dnaY = 144;
  dnaItems.forEach(([label, text, accent]) => {
    const h = Math.max(textH(text, 9.5, 'Helvetica', IW - 28) + 32, 52);
    if (dnaY + h > PH - 40) return;
    lcard(PAD, dnaY, IW, h, accent);
    doc.fontSize(6.5).fillColor(accent).font('Helvetica-Bold')
       .text(label, PAD + 14, dnaY + 10, { characterSpacing: 2 });
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica')
       .text(text, PAD + 14, dnaY + 24, { width: IW - 28, lineGap: 3 });
    dnaY += h + 8;
  });

  footer();

  // ════════════════════════════════════════
  // PAGE 4: YOUR WARDROBE BLUEPRINT
  // ════════════════════════════════════════
  doc.addPage();
  bg();
  pageHeader('Your Wardrobe Blueprint');
  heroBlock('YOUR WARDROBE', 'BLUEPRINT');

  doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique')
     .text(content.wardrobeBlueprint?.headline || '', PAD, 144, { width: IW });

  let bpY = 168;
  (content.wardrobeBlueprint?.priorities || []).forEach((p, i) => {
    const textW = IW - 72;
    const whyH = textH(p.why || '', 9, 'Helvetica', textW);
    const shopH = textH(p.howToShop || '', 8, 'Helvetica-Oblique', textW);
    const h = Math.max(whyH + shopH + 36, 60);
    if (bpY + h > PH - 80) return;
    doc.rect(PAD, bpY, IW, h).fill(CARD2);
    doc.rect(PAD, bpY, 2, h).fill(GREEN);
    doc.fontSize(24).fillColor(GREEN).font('Helvetica-Bold')
       .text(`0${p.order}`, PAD + 10, bpY + (h - 24) / 2, { lineBreak: false });
    doc.fontSize(10).fillColor(WHITE).font('Helvetica-Bold')
       .text(p.item || '', PAD + 52, bpY + 10, { width: textW, lineBreak: false });
    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
       .text(p.why || '', PAD + 52, bpY + 26, { width: textW, lineGap: 2 });
    doc.fontSize(8).fillColor(GREEN).font('Helvetica-Oblique')
       .text(p.howToShop || '', PAD + 52, bpY + 28 + whyH, { width: textW, lineGap: 2 });
    bpY += h + 5;
  });

  const neverY = Math.min(bpY + 8, PH - 100);
  doc.rect(PAD, neverY, IW, 1).fill(RED);
  doc.fontSize(7).fillColor(RED).font('Helvetica-Bold')
     .text('NEVER BUY AGAIN', PAD, neverY + 10, { characterSpacing: 2 });
  doc.fontSize(9.5).fillColor(MUTED).font('Helvetica')
     .text(content.wardrobeBlueprint?.neverBuyAgain || '', PAD, neverY + 24, { width: IW, lineGap: 3 });

  footer();

  // ════════════════════════════════════════
  // PAGE 5: 9 RECOMMENDED PIECES
  // FIX: Increased image size from 56px to 76px for more visual impact.
  // FIX: Replaced character-count truncation with word-aware truncateToFit()
  //      so descriptions never cut mid-word or mid-sentence with a hanging ellipsis.
  // ════════════════════════════════════════
  doc.addPage();
  bg();
  pageHeader('Your Recommended Pieces');
  heroBlock('9 PIECES BUILT', 'AROUND YOU', 'Hand-picked from our database to match your style DNA and budget');

  const pieces = (content.recommendedPieces || []).slice(0, 9);

  const imageBuffers = await Promise.all(pieces.map(async piece => {
    let imageUrl = null;
    for (const catItems of Object.values(products)) {
      const match = catItems.find(p => p['Item Name'] === piece.name);
      if (match) { imageUrl = match['Image URL']; break; }
    }
    if (!imageUrl) return null;
    try {
      const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 5000 });
      return Buffer.from(imgResp.data);
    } catch { return null; }
  }));

  // CARD_H=70, IMG_W=64, gap=3 → 9 cards = 9×73 = 657px, fits within ~666px available
  // (PH=842, footer=28, hero bottom=148, so available = 842-28-148 = 666px)
  const CARD_H = 70, IMG_W = 64, IMG_PAD = 8;
  let pieceY = 148;

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const imgBuffer = imageBuffers[i];

    if (pieceY + CARD_H > PH - 36) break;

    const tx = PAD + IMG_PAD + IMG_W + 12;
    const priceColX = PAD + IW - 88;
    const textW = priceColX - tx - 8;

    doc.rect(PAD, pieceY, IW, CARD_H).fill(CARD);
    doc.rect(PAD, pieceY, IW, CARD_H).strokeColor(BORDER).lineWidth(0.5).stroke();

    // Image
    const imgY = pieceY + (CARD_H - IMG_W) / 2;
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

    // Resolve URL
    let productUrl = piece.url || null;
    if (!productUrl) {
      for (const catItems of Object.values(products)) {
        const match = catItems.find(p => p['Item Name'] === piece.name);
        if (match && match['Product URL']) { productUrl = match['Product URL']; break; }
      }
    }

    // Category label
    doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold')
       .text((piece.category || '').toUpperCase(), tx, pieceY + 8, { width: textW, lineBreak: false, characterSpacing: 1.5 });

    // Product name — underlined when linked so customers know it's clickable
    const nameStr = truncateToFit(piece.name || '', textW, 10, 'Helvetica-Bold', 1);
    doc.fontSize(10).fillColor(productUrl ? GREEN : WHITE).font('Helvetica-Bold')
       .text(nameStr, tx, pieceY + 20, {
         width: textW,
         lineBreak: false,
         ...(productUrl ? { link: productUrl, underline: true } : {})
       });

    // Why description — 2 lines max, word-aware truncation
    const whyStr = truncateToFit(piece.why || '', textW, 8.5, 'Helvetica', 2);
    doc.fontSize(8.5).fillColor(GREY).font('Helvetica')
       .text(whyStr, tx, pieceY + 36, { width: textW, lineGap: 1.5 });

    // Price — also linked
    if (productUrl) {
      doc.fontSize(15).fillColor(GREEN).font('Helvetica-Bold')
         .text(piece.price || '', priceColX, pieceY + 12, { width: 86, align: 'right', lineBreak: false, link: productUrl });
    } else {
      doc.fontSize(15).fillColor(GREEN).font('Helvetica-Bold')
         .text(piece.price || '', priceColX, pieceY + 12, { width: 86, align: 'right', lineBreak: false });
    }

    // Brand
    doc.fontSize(8).fillColor(GREY).font('Helvetica')
       .text(piece.brand || '', priceColX, pieceY + 34, { width: 86, align: 'right', lineBreak: false });

    pieceY += CARD_H + 3;
  }

  footer();

  // ════════════════════════════════════════
  // PAGE 6: WHERE TO INVEST
  // FIX: Replaced weak "retake the quiz" CTA with a stronger referral/share prompt
  // ════════════════════════════════════════
  doc.addPage();
  bg();
  pageHeader('Where To Invest');
  heroBlock('WHERE TO', 'INVEST', 'Brands suited to your goal and budget');

  const shopItems = (content.whereToInvest || []).slice(0, 4);
  const shopColW = (IW - 12) / 2;

  const shopHeights = shopItems.map(shop => {
    const whyH = textH(shop.why || '', 9, 'Helvetica', shopColW - 28);
    const bestForH = textH(`Best for: ${shop.bestFor || ''}`, 8, 'Helvetica-Oblique', shopColW - 28);
    return Math.max(whyH + bestForH + 80, 100);
  });
  const row0H = Math.max(shopHeights[0] || 100, shopHeights[1] || 100);
  const row1H = Math.max(shopHeights[2] || 100, shopHeights[3] || 100);

  shopItems.forEach((shop, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const sx = PAD + col * (shopColW + 12);
    const rowH = row === 0 ? row0H : row1H;
    const cardY = 144 + (row === 0 ? 0 : row0H + 12);

    doc.rect(sx, cardY, shopColW, rowH).fill(CARD);
    doc.rect(sx, cardY, 2, rowH).fill(GREEN);

    doc.fontSize(30).fillColor(GREEN).font('Helvetica-Bold')
       .text(`0${i + 1}`, sx + 14, cardY + 14, { lineBreak: false });
    doc.fontSize(13).fillColor(WHITE).font('Helvetica-Bold')
       .text(shop.brand || '', sx + 14, cardY + 52, { width: shopColW - 28, lineBreak: false });
    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
       .text(shop.why || '', sx + 14, cardY + 72, { width: shopColW - 28, lineGap: 2 });
    const shopWhyH = textH(shop.why || '', 9, 'Helvetica', shopColW - 28);
    doc.fontSize(8).fillColor(GREEN).font('Helvetica-Oblique')
       .text(`Best for: ${shop.bestFor || ''}`, sx + 14, cardY + 74 + shopWhyH, { width: shopColW - 28, lineGap: 2 });
  });

  // FIX: Replaced "retake the quiz" CTA with a referral prompt — more compelling
  // close that plants a seed for word-of-mouth without feeling desperate
  const ctaY = PH - 28 - 12 - 56;
  doc.rect(PAD, ctaY, IW, 56).fill(CARD2);
  doc.rect(PAD, ctaY, IW, 56).strokeColor(GREEN).lineWidth(0.5).stroke();
  doc.rect(PAD, ctaY, 2, 56).fill(GREEN);
  doc.fontSize(11).fillColor(WHITE).font('Helvetica-Bold')
     .text('Know someone who needs this?', PAD + 16, ctaY + 12, { width: IW - 32, align: 'left' });
  doc.fontSize(9).fillColor(MUTED).font('Helvetica')
     .text('Share outfitify.co.uk — every report is built fresh, personalised to whoever takes the quiz.', PAD + 16, ctaY + 30, { width: IW - 32 });

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
