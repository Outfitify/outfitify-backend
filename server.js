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
    'https://occasions.outfitify.co.uk',
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
        merge_fields: {
          BUDGET: quizData.budget || '',
          LIFESTYLE: quizData.lifestyle || '',
          GOAL: quizData.goal || '',
          FIT: quizData.fit || '',
          STRUGGLES: quizData.struggles || '',
          SID: quizData.sessionId || '',
        },
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
  const quizData = { budget, struggles, lifestyle, goal, fit, sessionId };
  saveFreeSession(sessionId, { ...quizData, email, createdAt: Date.now() });
  res.json({ success: true, sessionId });
  addToMailchimp(email, quizData).catch(err => console.error('Mailchimp failed:', err));
  generateAndStoreReport(sessionId, quizData, email, 'free').catch(err => {
    console.error(`Free report generation failed for ${sessionId}:`, err);
  });
});

// CREATE CHECKOUT DIRECT — accepts quiz answers in body, no session lookup needed
// Used by email upgrade links so answers come from Mailchimp merge fields
app.post('/api/create-checkout-direct', async (req, res) => {
  const { budget, struggles, lifestyle, goal, fit, tier, sid } = req.body;
  if (!budget) return res.status(400).json({ error: 'Missing required fields' });

  const resolvedTier = tier || 'standard';
  console.log(`Creating direct ${resolvedTier} checkout from email upgrade link`);

  // Check 2-hour Premium offer window using original free session ID
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  let applyPremiumOffer = false;
  if (resolvedTier === 'premium' && sid) {
    const freeSession = getFreeSession(sid);
    if (freeSession && (Date.now() - freeSession.createdAt) < TWO_HOURS) {
      applyPremiumOffer = true;
      console.log(`2-hour Premium offer valid for session ${sid} — applying UPGRADE coupon`);
    } else {
      console.log(`2-hour Premium offer expired for session ${sid} — charging full £9.99`);
    }
  }

  // Create a fresh session so the report can be generated after payment
  const sessionId = crypto.randomBytes(16).toString('hex');
  sessions.set(sessionId, { budget, struggles, lifestyle, goal, fit, createdAt: Date.now() });

  const tierConfig = {
    standard: { amount: 499, name: 'Outfitify Personal Style Blueprint — Standard' },
    premium:  { amount: 999, name: 'Outfitify Personal Style Blueprint — Premium' },
  };
  const config = tierConfig[resolvedTier] || tierConfig.standard;

  try {
    const checkoutOptions = {
      payment_method_types: ['card'],
      customer_creation: 'always',
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: applyPremiumOffer ? 'Outfitify Personal Style Blueprint — Premium (2-Hour Offer)' : config.name,
            description: 'Your personalised style diagnosis, blueprint, wardrobe formula and outfit examples — built around you.',
            images: ['https://outfitify.co.uk/assets/images/image04.png']
          },
          unit_amount: config.amount
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || 'https://success.outfitify.co.uk'}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}`,
      cancel_url: `https://unlock.outfitify.co.uk?cancelled=true`,
      metadata: {
        sessionId,
        tier: resolvedTier,
        budget:    budget    || '',
        struggles: struggles || '',
        lifestyle: lifestyle || '',
        goal:      goal      || '',
        fit:       fit       || '',
      },
    };

    // Auto-apply UPGRADE coupon for valid 2-hour Premium offer
    if (applyPremiumOffer) {
      checkoutOptions.discounts = [{ coupon: 'UPGRADE' }];
      checkoutOptions.allow_promotion_codes = false;
    }

    const checkoutSession = await stripe.checkout.sessions.create(checkoutOptions);
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Direct checkout error:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
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
    if (tier === 'occasion') {
      const occasionData = {
        occasion: session.metadata.occasion,
        occasionName: session.metadata.occasionName,
        budget: session.metadata.budget,
        fit: session.metadata.fit,
        occasionDetail: session.metadata.occasionDetail,
        style: session.metadata.style,
      };
      generateOccasionReport(sessionId, occasionData, userEmail).catch(err => {
        console.error(`Unhandled error in generateOccasionReport for ${sessionId}:`, err);
      });
    } else {
      generateAndStoreReport(sessionId, quizData, userEmail, tier).catch(err => {
        console.error(`Unhandled error in generateAndStoreReport for ${sessionId}:`, err);
      });
    }
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
Generate a style starter report that makes the customer feel genuinely understood — but leaves them wanting more. The goal is to build trust through quality, then create desire through strategic incompleteness. Every word must feel personal and specific, never generic.

STYLE IDENTITY:
- name: 2-3 word style archetype — make it intriguing and specific e.g. "Sharp Minimalist", "Urban Edge", "Relaxed Authority"
- tagline: One punchy sentence that makes them think "that's exactly me"
- intro: Write a compelling 2-3 sentence paragraph that expands on what this style identity means for THIS person specifically — describe how they probably dress now, why it's not quite working, and what the archetype looks like when it's done right. Make them feel completely seen. This is your biggest conversion hook — if they read this and feel understood, they'll pay.

COLOUR PALETTE:
- exactly 3 colours with labels — include the colour names so it feels considered, not like a placeholder
- rationale: empty string "" — the rationale is locked in the paid tier

DIAGNOSIS:
- headline: One sharp, specific headline that names their exact problem
- body: 2-3 sentences. Identify the root cause specifically tied to their answers. End with one sentence that hints at what changes when they have the system — but don't give the system away. Leave theTruth as empty string ""

STYLE DNA — partial reveal, not fully locked:
- silhouette: Write ONE sentence revealing their primary silhouette recommendation. End with "— the fit language, fabrics and colour usage that make this work for you are in your full blueprint." This partial reveal builds trust and creates desire.
- fitLanguage: empty string ""
- fabrics: empty string ""
- colourUsage: empty string ""
- avoid: Write ONE specific "stop doing this" call-out tied directly to their build and goal — e.g. "Your athletic frame means oversized fits work against you — they add bulk where you don't need it." This specificity proves the paid version knows what it's talking about.

WARDROBE BLUEPRINT — leave all empty:
- headline: empty string ""
- priorities: empty array []
- neverBuyAgain: empty string ""
- costPerWear: empty string ""

RECOMMENDED PIECES — one tease, one generic:
- exactly 2 items
- Item 1: A specific styled description that sounds like real styling advice — e.g. "A heavyweight oversized tee in off-white with a slight drop shoulder — worn untucked over straight-leg denim" — NO brand, NO url (set to ""), NO price (set to ""). Add a why field that says "This is pick 1 of 5 in your full blueprint — each one selected specifically for your build and budget."
- Item 2: A second generic description with no brand, url or price. Why field should hint at what's locked: "Your remaining 4 picks include clickable links, brand names and exact prices — all filtered to your £X budget."

WHERE TO INVEST: empty array []`,
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

TONE RULES — THIS IS THE MOST IMPORTANT SECTION:
- Write like a real stylist talking directly to a person, not generating a report
- Every sentence must sound like it could be said out loud by a friend who knows about clothes
- Second person only ("you", "your")
- Never use these words or phrases under any circumstances: "system", "intentional", "cohesive", "silhouette", "taper", "tapered", "aesthetic", "layering piece", "overshirt", "framework", "elevate", "curated", "palette" (say "colours" instead), "wardrobe staples", "key pieces", "game changer", "it's important to", "consider", "you might want to", "here are some tips", "great", "amazing", "awesome", "elevate your look"
- If you must use a fashion term, explain it immediately in plain English — e.g. "a slim-straight cut (straight leg, not narrowing toward the ankle)"
- Replace jargon with plain English: "silhouette" → "the shape of what you're wearing", "taper" → "narrowing toward the ankle", "cohesive" → "works together", "intentional" → "put together", "aesthetic" → "look", "layering piece" → "something to wear over a t-shirt"
- Never start with "Remember" or "Note that"
- Write section content like a stylist giving direct advice, not like a report being generated
- The diagnosis body should read like someone who has looked at your answers and is telling you honestly what the problem is
- The wardrobe blueprint priorities should read like "here's what I'd buy first and why" — opinionated, direct, specific
- The "avoid" field should sound like a friend telling you to stop doing something, not a warning label
- Be direct and specific — never vague

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
  const SAFE_BOTTOM = PH - 36;

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
    // PAGE 1
    bg();
    doc.rect(0, 40, PW, 200).fill('#0E0C0A');
    doc.moveTo(0, 240).lineTo(PW, 240).strokeColor(BORDER).lineWidth(0.5).stroke();
    pageHeader('Your Free Style Starter');

    const nameParts = (content.styleIdentity?.name || 'YOUR STYLE').split(' ');
    doc.fontSize(54).fillColor(WHITE).font('Helvetica-Bold').text((nameParts[0] || '').toUpperCase(), PAD, 60);
    doc.fontSize(54).fillColor(GREEN).font('Helvetica-Bold').text((nameParts.slice(1).join(' ') || '').toUpperCase(), PAD, 118);
    doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique').text(content.styleIdentity?.tagline || '', PAD, 194, { width: IW });

    // Intro paragraph — the conversion hook
    const introText = content.styleIdentity?.intro || '';
    const introH = Math.max(textH(introText, 10, 'Helvetica', IW - 28) + 36, 72);
    lcard(PAD, 256, IW, introH, GREEN);
    doc.fontSize(10).fillColor(MUTED).font('Helvetica').text(introText, PAD + 14, 272, { width: IW - 28, lineGap: 3 });

    // Colour palette — swatches only, no labels (mystery)
    const paletteY = 256 + introH + 20;
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold').text('YOUR COLOURS', PAD, paletteY, { characterSpacing: 3 });
    doc.moveTo(PAD, paletteY + 12).lineTo(PAD + IW, paletteY + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
    const sw = 80, swGap = 16, swatchY = paletteY + 24;
    (content.colourPalette?.colours || []).slice(0, 3).forEach((hex, i) => {
      doc.rect(PAD + i * (sw + swGap), swatchY, sw, sw).fill(hex);
    });
    // Locked label under swatches
    doc.fontSize(7).fillColor(GREY).font('Helvetica').text('Colour names and usage guide unlocked in your full blueprint', PAD, swatchY + sw + 8, { width: IW });

    // Diagnosis — headline only, no body
    const diagY = swatchY + sw + 36;
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold').text("THE PROBLEM WE'VE SPOTTED", PAD, diagY, { characterSpacing: 3 });
    doc.moveTo(PAD, diagY + 12).lineTo(PAD + IW, diagY + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
    lcard(PAD, diagY + 20, IW, 60, GREEN);
    doc.fontSize(12).fillColor(WHITE).font('Helvetica-Bold').text(content.diagnosis?.headline || '', PAD + 16, diagY + 32, { width: IW - 32, lineGap: 2 });

    // What's locked — teaser items
    let curY = diagY + 96;
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold').text("WHAT'S IN YOUR FULL BLUEPRINT", PAD, curY, { characterSpacing: 3 });
    doc.moveTo(PAD, curY + 12).lineTo(PAD + IW, curY + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
    curY += 20;
    const teaserItems = [
      ['YOUR STYLE DNA', 'Exact fits, fabrics and silhouettes that work for your body'],
      ['WARDROBE BLUEPRINT', '5 priorities in order — what to buy first, what to stop buying'],
      ['5 HAND-PICKED PRODUCTS', 'Clickable links, brands and prices — filtered to your budget'],
    ];
    teaserItems.forEach(([label, desc]) => {
      if (curY + 52 > SAFE_BOTTOM) return;
      doc.rect(PAD, curY, IW, 48).fill(CARD2);
      doc.rect(PAD, curY, 2, 48).fill(BORDER);
      doc.fontSize(7).fillColor(GREY).font('Helvetica-Bold').text('[ LOCKED ]  ' + label, PAD + 14, curY + 8, { characterSpacing: 2 });
      doc.fontSize(8.5).fillColor(GREY).font('Helvetica').text(desc, PAD + 14, curY + 24, { width: IW - 28 });
      curY += 56;
    });

    // STOP DOING THIS — red card
    const avoidText = content.styleDNA?.avoid || '';
    if (avoidText && curY + 80 < SAFE_BOTTOM) {
      const avoidCardH = Math.max(textH(avoidText, 9.5, 'Helvetica', IW - 28) + 28, 48);
      doc.fontSize(6.5).fillColor(RED).font('Helvetica-Bold').text('STOP DOING THIS — ONE FREE INSIGHT', PAD, curY, { characterSpacing: 3 });
      doc.moveTo(PAD, curY + 12).lineTo(PAD + IW, curY + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
      lcard(PAD, curY + 20, IW, avoidCardH, RED);
      doc.fontSize(9.5).fillColor(MUTED).font('Helvetica').text(avoidText, PAD + 14, curY + 32, { width: IW - 28, lineGap: 3 });
    }

    footer();

    // PAGE 2 — upgrade CTA
    doc.addPage();
    bg();
    pageHeader('Unlock Your Full Blueprint');
    doc.rect(0, 40, PW, 120).fill('#0E0C0A');
    doc.moveTo(0, 160).lineTo(PW, 160).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.fontSize(32).fillColor(WHITE).font('Helvetica-Bold').text("YOU'VE GOT YOUR IDENTITY.", PAD, 52);
    doc.fontSize(22).fillColor(GREEN).font('Helvetica-Bold').text('Now get the formula.', PAD, 96, { width: IW });

    const lockedItems = [
      ['FULL STYLE DNA', 'Fit language, fabrics, colour usage — the complete system for your body'],
      ['WARDROBE BLUEPRINT', '5 priorities in order — what to buy first, what to never buy again'],
      ['5 PRODUCT PICKS', 'Clickable links, brand names and exact prices — filtered to your budget'],
      ['WHERE TO INVEST', '4 brands specifically suited to your goal and lifestyle'],
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
    doc.rect(PAD, ctaY, IW, 140).fill(GREEN);
    doc.fontSize(11).fillColor(BG).font('Helvetica-Bold').text('EVERYTHING YOU NEED TO STOP GUESSING.', PAD + 20, ctaY + 16, { width: IW - 40, align: 'center', characterSpacing: 1 });
    doc.fontSize(22).fillColor(BG).font('Helvetica-Bold').text('Start dressing with intention.', PAD + 20, ctaY + 38, { width: IW - 40, align: 'center' });
    doc.fontSize(13).fillColor(BG).font('Helvetica').text('Your full blueprint is waiting — built around your answers, ready to use today.', PAD + 20, ctaY + 68, { width: IW - 40, align: 'center', lineGap: 2 });
    doc.fontSize(28).fillColor(BG).font('Helvetica-Bold').text('£4.99', PAD + 20, ctaY + 100, { width: IW - 40, align: 'center' });
    doc.fontSize(11).fillColor(BG).font('Helvetica').text('outfitify.co.uk  ·  Unlock in 60 seconds', PAD + 20, ctaY + 128, { width: IW - 40, align: 'center', characterSpacing: 1 });
    footer();

    doc.end();
    return new Promise((resolve, reject) => {
      stream.on('finish', () => resolve(pdfPath));
      stream.on('error', reject);
    });
  }

  // PAID TIERS — unchanged from your current working version
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
  sectionLabel('YOUR COLOURS', paletteY);
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
  [["Why It's Not Working", 'The real reason — specific to your answers'], ['Your Style DNA', 'What to wear, how it should fit and what to avoid'], ['What To Buy First', '5 priorities in order — your stylist\'s sequence'], ['Your Personal Edit', 'Hand-picked pieces with clickable links and prices']].forEach(([title, desc], i) => {
    const col = i % 2, row = Math.floor(i / 2), cardW = (IW - 10) / 2;
    const x = PAD + col * (cardW + 10), y = insideY + 18 + row * 54;
    doc.rect(x, y, cardW, 46).fill(CARD2); doc.rect(x, y, 2, 46).fill(GREEN);
    doc.fontSize(9.5).fillColor(WHITE).font('Helvetica-Bold').text(title, x + 14, y + 8, { width: cardW - 24 });
    doc.fontSize(8).fillColor(GREY).font('Helvetica').text(desc, x + 14, y + 26, { width: cardW - 24 });
  });
  footer();

  doc.addPage(); bg(); pageHeader("Why It's Not Working");
  heroBlock("WHY IT'S", "NOT WORKING");
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
  [['THE SHAPE THAT WORKS FOR YOU', content.styleDNA?.silhouette || '', GREEN], ['HOW THINGS SHOULD FIT', content.styleDNA?.fitLanguage || '', GREEN], ['FABRICS WORTH SPENDING ON', content.styleDNA?.fabrics || '', GREEN], ['HOW TO USE YOUR COLOURS', content.styleDNA?.colourUsage || '', GREEN], ['STOP DOING THIS', content.styleDNA?.avoid || '', RED]].forEach(([label, text, accent]) => {
    const h = Math.max(textH(text, 9.5, 'Helvetica', IW - 28) + 32, 52);
    if (dnaY + h > PH - 40) return;
    lcard(PAD, dnaY, IW, h, accent);
    doc.fontSize(6.5).fillColor(accent).font('Helvetica-Bold').text(label, PAD + 14, dnaY + 10, { characterSpacing: 2 });
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica').text(text, PAD + 14, dnaY + 24, { width: IW - 28, lineGap: 3 });
    dnaY += h + 8;
  });
  footer();

  doc.addPage(); bg(); pageHeader('What To Buy First');
  heroBlock('WHAT TO', 'BUY FIRST');
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
  doc.fontSize(7).fillColor(RED).font('Helvetica-Bold').text('GET RID OF THESE NOW', PAD, neverY + 10, { characterSpacing: 2 });
  doc.fontSize(9.5).fillColor(MUTED).font('Helvetica').text(content.wardrobeBlueprint?.neverBuyAgain || '', PAD, neverY + 24, { width: IW, lineGap: 3 });
  footer();

  doc.addPage(); bg();
  const pieces = (content.recommendedPieces || []).slice(0, 9);
  pageHeader('Your Personal Edit');
  heroBlock(`${pieces.length} PIECES PICKED`, 'FOR YOU', 'Every piece chosen for your build, your colours and your budget — click any name to buy');
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
    doc.addPage(); bg(); pageHeader('Where To Spend Your Money');
    heroBlock('WHERE TO', 'SPEND YOUR MONEY', 'Four brands that deliver for your look and budget — shop these before anywhere else');
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
      subject: `Your ${styleIdentityName} Style Report is Ready`,
      headline: 'Your free style report is ready.',
      body: `Your <span style="color:#C8BFB5">${styleIdentityName}</span> style starter has been built — your style identity, colour palette and diagnosis, all based on your answers.`,
      downloadLabel: 'DOWNLOAD MY FREE REPORT →',
      upsell: `
        <div style="background:#B8A898;padding:20px 24px;margin:0 0 24px;text-align:center">
          <p style="color:#0A0A0A;font-size:10px;letter-spacing:3px;font-weight:700;margin:0 0 8px;text-transform:uppercase">⚡ 2-Hour Offer</p>
          <p style="color:#0A0A0A;font-size:15px;font-weight:700;margin:0 0 8px;line-height:1.4">Get the Premium blueprint for £4.99 — the price of Standard</p>
          <p style="color:#2A2010;font-size:12px;margin:0 0 16px;line-height:1.5">9 hand-picked products with links and prices, your full Style DNA, wardrobe blueprint, 4 brand picks and the never buy again list — all for £4.99. This offer expires in 2 hours.</p>
          <a href="${upgradeUrl}&tier=premium&sid=${sessionId}" style="display:inline-block;background:#0A0A0A;color:#F2EDE6;text-align:center;padding:14px 32px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;text-transform:uppercase">GET PREMIUM FOR £4.99 — 2 HRS ONLY →</a>
        </div>
        <div style="background:#111111;border:1px solid #2A2520;padding:16px 24px;margin:0 0 24px;text-align:center">
          <p style="color:#4A4440;font-size:11px;margin:0 0 8px;">After 2 hours, Premium is available at <span style="color:#B8A898">£9.99</span> · Standard at <span style="color:#B8A898">£4.99</span></p>
          <p style="color:#4A4440;font-size:11px;margin:0">Got a specific event coming up? <a href="https://occasions.outfitify.co.uk" style="color:#B8A898;text-decoration:none;">Occasion guides from £2.49 →</a></p>
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

// ── OCCASION GUIDES ──────────────────────────────────────────────────────────

app.post('/api/create-occasion-checkout', async (req, res) => {
  const { occasion, occasionName, budget, fit, occasionDetail, style, email } = req.body;
  if (!occasion || !email) return res.status(400).json({ error: 'Missing required fields' });

  const sessionId = crypto.randomBytes(16).toString('hex');
  const occasionData = { occasion, occasionName, budget, fit, occasionDetail, style, email, createdAt: Date.now() };
  saveFreeSession(`occ_${sessionId}`, occasionData);

  console.log(`Creating occasion checkout for ${occasion}, session ${sessionId}`);

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_creation: 'always',
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: `Outfitify — ${occasionName} Style Guide`,
            description: `Your personalised outfit guide for ${occasionName} — built around your build, budget and style.`,
            images: ['https://outfitify.co.uk/assets/images/image04.png']
          },
          unit_amount: 249
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || 'https://success.outfitify.co.uk'}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}&occasion=true`,
      cancel_url: `https://occasions.outfitify.co.uk`,
      metadata: {
        sessionId,
        tier: 'occasion',
        occasion,
        occasionName,
        budget: budget || '',
        fit: fit || '',
        occasionDetail: occasionDetail || '',
        style: style || '',
        email,
      },
    });
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Occasion checkout error:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
});

async function generateOccasionReport(sessionId, occasionData, userEmail) {
  activeJobs++;
  console.log(`Generating occasion report for ${occasionData.occasion}, session ${sessionId}... (active jobs: ${activeJobs})`);
  try {
    const products = await fetchProducts(occasionData.budget, occasionData.style);
    const reportContent = await generateOccasionContent(occasionData, products);
    const pdfPath = await buildOccasionPDF(reportContent, occasionData, products);
    const token = crypto.randomBytes(32).toString('hex');
    saveDownload(sessionId, { token, pdfPath, email: userEmail, quizData: occasionData, tier: 'occasion', createdAt: Date.now() });
    const downloadUrl = `${process.env.BASE_URL}/api/download/${token}`;
    await sendOccasionEmail(userEmail, downloadUrl, occasionData.occasionName, sessionId);
    console.log(`Occasion report ready for session ${sessionId}`);
  } catch (err) {
    console.error(`Occasion report generation failed for ${sessionId}:`, err);
  } finally {
    activeJobs--;
    console.log(`Occasion job done for ${sessionId}. Active jobs remaining: ${activeJobs}`);
  }
}

async function generateOccasionContent(occasionData, products) {
  const productSummary = [];
  for (const [cat, items] of Object.entries(products)) {
    items.slice(0, 3).forEach(p => productSummary.push({
      name: p['Item Name'], brand: p['Brand'], price: `£${p['Price']}`, url: p['Product URL'], category: cat,
    }));
  }

  const prompt = `You are a real personal stylist writing directly to a man who needs help dressing for a specific occasion. Write like a knowledgeable friend giving direct, honest, specific advice — not like a report being generated.

OCCASION: ${occasionData.occasionName}
OCCASION DETAIL: ${occasionData.occasionDetail}
BUDGET PER ITEM: ${occasionData.budget}
BUILD: ${occasionData.fit}
STYLE PREFERENCE: ${occasionData.style}

TONE RULES — CRITICAL:
- Write like a real person talking, not a document being generated
- Direct, warm, specific — like advice from a friend who knows about clothes
- Never use: system, intentional, cohesive, silhouette, taper, aesthetic, palette, framework, elevate, curated
- Replace any fashion jargon with plain English
- Every sentence must be specific to this person's occasion, build and budget
- Short punchy sentences — no waffle

STRICT PRODUCT RULES BY OCCASION — YOU MUST FOLLOW THESE:

DATE NIGHT:
- NO sportswear, gym wear, hoodies, joggers or trainers unless they are clean minimal court shoes
- YES to chinos, smart trousers, dark jeans, clean shirts, smart casual tops
- Shoes must be clean and considered — leather shoes, loafers or minimal clean trainers only

JOB INTERVIEW:
- NO trainers unless the industry is explicitly creative/startup
- NO casual t-shirts, hoodies, joggers or sportswear under any circumstances
- YES to smart trousers, chinos, shirts, smart casual jackets, formal shoes or clean minimal leather shoes
- Everything must look sharp and deliberate

FESTIVAL / SUMMER:
- NO joggers, formal trousers, heavy denim, thick knitwear, suits or formal shoes
- NO dark heavy fabrics — avoid black thick cotton, wool, heavyweight items
- YES to shorts, linen trousers, lightweight t-shirts, light overshirts, trainers, canvas shoes, sandals
- Fabrics must be lightweight — linen, lightweight cotton, jersey
- If no suitable summer product exists in the list, say so in the why field and suggest what to look for instead

SMART CASUAL WORK:
- NO sportswear, gym wear, hoodies or joggers
- YES to chinos, smart trousers, shirts, smart casual jackets, clean shoes
- Nothing too formal, nothing too casual

WEDDING GUEST:
- NO sportswear, trainers, casual t-shirts, hoodies or joggers
- YES to suits, smart trousers, dress shirts, smart shoes, loafers
- Must be occasion-appropriate — smart and considered

HOLIDAY / TRAVEL:
- NO formal trousers, suits, heavy fabrics or formal shoes
- YES to lightweight trousers, shorts, t-shirts, lightweight shirts, trainers, sandals, canvas shoes
- Practical and comfortable but still looks good

GENERAL PRODUCT RULES:
- If a product doesn't suit the occasion, DO NOT recommend it even if it's the only option in that category
- It is better to recommend 2 excellent products than 3 where one is wrong
- Never recommend joggers for any occasion except possibly a very casual festival or summer context
- Always check: would a real stylist actually suggest this for this specific occasion?

Generate JSON only, no markdown:
{
  "occasionTitle": "Short punchy title for this occasion e.g. 'Your Date Night Look'",
  "openingNote": "2-3 sentences written like a personal note from a stylist — acknowledge the specific occasion detail they gave, what the goal is for their look, and what you're going to give them. Warm and direct.",
  "whatToWear": {
    "headline": "One punchy sentence summarising the overall outfit direction",
    "outfitFormula": "3-4 sentences describing the complete outfit from top to bottom in plain English — specific to their build and the occasion. No jargon. Tell them exactly what to wear and why it works.",
    "fitAdvice": "2 sentences of specific fit advice for their build — what to look for and what to avoid when trying things on."
  },
  "whatToAvoid": "2-3 specific things to avoid for this occasion and their build — written like a friend telling them honestly what not to do. Specific, not generic.",
  "stylistTip": "One insider tip that most people don't know — specific to this occasion. Should feel like a genuine secret from someone who knows.",
  "recommendedPieces": [
    {
      "category": "category name",
      "name": "exact product name from the list",
      "brand": "brand",
      "price": "£XX",
      "url": "exact url",
      "why": "One sentence — why this specific piece works for their occasion and build"
    }
  ]
}

Pick the best 2-3 products from this list that genuinely suit this occasion. If fewer than 3 suitable products exist, only recommend the ones that are actually appropriate — quality over quantity:
${JSON.stringify(productSummary, null, 2)}

Rules:
- JSON only, no markdown
- recommendedPieces: 2-3 items maximum — only include products that genuinely suit the occasion
- Every field must be specific to the occasion and their answers
- Never sound like AI generated this
- If a product doesn't fit the occasion rules above, do not include it`;

  let parsed = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = message.content[0].text.trim();
      const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(text);
      console.log(`=== OCCASION CONTENT (attempt ${attempt}) ===`);
      console.log(JSON.stringify(parsed, null, 2));
      console.log('=== END ===');
      break;
    } catch (err) {
      lastError = err;
      console.error(`Occasion Claude parse failed attempt ${attempt}:`, err.message);
      if (attempt < 3) console.log('Retrying...');
    }
  }
  if (!parsed) throw new Error(`Occasion Claude failed after 3 attempts: ${lastError?.message}`);
  return parsed;
}

async function buildOccasionPDF(content, occasionData, products) {
  const pdfPath = path.join(os.tmpdir(), `outfitify-occasion-${Date.now()}.pdf`);
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
    doc.fontSize(7).fillColor(GREY).font('Helvetica').text('OUTFITIFY.CO.UK  ·  OCCASION STYLE GUIDE', 0, PH - 15, { width: PW, align: 'center', characterSpacing: 1 });
  }
  function lcard(x, y, w, h, accent) {
    doc.rect(x, y, w, h).fill(CARD);
    doc.rect(x, y, 2, h).fill(accent || GREEN);
  }
  function textH(str, fontSize, fontName, width) {
    doc.fontSize(fontSize).font(fontName || 'Helvetica');
    return doc.heightOfString(str || '', { width, lineGap: 2 });
  }
  function sectionLabel(text, y, color) {
    doc.fontSize(6.5).fillColor(color || GREEN).font('Helvetica-Bold').text(text, PAD, y, { characterSpacing: 3 });
    doc.moveTo(PAD, y + 12).lineTo(PAD + IW, y + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
  }

  // ── PAGE 1 ─────────────────────────────────────────────────────────────────
  bg();
  doc.rect(0, 40, PW, 180).fill('#0E0C0A');
  doc.moveTo(0, 220).lineTo(PW, 220).strokeColor(BORDER).lineWidth(0.5).stroke();
  pageHeader('Occasion Style Guide');

  // Hero
  doc.fontSize(9).fillColor(GREEN).font('Helvetica-Bold').text('YOUR STYLIST\'S VERDICT', PAD, 56, { characterSpacing: 3 });
  const titleParts = (content.occasionTitle || occasionData.occasionName).split(' ');
  const mid = Math.ceil(titleParts.length / 2);
  doc.fontSize(40).fillColor(WHITE).font('Helvetica-Bold').text(titleParts.slice(0, mid).join(' ').toUpperCase(), PAD, 76, { lineBreak: false });
  doc.fontSize(40).fillColor(GREEN).font('Helvetica-Bold').text(titleParts.slice(mid).join(' ').toUpperCase(), PAD, 118, { lineBreak: false });

  // Opening note
  const noteH = Math.max(textH(content.openingNote || '', 10, 'Helvetica', IW - 28) + 36, 80);
  lcard(PAD, 232, IW, noteH, GREEN);
  doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold').text('A NOTE FROM YOUR STYLIST', PAD + 14, 242, { characterSpacing: 2 });
  doc.fontSize(10).fillColor(MUTED).font('Helvetica').text(content.openingNote || '', PAD + 14, 258, { width: IW - 28, lineGap: 3 });

  // What to wear
  let curY = 232 + noteH + 24;
  sectionLabel('THE OUTFIT', curY);
  curY += 20;

  const headlineH = Math.max(textH(content.whatToWear?.headline || '', 13, 'Helvetica-Bold', IW - 28) + 28, 52);
  lcard(PAD, curY, IW, headlineH, GREEN);
  doc.fontSize(13).fillColor(WHITE).font('Helvetica-Bold').text(content.whatToWear?.headline || '', PAD + 14, curY + 14, { width: IW - 28, lineGap: 2 });
  curY += headlineH + 12;

  const formulaText = content.whatToWear?.outfitFormula || '';
  const formulaH = textH(formulaText, 10, 'Helvetica', IW) + 8;
  doc.fontSize(10).fillColor(MUTED).font('Helvetica').text(formulaText, PAD, curY, { width: IW, lineGap: 4 });
  curY += formulaH + 16;

  // Fit advice
  if (curY + 60 < PH - 80) {
    sectionLabel('FIT ADVICE FOR YOUR BUILD', curY);
    curY += 20;
    const fitH = Math.max(textH(content.whatToWear?.fitAdvice || '', 9.5, 'Helvetica', IW - 28) + 28, 52);
    lcard(PAD, curY, IW, fitH, GREEN);
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica').text(content.whatToWear?.fitAdvice || '', PAD + 14, curY + 14, { width: IW - 28, lineGap: 3 });
    curY += fitH + 16;
  }

  // What to avoid
  if (curY + 60 < PH - 80) {
    sectionLabel('WHAT TO AVOID', curY, RED);
    curY += 20;
    const avoidH = Math.max(textH(content.whatToAvoid || '', 9.5, 'Helvetica', IW - 28) + 28, 52);
    lcard(PAD, curY, IW, avoidH, RED);
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica').text(content.whatToAvoid || '', PAD + 14, curY + 14, { width: IW - 28, lineGap: 3 });
    curY += avoidH + 16;
  }

  // Stylist tip
  if (curY + 60 < PH - 80 && content.stylistTip) {
    sectionLabel('STYLIST\'S INSIDER TIP', curY);
    curY += 20;
    const tipH = Math.max(textH(content.stylistTip, 9.5, 'Helvetica', IW - 28) + 28, 52);
    doc.rect(PAD, curY, IW, tipH).fill(CARD2);
    doc.rect(PAD, curY, IW, tipH).strokeColor(GREEN).lineWidth(0.5).stroke();
    doc.fontSize(9.5).fillColor(MUTED).font('Helvetica').text(content.stylistTip, PAD + 14, curY + 14, { width: IW - 28, lineGap: 3 });
  }

  footer();

  // ── PAGE 2 — PRODUCT PICKS ─────────────────────────────────────────────────
  doc.addPage();
  bg();
  pageHeader('Your 3 Picks');

  doc.rect(0, 40, PW, 90).fill('#0E0C0A');
  doc.moveTo(0, 130).lineTo(PW, 130).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fontSize(24).fillColor(WHITE).font('Helvetica-Bold').text('3 PIECES PICKED', PAD, 52);
  doc.fontSize(24).fillColor(GREEN).font('Helvetica-Bold').text('FOR THIS OCCASION', PAD, 80);
  doc.fontSize(9).fillColor(GREY).font('Helvetica-Oblique').text(`Chosen for your build, your budget and ${occasionData.occasionName.toLowerCase()} — click any name to buy`, PAD, 118, { width: IW });

  const pieces = (content.recommendedPieces || []).slice(0, 3);
  const imageBuffers = await Promise.all(pieces.map(async piece => {
    let imageUrl = null;
    for (const catItems of Object.values(products)) {
      const match = catItems.find(p => p['Item Name'] === piece.name);
      if (match) { imageUrl = match['Image URL']; break; }
    }
    if (!imageUrl) return null;
    try { const r = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 5000 }); return Buffer.from(r.data); } catch { return null; }
  }));

  const CARD_H = 80, IMG_W = 68, IMG_PAD = 8;
  let pieceY = 148;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (pieceY + CARD_H > PH - 180) break;
    const tx = PAD + IMG_PAD + IMG_W + 12, priceColX = PAD + IW - 90, textW = priceColX - tx - 8;
    doc.rect(PAD, pieceY, IW, CARD_H).fill(CARD);
    doc.rect(PAD, pieceY, IW, CARD_H).strokeColor(BORDER).lineWidth(0.5).stroke();
    const imgY = pieceY + (CARD_H - IMG_W) / 2;
    if (imageBuffers[i]) {
      try { doc.save(); doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).clip(); doc.image(imageBuffers[i], PAD + IMG_PAD, imgY, { width: IMG_W, height: IMG_W, cover: [IMG_W, IMG_W] }); doc.restore(); }
      catch { doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).fill(CARD2); }
    } else { doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).fill(CARD2); }
    let productUrl = piece.url || null;
    if (!productUrl) { for (const catItems of Object.values(products)) { const match = catItems.find(p => p['Item Name'] === piece.name); if (match?.['Product URL']) { productUrl = match['Product URL']; break; } } }
    doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold').text((piece.category || '').toUpperCase(), tx, pieceY + 10, { width: textW, lineBreak: false, characterSpacing: 1.5 });
    doc.fontSize(11).fillColor(productUrl ? GREEN : WHITE).font('Helvetica-Bold').text(piece.name || '', tx, pieceY + 24, { width: textW, lineBreak: false, ...(productUrl ? { link: productUrl, underline: true } : {}) });
    doc.fontSize(8.5).fillColor(GREY).font('Helvetica').text(piece.why || '', tx, pieceY + 42, { width: textW, lineGap: 1.5 });
    doc.fontSize(16).fillColor(GREEN).font('Helvetica-Bold').text(piece.price || '', priceColX, pieceY + 16, { width: 88, align: 'right', lineBreak: false, ...(productUrl ? { link: productUrl } : {}) });
    doc.fontSize(8).fillColor(GREY).font('Helvetica').text(piece.brand || '', priceColX, pieceY + 38, { width: 88, align: 'right', lineBreak: false });
    pieceY += CARD_H + 6;
  }

  // Upsell CTA
  const ctaY = pieceY + 24;
  doc.rect(PAD, ctaY, IW, 130).fill(GREEN);
  doc.fontSize(11).fillColor(BG).font('Helvetica-Bold').text('WANT YOUR COMPLETE STYLE BLUEPRINT?', PAD + 20, ctaY + 16, { width: IW - 40, align: 'center', characterSpacing: 1 });
  doc.fontSize(13).fillColor(BG).font('Helvetica').text('Your full personal style consultation — colour guide, what suits your build, what to buy first and 5 hand-picked products. Everything in one place.', PAD + 20, ctaY + 40, { width: IW - 40, align: 'center', lineGap: 2 });
  doc.fontSize(24).fillColor(BG).font('Helvetica-Bold').text('From £4.99', PAD + 20, ctaY + 90, { width: IW - 40, align: 'center' });
  doc.fontSize(10).fillColor(BG).font('Helvetica').text('quiz.outfitify.co.uk', PAD + 20, ctaY + 116, { width: IW - 40, align: 'center', characterSpacing: 1 });

  footer();
  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(pdfPath));
    stream.on('error', reject);
  });
}

async function sendOccasionEmail(toEmail, downloadUrl, occasionName, sessionId) {
  const emailBody = {
    from: { address: 'outfitify@outfitify.co.uk', name: 'Outfitify' },
    to: [{ email_address: { address: toEmail } }],
    subject: `Your ${occasionName} Style Guide is Ready`,
    htmlbody: `
      <div style="background:#0A0A0A;padding:0;font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #2A2520">
        <div style="background:#111111;padding:28px 40px;border-bottom:1px solid #2A2520;text-align:center">
          <p style="color:#7A6E66;font-size:10px;letter-spacing:4px;margin:0 0 4px;text-transform:uppercase">Occasion Style Guide</p>
          <h1 style="color:#F2EDE6;font-size:14px;letter-spacing:5px;margin:0;font-weight:600">OUTFITIFY</h1>
        </div>
        <div style="padding:44px 40px">
          <h2 style="color:#F2EDE6;font-size:26px;font-weight:300;margin:0 0 12px;line-height:1.2">Your ${occasionName} guide is ready.</h2>
          <p style="color:#7A6E66;font-size:14px;line-height:1.7;margin:0 0 32px">Your personalised outfit guide has been put together based on your answers — what to wear, how it should fit your build, what to avoid, and 3 hand-picked products with links and prices.</p>
          <a href="${downloadUrl}" style="display:block;background:#F2EDE6;color:#0A0A0A;text-align:center;padding:16px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;margin:0 0 32px;text-transform:uppercase">DOWNLOAD MY STYLE GUIDE →</a>
          <div style="background:#111111;border:1px solid #2A2520;border-left:3px solid #B8A898;padding:24px;margin:0 0 24px">
            <p style="color:#B8A898;font-size:10px;letter-spacing:3px;font-weight:600;margin:0 0 10px;text-transform:uppercase">Want your complete style blueprint?</p>
            <p style="color:#C8BFB5;font-size:13px;line-height:1.7;margin:0 0 16px">Your full consultation covers everything — your colours, what works for your build, what to buy first and 5 hand-picked products. Free to start, full blueprint from £4.99.</p>
            <a href="https://quiz.outfitify.co.uk" style="display:block;background:#B8A898;color:#0A0A0A;text-align:center;padding:14px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;text-transform:uppercase">GET MY FULL BLUEPRINT — FROM £4.99 →</a>
          </div>
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
  console.log(`Occasion email sent to ${toEmail}:`, response.data);
}

// ── END OCCASION GUIDES ───────────────────────────────────────────────────────



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Outfitify backend running on port ${PORT}`));
