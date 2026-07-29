require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let activeJobs = 0;

// Derives gender from occasion slug — women's slugs all start with 'w-'
function genderFromOccasion(occasion) {
  return (occasion || '').startsWith('w-') ? 'womens' : 'mens';
}

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
    'https://women.outfitify.co.uk',
    'https://chipper-fairy-2f755d.netlify.app',
    /\.netlify\.app$/,
    'http://localhost:3000',
  ],
}));

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── SESSION / FILE HELPERS ────────────────────────────────────────────────────

const PERSIST_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.STORAGE_DIR || os.tmpdir();
if (PERSIST_DIR === os.tmpdir()) {
  console.warn('[WARNING] No persistent volume configured — PDFs and download links will be lost on every restart/redeploy. Set RAILWAY_VOLUME_MOUNT_PATH.');
}

const DOWNLOADS_DIR = path.join(PERSIST_DIR, 'outfitify-downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// Font files for PDF generation — place the 6 .ttf files in a /fonts folder in your repo
// Font files currently live at the repo root (not in a /fonts subfolder) —
// pointing directly at __dirname to match where they actually are, rather
// than requiring a folder move in GitHub
const FONTS_DIR = __dirname;

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

const FREE_SESSIONS_DIR = path.join(PERSIST_DIR, 'outfitify-free-sessions');
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

// ── V3 USERS — tracks free-guide usage, unlimited status and guide count per email ──
// One JSON file per email (hashed for a filesystem-safe, case/whitespace-normalised key)

const USERS_DIR = path.join(PERSIST_DIR, 'outfitify-users');
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

const UNLIMITED_GUIDE_CAP = 50; // soft cap, backend safety net only — not customer-facing

function emailKey(email) {
  return crypto.createHash('sha256').update((email || '').trim().toLowerCase()).digest('hex');
}

function getUserRecord(email) {
  const p = path.join(USERS_DIR, `${emailKey(email)}.json`);
  if (!fs.existsSync(p)) return { email, freeUsed: false, unlimitedPaid: false, guideCount: 0 };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { email, freeUsed: false, unlimitedPaid: false, guideCount: 0 };
  }
}

function saveUserRecord(email, record) {
  const p = path.join(USERS_DIR, `${emailKey(email)}.json`);
  fs.writeFileSync(p, JSON.stringify({ ...record, email, updatedAt: Date.now() }));
}

function incrementGuideCount(email) {
  const record = getUserRecord(email);
  record.guideCount = (record.guideCount || 0) + 1;
  saveUserRecord(email, record);
  return record;
}

// ── FETCH PRODUCTS (v2) ───────────────────────────────────────────────────────

async function fetchOccasionProducts(occasion, budget, fit, gender = 'mens') {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetId = gender === 'womens'
    ? (process.env.WOMEN_SHEET_ID || process.env.GOOGLE_SHEET_ID)
    : process.env.GOOGLE_SHEET_ID;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: gender === 'womens' ? 'Womens!A:J' : 'Mens!A:J',
  });

  const rows = response.data.values;
  if (!rows || rows.length < 2) throw new Error('No product data in sheet');

  const headers = rows[0];
  const allProducts = rows.slice(1)
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = (row[i] || '').trim());
      return obj;
    })
    .filter(p => p['Item Name']);

  console.log(`[fetchOccasionProducts] Total: ${allProducts.length} | occasion=${occasion} budget=${budget} fit=${fit}`);

  function budgetToTier(b) {
    if (!b) return 'Budget';
    const bl = b.toLowerCase();
    if (bl.includes('under') || (bl.includes('30') && !bl.includes('60'))) return 'Budget';
    if (bl.includes('100+') || bl.includes('premium')) return 'Premium';
    return 'Mid';
  }

  function fitToTier(f) {
    if (!f) return 'Standard';
    const fl = f.toLowerCase();
    if (fl.includes('petite')) return 'Petite';
    if (fl.includes('tall')) return 'Tall';
    if (fl.includes('curvy')) return 'Curvy';
    if (fl.includes('standard')) return 'Standard';
    if (fl.includes('slim') || fl.includes('lean')) return 'Slim';
    if (fl.includes('athletic') || fl.includes('muscular')) return 'Athletic';
    if (fl.includes('bigger') || fl.includes('broader')) return 'Regular';
    return 'Standard';
  }

  const budgetTier = budgetToTier(budget);
  const fitTier = fitToTier(fit);
  console.log(`[fetchOccasionProducts] budgetTier=${budgetTier} fitTier=${fitTier}`);

  const slugToDbOccasion = {
    'date-night':           'date night',
    'job-interview':        'job interview',
    'festival':             'festival',
    'summer-holiday':       'summer holiday',
    'wedding-guest':        'wedding',
    'night-out':            'night out',
    'smart-casual-work':    'smart casual work',
    'holiday-travel':       'summer holiday',
    'w-date-night':         'date night',
    'w-job-interview':      'job interview',
    'w-wedding-guest':      'wedding guest',
    'w-girls-night-out':    'girls night out',
    'w-brunch':             'brunch',
    'w-summer-holiday':     'summer holiday',
    'w-festival':           'festival',
  };

  function matchesOccasion(product, target) {
    const mappedTarget = slugToDbOccasion[target] || target.toLowerCase();
    return (product['Occasion'] || '')
      .split(',')
      .map(o => o.trim().toLowerCase())
      .some(o => o === mappedTarget);
  }

  function matchesFit(product, target) {
    const pf = (product['Fit'] || '').trim().toLowerCase();
    return pf === 'all' || pf === 'standard' || pf === target.toLowerCase();
  }

  // Season column exists in the sheet but was never being used — this was
  // why summer date-night guides could still recommend a wool jumper.
  // Blank Season = year-round staple, always matches. Supports comma-separated
  // values e.g. "Spring, Summer" the same way the Occasion column does.
  function matchesSeason(product, target) {
    const raw = (product['Season'] || '').trim();
    if (!raw) return true; // no season tagged = works year-round
    return raw.split(',').map(s => s.trim().toLowerCase()).some(s => s === target.toLowerCase());
  }

  const BUDGET_ORDER = ['Budget', 'Mid', 'Premium'];
  function budgetCascade(pool, tier) {
    const idx = BUDGET_ORDER.indexOf(tier);
    let result = pool.filter(p => (p['Budget'] || '').trim() === tier);
    if (result.length >= 2) return result;
    const adjacent = [BUDGET_ORDER[idx - 1], BUDGET_ORDER[idx + 1]].filter(Boolean);
    result = pool.filter(p => {
      const pb = (p['Budget'] || '').trim();
      return pb === tier || adjacent.includes(pb);
    });
    if (result.length >= 2) return result;
    return pool;
  }

  const CATEGORIES = gender === 'womens'
    ? ['Top', 'Bottoms', 'Dress', 'Jacket', 'Shoes', 'Accessory']
    : ['Top', 'Bottoms', 'Shoes', 'Jacket', 'Hoodie/Jacket', 'Accessory'];
  const selected = {};

  const currentSeason = getCurrentSeason();
  console.log(`[fetchOccasionProducts] currentSeason=${currentSeason}`);

  // Season-filtered first, same cascade philosophy as budget: prefer a
  // seasonally-correct match, but never leave a category empty if the
  // sheet is thin on season-tagged stock for it
  const occasionFitSeasonPool = allProducts.filter(p => matchesOccasion(p, occasion) && matchesFit(p, fitTier) && matchesSeason(p, currentSeason));
  const occasionFitPool  = allProducts.filter(p => matchesOccasion(p, occasion) && matchesFit(p, fitTier));
  const occasionOnlyPool = allProducts.filter(p => matchesOccasion(p, occasion));

  CATEGORIES.forEach(cat => {
    // Prefer season+occasion+fit match first; fall back progressively,
    // dropping the season filter before dropping fit, and fit before occasion
    let pool = occasionFitSeasonPool.filter(p => p['Category'] === cat);
    if (pool.length < 2) pool = occasionFitPool.filter(p => p['Category'] === cat);
    if (pool.length < 2) pool = occasionOnlyPool.filter(p => p['Category'] === cat);

    const budgeted = budgetCascade(pool, budgetTier);
    selected[cat] = budgeted.sort(() => Math.random() - 0.5).slice(0, 6);
    console.log(`[fetchOccasionProducts] ${cat}: ${selected[cat].length} products`);
  });

  return selected;
}

// ── OCCASION CHECKOUT ─────────────────────────────────────────────────────────

// ── V3 USER STATUS CHECK ───────────────────────────────────────────────────────
// Lightweight, read-only — lets the frontend show the real pricing state
// (free available / already used / unlimited) before the customer commits,
// instead of only finding out at checkout time

app.get('/api/user-status', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const user = getUserRecord(email);
  res.json({
    freeUsed: !!user.freeUsed,
    unlimitedPaid: !!user.unlimitedPaid,
    guideCount: user.guideCount || 0,
  });
});

app.post('/api/create-occasion-checkout', async (req, res) => {
  const { occasion, occasionName, budget, fit, occasionDetail, occasionDetail2, style, email } = req.body;
  if (!occasion || !email) return res.status(400).json({ error: 'Missing required fields' });

  const gender = genderFromOccasion(occasion);
  const user = getUserRecord(email);

  const occasionData = {
    occasion, occasionName, budget, fit, occasionDetail, occasionDetail2, style, email, gender,
  };

  // ── PATH 1: Unlimited pass holder — generate directly, no payment ──
  if (user.unlimitedPaid) {
    if (user.guideCount >= UNLIMITED_GUIDE_CAP) {
      console.warn(`[V3] ${email} hit the unlimited guide cap (${UNLIMITED_GUIDE_CAP})`);
      return res.status(403).json({
        error: 'guide_cap_reached',
        message: "You've reached the fair use limit on your unlimited pass. Drop us a line at hello@outfitify.co.uk and we'll sort you out.",
      });
    }

    const sessionId = crypto.randomBytes(16).toString('hex');
    saveFreeSession(`occ_${sessionId}`, { ...occasionData, createdAt: Date.now() });
    res.json({ free: true, sessionId });

    generateOccasionReport(sessionId, occasionData, email, { isFree: false })
      .then(() => incrementGuideCount(email))
      .catch(err => console.error(`Unlimited-tier report failed ${sessionId}:`, err));
    return;
  }

  // ── PATH 2: First guide ever for this email — free, no payment ──
  if (!user.freeUsed) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    saveFreeSession(`occ_${sessionId}`, { ...occasionData, createdAt: Date.now() });
    res.json({ free: true, sessionId });

    generateOccasionReport(sessionId, occasionData, email, { isFree: true })
      .then(() => {
        // Only mark the free guide as used once it's actually been delivered —
        // a failed generation (e.g. a server error) should never burn the
        // customer's free guide with nothing to show for it
        saveUserRecord(email, { ...getUserRecord(email), freeUsed: true });
        incrementGuideCount(email);
      })
      .catch(err => console.error(`Free-tier report failed ${sessionId}:`, err));
    return;
  }

  // ── PATH 3: Already used free guide, not on unlimited — pay £2.49 for this one ──
  const sessionId = crypto.randomBytes(16).toString('hex');
  saveFreeSession(`occ_${sessionId}`, { ...occasionData, createdAt: Date.now() });

  console.log(`Occasion checkout (single, £2.49): ${occasion}, session ${sessionId}`);

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_creation: 'always',
      customer_email: email, // locks the checkout email to the quiz email so it can't drift from what freeUsed/unlimitedPaid is keyed on
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: `Outfitify — ${occasionName} Style Guide`,
            description: `Your personalised outfit guide for ${occasionName} — built around your build, budget and style.`,
            images: ['https://outfitify.co.uk/assets/images/image04.png'],
          },
          unit_amount: 249,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || 'https://success.outfitify.co.uk'}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}&occasion=true&value=2.49`,
      cancel_url: 'https://occasions.outfitify.co.uk',
      metadata: {
        sessionId, tier: 'occasion', occasion, occasionName,
        budget: budget || '', fit: fit || '',
        occasionDetail: occasionDetail || '',
        occasionDetail2: occasionDetail2 || '',
        style: style || '', email, gender,
      },
    });
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Occasion checkout error:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
});

// ── UNLIMITED CHECKOUT (V3) ────────────────────────────────────────────────────
// One-time £9.99 payment, unlocks unlimited guides (soft-capped at 50, backend-only).
// Same body shape as create-occasion-checkout — used when a customer chooses
// to go unlimited rather than pay per single guide.

app.post('/api/create-unlimited-checkout', async (req, res) => {
  const { occasion, occasionName, budget, fit, occasionDetail, occasionDetail2, style, email } = req.body;
  if (!occasion || !email) return res.status(400).json({ error: 'Missing required fields' });

  const gender = genderFromOccasion(occasion);
  const occasionData = { occasion, occasionName, budget, fit, occasionDetail, occasionDetail2, style, email, gender };
  const user = getUserRecord(email);

  // ── Already on unlimited — never charge again, generate directly ──
  if (user.unlimitedPaid) {
    if (user.guideCount >= UNLIMITED_GUIDE_CAP) {
      console.warn(`[V3] ${email} hit the unlimited guide cap (${UNLIMITED_GUIDE_CAP}) via unlimited-checkout route`);
      return res.status(403).json({
        error: 'guide_cap_reached',
        message: "You've reached the fair use limit on your unlimited pass. Drop us a line at hello@outfitify.co.uk and we'll sort you out.",
      });
    }

    const sessionId = crypto.randomBytes(16).toString('hex');
    saveFreeSession(`occ_${sessionId}`, { ...occasionData, createdAt: Date.now() });
    res.json({ free: true, sessionId, alreadyUnlimited: true });

    generateOccasionReport(sessionId, occasionData, email, { isFree: false })
      .then(() => incrementGuideCount(email))
      .catch(err => console.error(`Unlimited-repeat report failed ${sessionId}:`, err));
    return;
  }

  const sessionId = crypto.randomBytes(16).toString('hex');
  saveFreeSession(`occ_${sessionId}`, { ...occasionData, createdAt: Date.now() });

  console.log(`Unlimited checkout: ${occasion}, session ${sessionId}`);

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_creation: 'always',
      customer_email: email, // locks the checkout email to the quiz email so it can't drift from what freeUsed/unlimitedPaid is keyed on
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: 'Outfitify — Unlimited Guides',
            description: 'Unlimited personalised style guides, forever. One-time payment, no subscription.',
            images: ['https://outfitify.co.uk/assets/images/image04.png'],
          },
          unit_amount: 999,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || 'https://success.outfitify.co.uk'}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}&unlimited=true&value=9.99`,
      cancel_url: 'https://occasions.outfitify.co.uk',
      metadata: {
        sessionId, tier: 'unlimited', occasion, occasionName,
        budget: budget || '', fit: fit || '',
        occasionDetail: occasionDetail || '',
        occasionDetail2: occasionDetail2 || '',
        style: style || '', email, gender,
      },
    });
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Unlimited checkout error:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
});

// ── BUNDLE CHECKOUT (legacy — kept intact, no longer used by the V3 pricing ladder) ──

app.post('/api/create-bundle-checkout', async (req, res) => {
  const { occasions, bundleSize, email } = req.body;
  if (!occasions || !Array.isArray(occasions) || occasions.length < 2 || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const size = Math.min(Math.max(parseInt(bundleSize) || occasions.length, 2), 3);
  const priceMap  = { 2: 399, 3: 499 };
  const labelMap  = { 2: '2-Guide Bundle', 3: '3-Guide Bundle' };
  const unitAmount = priceMap[size] || 399;
  const occasionNames = occasions.map(o => o.name || o.slug).join(', ');

  const sessionId = crypto.randomBytes(16).toString('hex');
  saveFreeSession(`bundle_${sessionId}`, { occasions, bundleSize: size, email, createdAt: Date.now() });

  console.log(`Bundle checkout: ${size} guides (${occasionNames}), session ${sessionId}`);

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_creation: 'always',
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: `Outfitify — ${labelMap[size]}: ${occasionNames}`,
            description: `${size} personalised occasion style guides — built around your build, budget and style.`,
            images: ['https://outfitify.co.uk/assets/images/image04.png'],
          },
          unit_amount: unitAmount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || 'https://success.outfitify.co.uk'}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}&bundle=true&bundleSize=${size}&value=${(unitAmount/100).toFixed(2)}`,
      cancel_url: 'https://occasions.outfitify.co.uk',
      metadata: {
        sessionId, tier: 'bundle', bundleSize: String(size), email,
      },
    });
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Bundle checkout error:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
});

// ── WEBHOOK ───────────────────────────────────────────────────────────────────

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
    // IMPORTANT: metadata.email (the email entered in the quiz) is the source
    // of truth for the app's free/paid/unlimited logic — it must win over
    // whatever the customer typed into the Stripe Checkout email field, or a
    // customer who uses a different email at checkout than in the quiz gets
    // their unlimited/free status recorded against the wrong account entirely
    const userEmail = session.metadata.email || session.customer_details?.email || session.customer_email || null;
    const tier = session.metadata.tier || 'occasion';

    console.log(`Webhook: tier=${tier} session=${sessionId} email=${userEmail}`);
    if (!userEmail) console.error(`No email for session ${sessionId}`);

    if (tier === 'unlimited') {
      // Mark this email as an unlimited pass holder, then generate the
      // occasion guide they were actually trying to get when they upgraded
      const record = getUserRecord(userEmail);
      saveUserRecord(userEmail, { ...record, freeUsed: true, unlimitedPaid: true });

      const occasion = session.metadata.occasion;
      const gender = session.metadata.gender || genderFromOccasion(occasion);
      generateOccasionReport(sessionId, {
        occasion,
        occasionName:    session.metadata.occasionName,
        budget:          session.metadata.budget,
        fit:             session.metadata.fit,
        occasionDetail:  session.metadata.occasionDetail,
        occasionDetail2: session.metadata.occasionDetail2,
        style:           session.metadata.style,
        gender,
      }, userEmail, { isFree: false })
        .then(() => incrementGuideCount(userEmail))
        .catch(err => console.error(`Unlimited-upgrade error ${sessionId}:`, err));

    } else if (tier === 'bundle') {
      const bundleSession = getFreeSession(`bundle_${sessionId}`);
      const occasions = bundleSession?.occasions || [];
      if (!occasions.length) console.error(`Bundle: no occasions data found for session ${sessionId}`);
      generateBundleReports(sessionId, { occasions }, userEmail)
        .catch(err => console.error(`Bundle error ${sessionId}:`, err));

    } else if (tier === 'occasion') {
      const occasion = session.metadata.occasion;
      const gender = session.metadata.gender || genderFromOccasion(occasion);
      generateOccasionReport(sessionId, {
        occasion,
        occasionName:    session.metadata.occasionName,
        budget:          session.metadata.budget,
        fit:             session.metadata.fit,
        occasionDetail:  session.metadata.occasionDetail,
        occasionDetail2: session.metadata.occasionDetail2,
        style:           session.metadata.style,
        gender,
      }, userEmail, { isFree: false })
        .then(() => incrementGuideCount(userEmail))
        .catch(err => console.error(`Occasion error ${sessionId}:`, err));

    } else {
      generateAndStoreReport(sessionId, {
        budget:    session.metadata.budget,
        struggles: session.metadata.struggles,
        lifestyle: session.metadata.lifestyle,
        goal:      session.metadata.goal,
        fit:       session.metadata.fit,
      }, userEmail, tier).catch(err => console.error(`Blueprint error ${sessionId}:`, err));
    }
  }

  res.json({ received: true });
});

// ── DOWNLOAD / STATUS ─────────────────────────────────────────────────────────

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
    res.setHeader('Content-Disposition', 'attachment; filename="Outfitify-Style-Guide.pdf"');
    return fs.createReadStream(data.pdfPath).pipe(res);
  }
  res.status(404).json({ error: 'Download link not found or expired' });
});

// ── GENERATE SINGLE OCCASION REPORT ──────────────────────────────────────────

async function generateOccasionReport(sessionId, occasionData, userEmail, options = {}) {
  const isFree = !!options.isFree;
  activeJobs++;
  console.log(`Generating occasion report: ${occasionData.occasion} session=${sessionId} isFree=${isFree} (active=${activeJobs})`);
  try {
    const gender = occasionData.gender || genderFromOccasion(occasionData.occasion);
    const products = await fetchOccasionProducts(occasionData.occasion, occasionData.budget, occasionData.fit, gender);
    const reportContent = await generateOccasionContent(occasionData, products);
    const pdfPath = await buildOccasionPDF(reportContent, occasionData, products);
    const token = crypto.randomBytes(32).toString('hex');
    saveDownload(sessionId, { token, pdfPath, email: userEmail, quizData: occasionData, tier: 'occasion', createdAt: Date.now() });
    const downloadUrl = `${process.env.BASE_URL}/api/download/${token}`;
    await sendOccasionEmail(userEmail, downloadUrl, occasionData.occasionName, sessionId, isFree);
    console.log(`Occasion report ready: ${sessionId}`);
  } catch (err) {
    console.error(`Occasion report failed ${sessionId}:`, err);
  } finally {
    activeJobs--;
    console.log(`Job done ${sessionId}. Active: ${activeJobs}`);
  }
}

// ── GENERATE BUNDLE REPORTS ───────────────────────────────────────────────────

async function generateBundleReports(sessionId, bundleData, userEmail) {
  activeJobs++;
  const { occasions } = bundleData;
  console.log(`Generating bundle: ${occasions.length} guides, session=${sessionId} (active=${activeJobs})`);

  const results = [];

  for (const occ of occasions) {
    const occasionData = {
      occasion:        occ.slug,
      occasionName:    occ.name,
      budget:          occ.budget          || '',
      fit:             occ.fit             || '',
      occasionDetail:  occ.occasionDetail  || '',
      occasionDetail2: occ.occasionDetail2 || '',
      style:           occ.style           || '',
    };
    try {
      console.log(`Bundle: generating ${occ.name} (budget=${occ.budget}, fit=${occ.fit})...`);
      const gender = occ.gender || genderFromOccasion(occ.slug);
      const products = await fetchOccasionProducts(occ.slug, occ.budget, occ.fit, gender);
      const reportContent = await generateOccasionContent(occasionData, products);
      const pdfPath = await buildOccasionPDF(reportContent, occasionData, products);
      const token = crypto.randomBytes(32).toString('hex');
      const subSessionId = `${sessionId}_${occ.slug}`;
      saveDownload(subSessionId, { token, pdfPath, email: userEmail, quizData: occasionData, tier: 'bundle', createdAt: Date.now() });
      const downloadUrl = `${process.env.BASE_URL}/api/download/${token}`;
      results.push({ occasionName: occ.name, downloadUrl, success: true });
      console.log(`Bundle: ${occ.name} done`);
    } catch (err) {
      console.error(`Bundle: ${occ.name} failed:`, err.message);
      results.push({ occasionName: occ.name, downloadUrl: null, success: false });
    }
  }

  saveDownload(sessionId, { token: crypto.randomBytes(32).toString('hex'), bundle: true, results, email: userEmail, createdAt: Date.now() });

  const successful = results.filter(r => r.success);
  if (successful.length > 0) await sendBundleEmail(userEmail, successful, sessionId);

  activeJobs--;
  console.log(`Bundle complete ${sessionId}: ${successful.length}/${occasions.length} succeeded. Active: ${activeJobs}`);
}

// ── CLAUDE: GENERATE OCCASION CONTENT ────────────────────────────────────────

// Derives current UK season from today's date — used to keep fabric/layering
// advice realistic (no cable knits recommended in July, no linen in January)
function getCurrentSeason() {
  const month = new Date().getMonth() + 1; // 1-12
  if (month >= 3 && month <= 5) return 'Spring';
  if (month >= 6 && month <= 8) return 'Summer';
  if (month >= 9 && month <= 11) return 'Autumn';
  return 'Winter';
}

// Catches a real, recurring content-accuracy bug: the AI describing a product
// in occasionTitle/whatToWear (e.g. "chunky trainers and an ecru bucket hat")
// that was never actually included in recommendedPieces — leaving the
// customer reading about an item they have no way to buy from the guide.
// Reordering the JSON schema (recommendedPieces before whatToWear) reduced
// this but did not eliminate it, so this checks the actual output rather
// than just instructing the model not to do it.
const CATEGORY_KEYWORDS = {
  shoes: ['trainer', 'trainers', 'shoe', 'shoes', 'boot', 'boots', 'loafer', 'loafers', 'sandal', 'sandals', 'sneaker', 'sneakers', 'slider', 'sliders', 'wellies', 'flip flop', 'flip-flop'],
  jacket: ['jacket', 'blazer', 'harrington', 'bomber', 'coat', 'overshirt', 'cardigan'],
  accessory: ['hat', 'cap', 'bucket hat', 'sunglasses', 'shades', 'sunnies', 'watch', 'belt', 'necklace', 'bracelet', 'bag', 'scarf', 'tie'],
};

function findCategoryMismatches(parsed) {
  const pickedCategories = new Set((parsed.recommendedPieces || []).map(p => (p.category || '').toLowerCase()));
  const hasCategory = (key) => {
    if (key === 'jacket') return [...pickedCategories].some(c => c.includes('jacket') || c === 'hoodie/jacket');
    return [...pickedCategories].some(c => c === key);
  };
  const textToCheck = [
    parsed.occasionTitle,
    parsed.whatToWear?.headline,
    parsed.whatToWear?.outfitFormula,
  ].filter(Boolean).join(' ').toLowerCase();

  const violations = [];
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (hasCategory(category)) continue; // genuinely picked — fine to mention
    const hit = keywords.find(kw => new RegExp(`\\b${kw.replace(/[- ]/g, '[- ]?')}\\b`, 'i').test(textToCheck));
    if (hit) violations.push(`${category} (matched "${hit}")`);
  }
  return violations;
}

async function generateOccasionContent(occasionData, products) {
  const productList = [];
  for (const [cat, items] of Object.entries(products)) {
    items.forEach(p => productList.push({
      category: cat,
      name:     p['Item Name'],
      brand:    p['Brand'],
      price:    `£${p['Price']}`,
      url:      p['Product URL'],
    }));
  }

  const occasionRules = {
    'date-night': `
DATE NIGHT RULES:
- NO sportswear, gym wear, hoodies, joggers or casual trainers
- NO graphic tees or logo-heavy pieces
- Shoes must be clean and considered — leather shoes, loafers or clean minimal court trainers only
- Smart casual minimum — chinos, dark jeans, clean shirts, quality basics
- LAYERING: For restaurant dates always recommend a jacket layer — an unstructured blazer or lightweight jacket worn open over the shirt. This is what separates looking nice from looking like you put actual thought in. Only skip the jacket for very casual dates (drinks, coffee)
- occasionDetail2 is whether they have met this person before — first time = slightly more considered and sharp; been together a while = relaxed confidence but still put together`,

    'job-interview': `
JOB INTERVIEW RULES:
- NO trainers unless industry (occasionDetail) is explicitly creative or startup
- NO casual t-shirts, hoodies, joggers or sportswear under any circumstances
- NO loud colours, bold patterns or graphics
- Smart trousers, chinos, shirts, blazers, formal or clean minimal leather shoes only
- LAYERING: Always recommend a blazer or jacket layer for interviews — it is almost never wrong and signals you take it seriously
- occasionDetail is the industry — corporate = sharper and more formal, creative = smarter casual with personality
- occasionDetail2 is seniority — entry level can be smart casual, mid level should have a blazer, senior or management should be noticeably sharper and more considered`,

    'festival': `
FESTIVAL RULES:
- NO joggers, formal trousers, heavy denim, thick knitwear, suits or formal shoes
- NO dark heavy fabrics — no thick black cotton, wool or heavyweight items
- Lightweight fabrics only — linen, lightweight cotton, jersey
- Shorts, linen trousers, lightweight t-shirts, light shirts, trainers, canvas shoes, sandals only
- LAYERING: For multi-day festivals always recommend a lightweight shirt worn open over a tee — festival evenings get cold and having a layer is practical and looks good. Keep it lightweight — nothing heavy
- occasionDetail is the TYPE of festival — use it to calibrate the look:
  - Grassroots or indie (muddy fields, camping): practical is key — boots or sturdy trainers, cargo shorts or relaxed trousers, layers
  - Major festival (Glastonbury, Reading, Leeds): balance of practical and stylish — clean trainers, shorts or slim jeans, lightweight layer
  - Day festival (no camping, one day): more style-led, less practical — cleaner fits, better footwear, can be slightly smarter
  - Urban festival (city-based, smarter crowd): closest to a night out — cleaner trainers or boots, smarter shorts or slim trousers
- occasionDetail2 is duration — multi-day means practical layering matters more, one day means you can keep it simpler`,

    'wedding-guest': `
WEDDING GUEST RULES:
- NO sportswear, trainers, casual t-shirts, hoodies or joggers under any circumstances
- Smart and occasion-appropriate always
- LAYERING: Always recommend a jacket or blazer — it is a wedding, showing up without one reads underdressed
- occasionDetail is dress code — match formality accordingly. Black tie = suit or tuxedo. Smart or lounge suit = full suit. Smart casual = blazer and smart trousers minimum. Garden party = blazer or unstructured jacket
- occasionDetail2 is suit ownership: if they own a good one advise on how to style and accessorise it; if old or cheap advise on which pieces to upgrade first (shirt, shoes, or tie); if no suit at all advise on smart trousers and a blazer as the alternative`,

    'night-out': `
NIGHT OUT RULES:
- occasionDetail is venue type — use it to set formality level:
  - Casual bars: smart casual, clean trainers fine
  - Club night: smarter, dark jeans or trousers, clean shoes, no sportswear
  - Restaurant then bars: smart casual minimum, no trainers, consider a jacket layer
  - House party: relaxed but considered, clean trainers fine
- LAYERING: For restaurant then bars always recommend a jacket layer. For club nights a bomber or lightweight jacket works. For casual bars optional
- occasionDetail2 is time — all day session needs something practical and comfortable that holds up; late start means sharp from the off
- No formal suits unless venue is explicitly black tie
- No sportswear or gym wear ever`,

    'smart-casual-work': `
SMART CASUAL WORK RULES:
- NO sportswear, gym wear, hoodies or joggers ever
- LAYERING: For office or hybrid always recommend a jacket or smart overshirt layer — it immediately makes the look more considered and gives them something to take off
- occasionDetail and occasionDetail2 are both about work location — office full time needs the sharpest look, hybrid is slightly more relaxed, WFH with occasional office days can be the most relaxed but still needs to look intentional on camera
- Chinos, smart trousers, shirts, smart casual jackets, clean shoes always`,

    'summer-holiday': `
SUMMER HOLIDAY RULES:
- NO formal trousers, suits, heavy fabrics, thick denim or formal shoes
- Lightweight and practical but still looks good
- LAYERING: Recommend one lightweight shirt or overshirt for evenings — even on hot holidays the temperature drops after dinner and having a layer means you are not stuck in a t-shirt all night
- occasionDetail is destination — beach or resort = shorts and tees and sandals; city break = slightly smarter, linen trousers, clean trainers; long-haul = comfort for travel plus versatile pieces
- occasionDetail2 is trip length — longer trips need more versatile pieces that work across multiple outfits, not one-wear pieces
- Shorts, linen trousers, lightweight t-shirts, lightweight shirts, trainers, sandals, canvas shoes only`,

    'holiday-travel': `
HOLIDAY / TRAVEL RULES:
- NO formal trousers, suits, heavy fabrics or formal shoes
- Lightweight and practical but still looks good
- occasionDetail is destination — beach vs city break vs long-haul all need different approaches
- occasionDetail2 is trip length — longer trips need more versatile pieces`,

    'w-date-night': `
WOMEN'S DATE NIGHT RULES:
- This is a women's styling guide — all advice must be relevant to women's fashion
- NO sportswear, gym wear, hoodies, joggers or overly casual pieces
- occasionDetail is the type of date — restaurant = dressier, drinks = more relaxed, first date = put-together but not overdressed
- occasionDetail2 is whether they have met this person before — first time = slightly more considered; been together a while = relaxed confidence
- Body shape guidance:
  - Petite: midi length dresses and skirts create leg length. Monochrome outfits elongate. Avoid oversized or heavy layers that swamp the frame
  - Tall: can wear any length. Maxi dresses and wide leg trousers work well. Bold prints work on a taller frame
  - Curvy: wrap dresses and A-line skirts define the waist. Empire waists work well. Avoid boxy or shapeless fits
  - Standard: most styles work — focus on what suits the occasion rather than body-specific rules
- Dresses, midi skirts, smart trousers, fitted tops, heels, block heels, clean trainers for casual dates`,

    'w-job-interview': `
WOMEN'S JOB INTERVIEW RULES:
- This is a women's styling guide — all advice must be relevant to women's fashion
- NO casual t-shirts, hoodies, joggers or sportswear under any circumstances
- NO overly revealing, tight or short pieces — professional always
- occasionDetail is the industry — corporate = sharp and formal, creative = smart but with personality, startup = smart casual
- occasionDetail2 is seniority — entry level can be smart casual, senior should be noticeably sharper
- Body shape guidance:
  - Petite: tailored pieces in one tone create a longer line. Avoid wide leg trousers that overwhelm
  - Tall: can carry wide leg trousers and longer blazers beautifully
  - Curvy: wrap tops and fit-and-flare silhouettes. Structured blazers define shape
  - Standard: tailored trouser suit, shirt dress or smart midi skirt with a blouse
- Tailored trousers, blazers, shirt dresses, midi skirts, blouses, heels or smart flats only`,

    'w-wedding-guest': `
WOMEN'S WEDDING GUEST RULES:
- This is a women's styling guide — all advice must be relevant to women's fashion
- NO white, cream or ivory — never wear white to a wedding as a guest
- NO overly casual — this is a wedding, dress up
- occasionDetail is dress code — black tie = floor length gown or formal midi. Smart = cocktail dress or smart midi. Smart casual = midi dress or tailored separates. Garden party = floral midi or smart jumpsuit
- occasionDetail2 is suit ownership — not relevant for women, use to understand formality level instead
- Body shape guidance:
  - Petite: midi length in one colour. Block heels to add height without discomfort for a long day
  - Tall: maxi dresses and wide leg trouser suits. Floor length gowns for black tie
  - Curvy: wrap or A-line midi dresses. Empire waist. Avoid bodycon for formal weddings
  - Standard: cocktail dress, midi dress, smart jumpsuit — all work
- Midi dresses, maxi dresses, jumpsuits, tailored separates — no jeans, no trainers, no white`,

    'w-girls-night-out': `
WOMEN'S GIRLS NIGHT OUT RULES:
- This is a women's styling guide — all advice must be relevant to women's fashion
- occasionDetail is venue type — bars: smart casual, club: more dressed up and bold, restaurant then bars: start smarter, house party: fun but considered
- occasionDetail2 is time — early start means practical and comfortable that holds up all night; late start means go all out from the off
- Body shape guidance:
  - Petite: mini dresses and skirts show off legs. High waisted bottoms with a crop top
  - Tall: midi slip dresses, wide leg trousers, co-ord sets
  - Curvy: bodycon works for clubs but choose quality fabric. Wrap dresses. High waisted skirts with a fitted top
  - Standard: satin slip, mini dress, co-ord set, going out top with trousers
- Going out tops, mini dresses, satin slip dresses, co-ord sets, heels, strappy sandals, clean trainers for casual venues`,

    'w-brunch': `
WOMEN'S BRUNCH / CASUAL DAYTIME RULES:
- This is a women's styling guide — all advice must be relevant to women's fashion
- Relaxed and stylish — not pyjamas, not a full formal outfit
- occasionDetail is the setting — local café: very relaxed, smart restaurant: slightly more considered, outdoor market or event: practical and stylish
- occasionDetail2 is the season — Summer: lighter fabrics and colours, Autumn/Winter: layers and warmer tones
- Body shape guidance:
  - Petite: high waisted jeans with a fitted top or a short dress. Avoid wide leg trousers unless high waisted
  - Tall: wide leg jeans, maxi skirts, oversized blazers all work beautifully
  - Curvy: high waisted straight leg jeans, wrap tops, belted midi skirts
  - Standard: jeans and a nice top, a casual midi dress, linen trousers with a blouse
- Jeans, casual midi dresses, linen trousers, blouses, casual trainers, loafers, sandals — easy and considered`,

    'w-summer-holiday': `
WOMEN'S SUMMER HOLIDAY RULES:
- This is a women's styling guide — all advice must be relevant to women's fashion
- NO heavy fabrics, thick denim, formal pieces or inappropriate footwear
- occasionDetail is destination — beach/resort: swimwear cover-ups, breezy dresses, sandals. City break: smarter casuals, linen, clean trainers. Long-haul: comfort plus versatile pieces
- occasionDetail2 is trip length — longer trips need versatile pieces that mix and match across multiple outfits
- Body shape guidance:
  - Petite: wrap dresses and mini kaftans. Wedge sandals for poolside height
  - Tall: maxi dresses and wide leg linen trousers work perfectly
  - Curvy: one piece swimwear with wrap sarongs. Wrap dresses. Avoid anything too clingy in the heat
  - Standard: linen co-ords, midi dresses, shorts and breezy tops
- Linen dresses, midi sundresses, shorts, breezy tops, sandals, espadrilles, canvas shoes, swimwear cover-ups`,

    'w-festival': `
WOMEN'S FESTIVAL RULES:
- This is a women's styling guide — all advice must be relevant to women's fashion
- NO formal pieces, heavy fabrics or anything precious
- occasionDetail is festival type — grassroots/indie: practical is key, wellies, layers. Major festival: balance of style and practical. Day festival: more style-led. Urban: closer to a night out
- occasionDetail2 is duration — multi-day: pack versatile pieces that work multiple ways. One day: go all out on the look
- Body shape guidance:
  - Petite: denim shorts with a crop top. Mini skirt with a tee. Festival boots add height practically
  - Tall: flared jeans, maxi skirts, co-ord sets work beautifully at festivals
  - Curvy: high waisted denim shorts with a fitted top. Wrap skirts. Practical but flattering
  - Standard: denim shorts, crop top, midi skirt with a band tee — all classic festival looks
- Denim shorts, mini skirts, crop tops, band tees, festival boots, wellies, trainers, co-ord sets, lightweight layers`,
  };

  const rules = occasionRules[occasionData.occasion] || '';

  const isWomens = (occasionData.gender === 'womens');
  const prompt = `You are a real personal stylist writing directly to a ${isWomens ? 'woman' : 'man'} who needs help dressing for a specific occasion. Write like a knowledgeable friend giving direct, honest, specific advice — not like a report being generated.

OCCASION: ${occasionData.occasionName}
OCCASION DETAIL (Q3): ${occasionData.occasionDetail || 'Not specified'}
OCCASION DETAIL 2 (Q4): ${occasionData.occasionDetail2 || 'Not specified'}
BUDGET PER ITEM: ${occasionData.budget}
${isWomens ? 'BODY SHAPE' : 'BUILD'}: ${occasionData.fit}
STYLE PREFERENCE: ${occasionData.style}
CURRENT SEASON: ${getCurrentSeason()} — this is genuinely today's season in the UK. Use it to keep fabric weight and layering realistic. Someone taking this quiz right now needs an outfit for THIS time of year unless the occasion type itself implies otherwise (e.g. Summer Holiday, Festival)
GENDER: ${isWomens ? 'Women\'s guide — all product picks and styling advice must be for women' : 'Men\'s guide — all product picks and styling advice must be for men'}

${rules}

GENERAL RULES FOR ALL OCCASIONS:
- SEASON CHECK — CRITICAL: fabric weight must match the current season given above. In Spring/Summer, do not recommend heavy knits, wool, thick denim, or a jacket layer unless the occasion genuinely calls for one regardless of temperature (e.g. a wedding or interview still needs a blazer in summer — just in a lighter fabric like cotton or linen-blend, not wool). In Autumn/Winter, lightweight-only pieces (linen, thin cotton tees with no layer) are wrong unless the occasion is explicitly indoor and heated. This check overrides generic occasion assumptions — a "date night" guide generated in July should not default to the same knit-and-jacket combination as one generated in December
- The recommended products are illustrative examples that match the styling advice — they do not need to form a perfectly coordinated outfit. Each product should be individually appropriate for the occasion and build.
- Never recommend a product that does not suit the occasion even if it is the only option
- Better to recommend 2 excellent products than 3 where one is wrong
- Never recommend joggers, gym wear or sportswear unless the occasion explicitly calls for it
- Products must suit the build — no slim or muscle fit for bigger/broader builds, no oversized or regular fit for slim builds unless the style calls for it
- Products must be appropriate for the occasion — a clubwear shirt for a job interview is wrong regardless of fit
- Shoes must be appropriate for the occasion — leather shoes for formal occasions, trainers for casual, sandals only for holiday/festival
- Always ask: would a real stylist recommend this specific product for this specific occasion and build?

LAYERING RULE — CRITICAL:
- Every occasion except very casual ones needs a jacket or layer in the outfit formula
- The layer is what makes an outfit look considered rather than just clothes thrown on
- Only include a layer in the outfitFormula if you are also recommending it as a product in recommendedPieces — if you mention a harrington or blazer in the formula, it must appear in your picks
- If you cannot find a suitable jacket in the product list, describe the outfit without a layer rather than mentioning one you are not picking
- Describe what type of layer works — unstructured blazer, lightweight jacket, bomber, lightweight shirt worn open — and why it works for this build

WHY TEXT RULES — CRITICAL:
- Every "why" field must mention the person's specific build and why this product works for it
- Never write a generic why that could apply to any person — e.g. "loafers show you made an effort" is wrong
- Correct format: "[specific detail about the product] works for [their build] because [specific reason tied to their body]"
- Example good why: "Super slim fit means the fabric follows your frame without billowing — black keeps the colour palette clean for a restaurant setting"
- Example bad why: "A great choice for date night that shows you made an effort"
- Include specific colour, fit detail, or fabric detail in every why

OUTFIT FORMULA RULES — CRITICAL:
- Must include specific colours not just categories — say "dark navy slim chinos" not just "chinos"
- Must include how pieces work together — say "the dark bottom half keeps the eye up toward the face" not just "wear chinos with a shirt"
- Must include the layer and how to wear it — open, buttoned, sleeves rolled, etc
- Must reference their specific build — say "for your lean frame the slim fit stops fabric swamping you" not generic advice
- ONLY describe pieces in the outfit formula that you are also recommending in recommendedPieces — do not describe a harrington jacket in the formula then fail to include one in the picks. If you mention it, pick it. If you cannot find it in the product list, do not mention it in the formula

TONE — CRITICAL:
- Write like a real person talking, not a document being generated
- Direct, warm and specific — like advice from a knowledgeable friend, not a corporate report
- BANNED WORDS — never use any of these under any circumstances: system, intentional, cohesive, silhouette, taper, tapered, aesthetic, palette, framework, elevate, curated, layering piece, overshirt, game changer, key pieces, wardrobe staples, effortless, timeless
- ALSO AVOID sounding like marketing copy: never use "unlock", "level up", "game-changing", "perfect for", "you'll love", or any exclamation marks
- Vary sentence length like a real person would — mix short, blunt sentences with the occasional longer one, rather than every sentence being the same clipped length
- It is fine, even good, to sound slightly informal — contractions (you're, don't, it's) are encouraged over the formal version
- Every sentence must be specific to this person's occasion, build and budget — never a sentence that could apply to any customer
- Short punchy sentences mostly, no waffle
- SELF-CHECK: Before returning your response, re-read every field and replace any banned word you find. There are no exceptions.

AVAILABLE PRODUCTS — only recommend products from this exact list:
${JSON.stringify(productList, null, 2)}

Respond with JSON only, no markdown:
{
  "occasionTitle": "Short punchy title e.g. Your Date Night Look",
  "openingNote": "2-3 sentences written like a personal note — acknowledge their specific occasion detail, what the goal is, what you are giving them. Warm and direct.",
  "recommendedPieces": [
    {
      "category": "category name",
      "name": "exact product name from the list above",
      "brand": "brand",
      "price": "£XX",
      "url": "exact url from the list",
      "why": "One sentence — must mention their specific build and why this exact product works for it. Include colour or fit detail."
    }
  ],
  "whatToWear": {
    "headline": "One punchy sentence summarising the outfit direction — must reference the ACTUAL items you picked in recommendedPieces above, by their real colour/type, not a generic or imagined item",
    "outfitFormula": "3-4 sentences describing the complete outfit top to bottom, using ONLY the exact items listed in recommendedPieces above — do not mention any product, colour, or layer that is not one of those picks. If recommendedPieces has no jacket/layer item, do not describe wearing a jacket or shirt layer at all.",
    "fitAdvice": "2 sentences of specific fit advice for their build — what to look for when trying things on and what to avoid. Name specific fit issues relevant to their build."
  },
  "whatToAvoid": "MANDATORY — 2-3 specific things to avoid for this occasion and build. Written like a friend telling them honestly. Name specific items or fits, not just categories. This field must never be empty.",
  "stylistTip": "One insider tip most people do not know — specific to this occasion and this build. Should feel like a genuine secret, not generic advice.",
  "quickRecap": [
    "3-4 short checklist items, each under 8 words, covering the essentials to double-check before leaving — e.g. 'Jacket on, sleeves pushed up', 'Boots not trainers', 'One less thing than you think'. Specific to this outfit, not generic."
  ],
  "restyleTip": "One sentence on how to re-wear the key piece from this outfit for a DIFFERENT occasion in future — e.g. 'That harrington works just as well for a casual daytime look, just swap the boots for trainers.' Must reference an actual piece from recommendedPieces and a genuinely different occasion type.",
  "whereToShop": {
    "intro": "One sentence — if our picks are not quite right here is exactly what to look for",
    "searchTerms": [
      { "site": "ASOS", "search": "exact search term to use on ASOS", "whatToLookFor": "specific fabric, fit detail or feature to check on the product page" },
      { "site": "Zara", "search": "exact search term", "whatToLookFor": "what to check" },
      { "site": "H&M", "search": "exact search term", "whatToLookFor": "what to check" }
    ],
    "brandsToConsider": "2-3 specific brands suited to this occasion and budget — not generic, explain briefly why each one",
    "priceGuidance": "What to expect to pay per category at their budget level — be specific with ranges",
    "avoid": "One sentence — what to avoid when shopping independently for this occasion and this build"
  }
}

Rules:
- JSON only, no markdown
- CRITICAL: decide recommendedPieces FIRST, then write whatToWear to describe exactly those items — never the reverse. The outfitFormula and headline must not mention any garment, colour, or layer that isn't an actual entry in recommendedPieces
- whatToAvoid is MANDATORY — never return an empty string. Always include 2-3 specific things to avoid for this occasion and build
- Top and Bottoms are MANDATORY — always include at least one Top and one Bottoms pick. If you cannot find a suitable product in either category the guide fails. These two are non-negotiable
- Accessory — you may include ONE accessory pick (5th and final item) if a genuinely suitable product exists in the list AND it's the kind of finishing touch a real stylist would actually add — a watch, belt, bag, sunglasses, jewellery. Only include it if it's a real fit for the occasion and build, never just to fill the slot. If nothing suitable exists, omit it — 4 strong picks beats 5 where the 5th feels forced
- Shoes — always include if a suitable product exists in the list. If no suitable shoe exists for the occasion, omit it — the PDF will show a "Complete Your Look" tip instead
- Jacket or layer — include if the occasion warrants it (Date Night, Job Interview, Wedding Guest, Night Out, Smart Casual Work) and a suitable product exists. If none exists, omit — the PDF will handle it
- Festival and Summer Holiday — jacket is optional, only include if genuinely appropriate
- quickRecap is MANDATORY — always 3-4 short items, never empty
- restyleTip is MANDATORY — always reference a real picked piece and a genuinely different occasion, never empty
- Never describe a piece in the outfitFormula without picking it, and never pick a piece without describing it in the formula
- Only use products from the list — do not invent products
- Every field must be specific to the occasion and their answers
- Re-read your output before returning it and remove any banned words`;

  let parsed = null;
  let lastError = null;
  let lastViolations = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const attemptPrompt = lastViolations.length
        ? `${prompt}\n\nCORRECTION FROM PREVIOUS ATTEMPT — you described item(s) in occasionTitle, whatToWear.headline or whatToWear.outfitFormula that do NOT appear in recommendedPieces: ${lastViolations.join(', ')}. Only mention a product category in that copy if that exact category is one of your recommendedPieces. Remove those references and rewrite accordingly.`
        : prompt;
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 3000,
        messages: [{ role: 'user', content: attemptPrompt }],
      });
      const raw = message.content[0].text.trim();
      const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const candidate = JSON.parse(text);
      console.log(`=== OCCASION CONTENT attempt ${attempt} ===\n${JSON.stringify(candidate, null, 2)}\n=== END ===`);

      const violations = findCategoryMismatches(candidate);
      parsed = candidate; // keep as the best-available fallback even if this attempt still has violations
      if (violations.length > 0) {
        console.warn(`[content-mismatch] attempt ${attempt} describes unpicked categories: ${violations.join(', ')}`);
        lastViolations = violations;
        if (attempt < 3) { console.log('Retrying due to category mismatch...'); continue; }
      } else {
        lastViolations = [];
        break;
      }
    } catch (err) {
      lastError = err;
      console.error(`Claude parse failed attempt ${attempt}:`, err.message);
      if (attempt < 3) console.log('Retrying...');
    }
  }
  if (!parsed) throw new Error(`Claude failed after 3 attempts: ${lastError?.message}`);
  if (lastViolations.length > 0) {
    console.warn(`[content-mismatch] Delivering guide despite unresolved mismatch after 3 attempts: ${lastViolations.join(', ')}`);
  }
  return parsed;
}

// ── BUILD OCCASION PDF ────────────────────────────────────────────────────────

async function buildOccasionPDF(content, occasionData, products) {
  const pdfPath = path.join(DOWNLOADS_DIR, `outfitify-occasion-${Date.now()}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  // Register real fonts — matches the actual website (Playfair Display + DM Sans)
  // instead of falling back to generic Helvetica
  doc.registerFont('Serif',        path.join(FONTS_DIR, 'PlayfairDisplay-Medium.ttf'));
  doc.registerFont('Serif-Bold',   path.join(FONTS_DIR, 'PlayfairDisplay-Bold.ttf'));
  doc.registerFont('Serif-Italic', path.join(FONTS_DIR, 'PlayfairDisplay-MediumItalic.ttf'));
  doc.registerFont('Sans',         path.join(FONTS_DIR, 'DMSans-Regular.ttf'));
  doc.registerFont('Sans-Medium',  path.join(FONTS_DIR, 'DMSans-Medium.ttf'));
  doc.registerFont('Sans-Bold',    path.join(FONTS_DIR, 'DMSans-Bold.ttf'));

  // Brand colours — now light/editorial, matching the actual website exactly,
  // instead of the old inverted dark theme the site never used
  const isWomens = occasionData.gender === 'womens';
  const WHITE = '#ffffff', OFFWHITE = '#f7f5f2', INK = '#1c1917', INK_MID = '#44403c',
        INK_LIGHT = '#78716c', BORDER = '#e7e3de',
        ACCENT = isWomens ? '#a05a52' : '#92714a',   // terracotta / tan — matches site exactly
        RED = '#c4886a';

  // Stylist sign-off — always Joshua, regardless of guide gender
  const STYLIST_NAME = 'Joshua';

  const PW = 595, PH = 842, PAD = 50, IW = 495;

  const bg = () => doc.rect(0, 0, PW, PH).fill(WHITE);
  const textH = (str, fontSize, fontName, width) => {
    doc.fontSize(fontSize).font(fontName || 'Sans');
    return doc.heightOfString(str || '', { width, lineGap: 2 });
  };

  function pageHeader(sub) {
    doc.rect(0, 0, PW, 60).fill(WHITE);
    doc.rect(0, 60, PW, 1).fill(BORDER);
    // Logo — tracked uppercase Playfair Display, matching the site wordmark exactly
    doc.fontSize(13).fillColor(INK).font('Serif-Bold')
      .text('O U T F I T I F Y', 0, 18, { width: PW, align: 'center', characterSpacing: 3 });
    if (sub) doc.fontSize(7).fillColor(INK_LIGHT).font('Sans')
      .text(sub.toUpperCase(), 0, 38, { width: PW, align: 'center', characterSpacing: 2 });
  }

  function footer() {
    doc.rect(0, PH - 30, PW, 30).fill(OFFWHITE);
    doc.rect(0, PH - 30, PW, 1).fill(BORDER);
    doc.fontSize(7).fillColor(INK_LIGHT).font('Sans')
      .text('OUTFITIFY.CO.UK  ·  OCCASION STYLE GUIDE', 0, PH - 18, { width: PW, align: 'center', characterSpacing: 1 });
  }

  function sectionLabel(text, y, color) {
    doc.fontSize(7).fillColor(color || ACCENT).font('Sans-Bold').text(text, PAD, y, { characterSpacing: 3 });
    doc.moveTo(PAD, y + 13).lineTo(PAD + IW, y + 13).strokeColor(BORDER).lineWidth(0.5).stroke();
  }

  function lcard(x, y, w, h, accent) {
    doc.rect(x, y, w, h).fill(OFFWHITE);
    doc.rect(x, y, 2, h).fill(accent || ACCENT);
  }

  // CTA pill button — replaces the old plain underlined text link, gives
  // every product a genuine tappable call-to-action (this is the EPC lever)
  function ctaPill(x, y, w, h, label) {
    doc.roundedRect(x, y, w, h, h / 2).fill(ACCENT);
    doc.fontSize(8.5).fillColor(WHITE).font('Sans-Bold')
      .text(label, x, y + (h - 10) / 2, { width: w, align: 'center' });
  }

  // Generic per-domain image fetch — fixes the bug where images were hardcoded
  // to always claim they came from Zara (Referer: 'https://www.zara.com/'),
  // which silently broke images from every other retailer in your sheet.
  // This derives the referer from each image's own domain instead.
  async function fetchProductImage(imageUrl) {
    if (!imageUrl) return null;
    try {
      const domain = new URL(imageUrl).hostname;
      const r = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `https://${domain}/`,
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });
      return Buffer.from(r.data);
    } catch (err) {
      console.warn(`[image fetch] failed for ${imageUrl}: ${err.message}`);
      return null; // falls back to a plain placeholder box — never breaks layout
    }
  }

  const allProductItems = Object.values(products).flat();

  // ── PAGE 1 ────────────────────────────────────────────────────────────────
  bg();
  pageHeader('Occasion Style Guide');

  doc.fontSize(9).fillColor(ACCENT).font('Sans-Bold').text("YOUR STYLIST'S VERDICT", PAD, 84, { characterSpacing: 3 });
  const titleParts = (content.occasionTitle || occasionData.occasionName).split(' ');
  const mid = Math.ceil(titleParts.length / 2);
  doc.fontSize(36).fillColor(INK).font('Serif-Bold').text(titleParts.slice(0, mid).join(' '), PAD, 102);
  doc.fontSize(36).fillColor(ACCENT).font('Serif-Bold').text(titleParts.slice(mid).join(' '), PAD, 142);

  const noteH = Math.max(textH(content.openingNote || '', 10, 'Sans', IW - 28) + 36, 80);
  lcard(PAD, 210, IW, noteH);
  doc.fontSize(7).fillColor(ACCENT).font('Sans-Bold').text('A NOTE FROM YOUR STYLIST', PAD + 14, 220, { characterSpacing: 2 });
  doc.fontSize(10).fillColor(INK_MID).font('Sans').text(content.openingNote || '', PAD + 14, 236, { width: IW - 28, lineGap: 3 });

  let curY = 210 + noteH + 24;

  sectionLabel('THE OUTFIT', curY);
  curY += 21;
  const headlineH = Math.max(textH(content.whatToWear?.headline || '', 13, 'Serif-Bold', IW - 28) + 28, 52);
  lcard(PAD, curY, IW, headlineH);
  doc.fontSize(13).fillColor(INK).font('Serif-Bold').text(content.whatToWear?.headline || '', PAD + 14, curY + 14, { width: IW - 28, lineGap: 2 });
  curY += headlineH + 12;

  const formulaH = textH(content.whatToWear?.outfitFormula || '', 10, 'Sans', IW) + 8;
  doc.fontSize(10).fillColor(INK_MID).font('Sans').text(content.whatToWear?.outfitFormula || '', PAD, curY, { width: IW, lineGap: 4 });
  curY += formulaH + 16;

  if (curY + 60 < PH - 80) {
    sectionLabel(isWomens ? 'FIT ADVICE FOR YOUR SHAPE' : 'FIT ADVICE FOR YOUR BUILD', curY);
    curY += 21;
    const fitH = Math.max(textH(content.whatToWear?.fitAdvice || '', 9.5, 'Sans', IW - 28) + 28, 52);
    lcard(PAD, curY, IW, fitH);
    doc.fontSize(9.5).fillColor(INK_MID).font('Sans').text(content.whatToWear?.fitAdvice || '', PAD + 14, curY + 14, { width: IW - 28, lineGap: 3 });
    curY += fitH + 16;
  }

  if (curY + 60 < PH - 80 && (content.whatToAvoid || '').trim().length > 10) {
    sectionLabel('WHAT TO AVOID', curY, RED);
    curY += 21;
    const avoidH = Math.max(textH(content.whatToAvoid, 9.5, 'Sans', IW - 28) + 28, 52);
    lcard(PAD, curY, IW, avoidH, RED);
    doc.fontSize(9.5).fillColor(INK_MID).font('Sans').text(content.whatToAvoid, PAD + 14, curY + 14, { width: IW - 28, lineGap: 3 });
    curY += avoidH + 16;
  }

  // Quick recap checklist — new: gives a real "before you leave" checklist,
  // the kind of thing a real stylist actually hands you
  if (curY + 70 < PH - 80 && Array.isArray(content.quickRecap) && content.quickRecap.length > 0) {
    sectionLabel('QUICK RECAP BEFORE YOU LEAVE', curY);
    curY += 21;
    const recapH = content.quickRecap.length * 16 + 20;
    lcard(PAD, curY, IW, recapH);
    let recapY = curY + 12;
    content.quickRecap.forEach(item => {
      doc.fontSize(9.5).fillColor(ACCENT).font('Sans-Bold').text('✓', PAD + 14, recapY, { lineBreak: false });
      doc.fontSize(9.5).fillColor(INK_MID).font('Sans').text(item, PAD + 30, recapY, { width: IW - 44, lineBreak: false });
      recapY += 16;
    });
    curY += recapH + 16;
  }

  footer();

  // ── PAGE 2 — PRODUCT PICKS (now with real images + CTA buttons) ────────────
  doc.addPage();
  bg();
  pageHeader('Your Picks');

  const pieces = (content.recommendedPieces || []).slice(0, 5);

  // Fetch all product images up front, in parallel
  const imageBuffers = await Promise.all(pieces.map(piece => {
    const match = allProductItems.find(p => p['Item Name'] === piece.name);
    return fetchProductImage(match?.['Image URL']);
  }));

  doc.fontSize(22).fillColor(INK).font('Serif-Bold').text('HAND-PICKED', PAD, 78);
  doc.fontSize(22).fillColor(ACCENT).font('Serif-Bold').text('FOR THIS OCCASION', PAD, 106);
  doc.fontSize(9).fillColor(INK_LIGHT).font('Sans-Medium')
    .text(`Products matched to your ${isWomens ? 'shape' : 'build'}, your budget and ${(occasionData.occasionName || '').toLowerCase()}`, PAD, 142, { width: IW });

  let pieceY = 170;

  if (content.stylistTip) {
    const tipH = Math.max(textH(content.stylistTip, 9, 'Sans', IW - 28) + 28, 44);
    doc.rect(PAD, pieceY, IW, tipH).fill(OFFWHITE);
    doc.rect(PAD, pieceY, IW, tipH).strokeColor(ACCENT).lineWidth(0.5).stroke();
    doc.fontSize(7).fillColor(ACCENT).font('Sans-Bold').text("STYLIST'S TIP", PAD + 14, pieceY + 9, { characterSpacing: 2 });
    doc.fontSize(9).fillColor(INK_MID).font('Sans').text(content.stylistTip, PAD + 14, pieceY + 21, { width: IW - 28, lineGap: 2 });
    pieceY += tipH + 12;
  }

  const IMG_SIZE = 84;

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const hasImage = !!imageBuffers[i];
    const textX = PAD + 14 + (hasImage ? IMG_SIZE + 14 : 0);
    const priceRowH = 30;
    const textW = PAD + IW - 14 - textX;

    doc.fontSize(11).font('Serif-Bold');
    const nameH = doc.heightOfString(piece.name || '', { width: textW });
    doc.fontSize(8.5).font('Sans');
    const whyH = doc.heightOfString(piece.why || '', { width: textW, lineGap: 1.5 });

    const contentHgt = 14 + 12 + 6 + nameH + 6 + whyH;
    const CARD_H = Math.max(hasImage ? IMG_SIZE + 28 : 64, contentHgt + priceRowH + 20);

    if (pieceY + CARD_H > PH - 100) break;

    doc.rect(PAD, pieceY, IW, CARD_H).fill(OFFWHITE);
    doc.rect(PAD, pieceY, IW, CARD_H).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.rect(PAD, pieceY, 2, CARD_H).fill(ACCENT);

    // Product image — fixed box, clipped + cover-fit so it never distorts
    // or breaks the card layout, regardless of source image aspect ratio
    if (hasImage) {
      const imgX = PAD + 14, imgY = pieceY + 14;
      doc.save();
      try {
        doc.rect(imgX, imgY, IMG_SIZE, IMG_SIZE).clip();
        doc.image(imageBuffers[i], imgX, imgY, { width: IMG_SIZE, height: IMG_SIZE, cover: [IMG_SIZE, IMG_SIZE] });
      } catch {
        doc.rect(imgX, imgY, IMG_SIZE, IMG_SIZE).fill(BORDER);
      } finally {
        // CRITICAL: must always run, even on failure — if doc.save() ran but
        // restore() never does, every clip stays active for the rest of the
        // page and silently makes all subsequent text invisible, even though
        // it's still technically written into the PDF (which is why text
        // extraction tools could read it fine while the actual page looked empty)
        doc.restore();
      }
    }

    const catY = pieceY + 14;
    doc.fontSize(7).fillColor(ACCENT).font('Sans-Bold')
      .text((piece.category || '').toUpperCase(), textX, catY, { width: textW, lineBreak: false, characterSpacing: 1.5 });

    const nameY = catY + 16;
    doc.fontSize(11).fillColor(INK).font('Serif-Bold').text(piece.name || '', textX, nameY, { width: textW });

    const whyY = nameY + nameH + 6;
    doc.fontSize(8.5).fillColor(INK_LIGHT).font('Sans').text(piece.why || '', textX, whyY, { width: textW, lineGap: 1.5 });

    const productUrl = piece.url || allProductItems.find(p => p['Item Name'] === piece.name)?.['Product URL'] || null;

    const bottomY = pieceY + CARD_H - 34;
    doc.fontSize(14).fillColor(INK).font('Serif-Bold').text(piece.price || '', textX, bottomY, { lineBreak: false });
    doc.fontSize(8).fillColor(INK_LIGHT).font('Sans').text(piece.brand || '', textX + 60, bottomY + 3, { lineBreak: false });

    if (productUrl) {
      const btnW = 100, btnH = 26;
      ctaPill(PAD + IW - 14 - btnW, bottomY - 2, btnW, btnH, 'Shop this →');
      doc.link(PAD + IW - 14 - btnW, bottomY - 2, btnW, btnH, productUrl);
    }

    pieceY += CARD_H + 8;
  }

  // ── COMPLETE YOUR LOOK ──
  const JACKET_OCCASIONS = ['date-night', 'job-interview', 'wedding-guest', 'night-out', 'smart-casual-work'];
  const jacketRequired = JACKET_OCCASIONS.includes(occasionData.occasion);
  const pickedCategories = new Set((content.recommendedPieces || []).map(p => (p.category || '').toLowerCase()));
  const hasTop     = [...pickedCategories].some(c => c === 'top');
  const hasBottoms = [...pickedCategories].some(c => c === 'bottoms');
  const hasShoes   = [...pickedCategories].some(c => c === 'shoes');
  const hasJacket  = [...pickedCategories].some(c => c.includes('jacket') || c === 'hoodie/jacket');

  if (!hasTop)     console.warn(`[CYL] WARNING: No Top in recommendedPieces for session — Claude may have failed mandatory rule`);
  if (!hasBottoms) console.warn(`[CYL] WARNING: No Bottoms in recommendedPieces for session — Claude may have failed mandatory rule`);

  const completeYourLook = [];

  // Top and Bottoms are supposed to be mandatory picks (enforced in the AI
  // prompt), but the product sheet can still be too thin in a given
  // occasion/fit/budget/season combination for Claude to have anything to
  // pick from. When that happens the styling copy still references a top
  // or bottoms item in prose with nowhere for the customer to buy it —
  // this fallback ensures they always get somewhere to go instead of a
  // dead end.
  if (!hasTop) {
    completeYourLook.push({
      category: 'Top',
      guidance: `Search for a top to match the outfit above — for ${occasionData.occasionName}, look for ${
        ['date-night', 'wedding-guest', 'job-interview', 'night-out', 'smart-casual-work'].includes(occasionData.occasion)
          ? 'a fitted shirt or smart short-sleeve top in a clean, plain colour — nothing oversized, logo-heavy or gym-branded'
          : ['festival', 'summer-holiday'].includes(occasionData.occasion)
          ? 'a lightweight t-shirt or short-sleeve shirt in a breathable fabric'
          : 'a top that suits the formality of the occasion'
      }. Make sure the fit matches your build rather than defaulting to whatever size you usually buy.`,
    });
  }

  if (!hasBottoms) {
    completeYourLook.push({
      category: 'Bottoms',
      guidance: `Search for bottoms to match the outfit above — for ${occasionData.occasionName}, look for smart trousers, chinos or dark jeans at the right formality level, in a fit that works for your build without pulling or gaping.`,
    });
  }

  if (!hasShoes) {
    completeYourLook.push({
      category: 'Shoes',
      guidance: `Search for shoes that match the occasion — for ${occasionData.occasionName}, look for ${
        ['date-night','wedding-guest','job-interview'].includes(occasionData.occasion)
          ? 'leather loafers, Oxford shoes or clean minimal leather trainers'
          : ['night-out'].includes(occasionData.occasion)
          ? 'Chelsea boots, clean leather trainers or smart loafers'
          : ['festival','summer-holiday'].includes(occasionData.occasion)
          ? 'canvas shoes, clean trainers or sandals'
          : 'clean smart shoes suited to the occasion'
      }. Avoid anything overly casual or worn-looking.`,
    });
  }

  if (jacketRequired && !hasJacket) {
    completeYourLook.push({
      category: 'Jacket / Layer',
      guidance: `A jacket layer is the difference between looking nice and looking considered for ${occasionData.occasionName}. Look for ${
        ['job-interview','wedding-guest'].includes(occasionData.occasion)
          ? 'an unstructured blazer in navy or charcoal — single breasted, slim or regular fit'
          : ['date-night','night-out'].includes(occasionData.occasion)
          ? 'a harrington jacket, bomber or unstructured blazer worn open over the shirt'
          : 'a smart casual jacket or overshirt that sits over your top without adding bulk'
      }. Brands to check: ASOS Design, Jack & Jones Premium, River Island.`,
    });
  }

  if (completeYourLook.length > 0) {
    // Real space needed: 12px (pieceY→cylY) + 21px (cylY→cylCurY) + 72px (min card height)
    // Must match exactly, or a narrow gap between this check and the actual
    // draw position can still produce an orphaned header with no card beneath it
    if (pieceY + 12 + 21 + 72 >= PH - 100) {
      footer(); doc.addPage(); bg(); pageHeader('Complete Your Look'); pieceY = 50;
    }
    const cylY = pieceY + 12;
    sectionLabel('COMPLETE YOUR LOOK', cylY);
    let cylCurY = cylY + 21;
    completeYourLook.forEach(item => {
      if (cylCurY + 72 > PH - 100) return;
      const cardH = Math.max(72, textH(item.guidance, 9, 'Sans', IW - 28) + 36);
      doc.rect(PAD, cylCurY, IW, cardH).fill(OFFWHITE);
      doc.rect(PAD, cylCurY, IW, cardH).strokeColor(BORDER).lineWidth(0.5).stroke();
      doc.rect(PAD, cylCurY, 2, cardH).fill(ACCENT);
      doc.fontSize(7).fillColor(ACCENT).font('Sans-Bold').text(item.category.toUpperCase(), PAD + 14, cylCurY + 10, { characterSpacing: 2 });
      doc.fontSize(9).fillColor(INK_MID).font('Sans').text(item.guidance, PAD + 14, cylCurY + 24, { width: IW - 28, lineGap: 2 });
      cylCurY += cardH + 6;
    });
    pieceY = cylCurY;
  }

  // Re-wear tip — new: shows this isn't a one-occasion piece, ties value
  // forward to future guides
  if (content.restyleTip && pieceY + 60 < PH - 100) {
    const rwY = pieceY + 12;
    sectionLabel('WEAR IT AGAIN', rwY);
    const rwH = Math.max(textH(content.restyleTip, 9.5, 'Sans', IW - 28) + 28, 48);
    lcard(PAD, rwY + 21, IW, rwH);
    doc.fontSize(9.5).fillColor(INK_MID).font('Sans').text(content.restyleTip, PAD + 14, rwY + 33, { width: IW - 28, lineGap: 3 });
    pieceY = rwY + 21 + rwH + 16;
  }

  // ── WHERE TO SHOP YOURSELF ──
  const ws = content.whereToShop;
  if (ws) {
    const wsNeeded = 80;
    if (pieceY + wsNeeded >= PH - 60) {
      footer(); doc.addPage(); bg(); pageHeader('If Our Picks Are Not Quite Right'); pieceY = 50;
    }
    const shopY = pieceY + 16;
    if (shopY + 20 < PH - 60) sectionLabel('IF OUR PICKS ARE NOT QUITE RIGHT', shopY);
    let wsY = shopY + 21;
    if (ws.intro && wsY < PH - 60) {
      doc.fontSize(9.5).fillColor(INK_MID).font('Sans').text(ws.intro, PAD, wsY, { width: IW, lineGap: 3 });
      wsY += textH(ws.intro, 9.5, 'Sans', IW) + 14;
    }
    (ws.searchTerms || []).forEach(term => {
      if (wsY + 52 > PH - 60) return;
      doc.rect(PAD, wsY, IW, 48).fill(OFFWHITE);
      doc.rect(PAD, wsY, IW, 48).strokeColor(BORDER).lineWidth(0.5).stroke();
      doc.rect(PAD, wsY, 2, 48).fill(ACCENT);
      doc.fontSize(8).fillColor(ACCENT).font('Sans-Bold').text(term.site.toUpperCase(), PAD + 14, wsY + 8, { characterSpacing: 2 });
      doc.fontSize(9).fillColor(INK).font('Serif-Bold').text(`"${term.search}"`, PAD + 14, wsY + 22, { width: (IW - 28) / 2, lineBreak: false });
      doc.fontSize(7.5).fillColor(INK_LIGHT).font('Sans').text(term.whatToLookFor || '', PAD + 14 + (IW - 28) / 2 + 8, wsY + 24, { width: (IW - 28) / 2 - 8 });
      wsY += 54;
    });
    if (wsY + 48 < PH - 60) {
      const hw = (IW - 8) / 2;
      doc.fontSize(8.5).font('Sans');
      const brandsH = Math.max(48, doc.heightOfString(ws.brandsToConsider || '', { width: hw - 28 }) + 28);
      const priceH  = Math.max(48, doc.heightOfString(ws.priceGuidance  || '', { width: hw - 28 }) + 28);
      const infoCardH = Math.max(brandsH, priceH);
      if (wsY + infoCardH < PH - 60) {
        doc.rect(PAD, wsY, hw, infoCardH).fill(OFFWHITE);
        doc.rect(PAD, wsY, hw, infoCardH).strokeColor(BORDER).lineWidth(0.5).stroke();
        doc.rect(PAD, wsY, 2, infoCardH).fill(ACCENT);
        doc.fontSize(6.5).fillColor(ACCENT).font('Sans-Bold').text('BRANDS TO CONSIDER', PAD + 14, wsY + 8, { characterSpacing: 2 });
        doc.fontSize(8.5).fillColor(INK_MID).font('Sans').text(ws.brandsToConsider || '', PAD + 14, wsY + 22, { width: hw - 28 });
        const col2x = PAD + hw + 8;
        doc.rect(col2x, wsY, hw, infoCardH).fill(OFFWHITE);
        doc.rect(col2x, wsY, hw, infoCardH).strokeColor(BORDER).lineWidth(0.5).stroke();
        doc.rect(col2x, wsY, 2, infoCardH).fill(ACCENT);
        doc.fontSize(6.5).fillColor(ACCENT).font('Sans-Bold').text('PRICE GUIDANCE', col2x + 14, wsY + 8, { characterSpacing: 2 });
        doc.fontSize(8.5).fillColor(INK_MID).font('Sans').text(ws.priceGuidance || '', col2x + 14, wsY + 22, { width: hw - 28 });
        wsY += infoCardH + 8;
      }
    }
    if (ws.avoid) {
      doc.fontSize(7).font('Sans');
      const avoidLabel = 'AVOID WHEN SHOPPING:  ';
      const avoidCardH = Math.max(36, doc.heightOfString(avoidLabel + ws.avoid, { width: IW - 28 }) + 20);
      if (wsY + avoidCardH < PH - 60) {
        doc.rect(PAD, wsY, IW, avoidCardH).fill(OFFWHITE);
        doc.rect(PAD, wsY, IW, avoidCardH).strokeColor(BORDER).lineWidth(0.5).stroke();
        doc.rect(PAD, wsY, 2, avoidCardH).fill(RED);
        doc.fontSize(7).fillColor(RED).font('Sans-Bold').text('AVOID WHEN SHOPPING:', PAD + 14, wsY + 12);
        const avoidLabelW = doc.widthOfString('AVOID WHEN SHOPPING:');
        doc.fontSize(7).fillColor(INK_MID).font('Sans').text(' ' + ws.avoid, PAD + 14 + avoidLabelW, wsY + 12, { width: IW - 28 - avoidLabelW, lineBreak: true });
        wsY += avoidCardH + 20;
      }
    }

    // Personal sign-off — new: closing line signed by a named stylist,
    // the single biggest lever for "a human sent this" beyond word choice
    if (wsY + 30 < PH - 60) {
      doc.fontSize(10).fillColor(INK).font('Serif-Italic')
        .text(`That's your look sorted — have a good one.`, PAD, wsY, { width: IW });
      doc.fontSize(10).fillColor(ACCENT).font('Serif-Bold')
        .text(`— ${STYLIST_NAME}, your Outfitify stylist`, PAD, wsY + 18, { width: IW });
    }
  }

  footer();
  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(pdfPath));
    stream.on('error', reject);
  });
}


// ── SEND OCCASION EMAIL ───────────────────────────────────────────────────────

async function sendOccasionEmail(toEmail, downloadUrl, occasionName, sessionId, isFree = false) {
  const subject = isFree
    ? `Your Free ${occasionName} Style Guide is Ready`
    : `Your ${occasionName} Style Guide is Ready`;

  const introBody = isFree
    ? `Your first guide's on us. It's been built around your answers — what to wear, how it should fit your build, what to avoid, hand-picked products with links and prices, and where to shop if you want to find your own.`
    : `Your personalised outfit guide has been built around your answers — what to wear, how it should fit your build, what to avoid, hand-picked products with links and prices, and where to shop if you want to find your own.`;

  const upsellCard = isFree
    ? `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;border:1px solid #2A2520;border-left:3px solid #B8A898;">
        <tr>
          <td style="background-color:#111111;padding:24px;">
            <p style="color:#B8A898;font-size:10px;letter-spacing:3px;font-weight:600;margin:0 0 10px 0;text-transform:uppercase;font-family:Arial,sans-serif;">Got another occasion coming up?</p>
            <p style="color:#C8BFB5;font-size:13px;line-height:1.7;margin:0 0 16px 0;font-family:Arial,sans-serif;">That one was free — the next one's £2.49, or go unlimited for £9.99 (one-time payment, every future guide included, no subscription).</p>
            <a href="https://occasions.outfitify.co.uk" style="display:block;background-color:#B8A898;color:#0A0A0A;text-align:center;padding:14px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;text-transform:uppercase;font-family:Arial,sans-serif;">BROWSE ALL OCCASIONS →</a>
          </td>
        </tr>
      </table>`
    : `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;border:1px solid #2A2520;border-left:3px solid #B8A898;">
        <tr>
          <td style="background-color:#111111;padding:24px;">
            <p style="color:#B8A898;font-size:10px;letter-spacing:3px;font-weight:600;margin:0 0 10px 0;text-transform:uppercase;font-family:Arial,sans-serif;">Need a few more occasions this year?</p>
            <p style="color:#C8BFB5;font-size:13px;line-height:1.7;margin:0 0 16px 0;font-family:Arial,sans-serif;">Go unlimited for £9.99 — one-time payment, every future guide included, never pay per guide again.</p>
            <a href="https://occasions.outfitify.co.uk" style="display:block;background-color:#B8A898;color:#0A0A0A;text-align:center;padding:14px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;text-transform:uppercase;font-family:Arial,sans-serif;">GO UNLIMITED →</a>
          </td>
        </tr>
      </table>`;

  const emailBody = {
    from: { address: 'outfitify@outfitify.co.uk', name: 'Outfitify' },
    to: [{ email_address: { address: toEmail } }],
    subject,
    htmlbody: `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<style>
  :root { color-scheme: dark; supported-color-schemes: dark; }
  body { margin:0!important; padding:0!important; background-color:#0A0A0A!important; }
  * { -webkit-text-size-adjust:none; }
  @media (prefers-color-scheme: dark) {
    body { background-color:#0A0A0A!important; }
    .email-wrap { background-color:#0A0A0A!important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#0A0A0A;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0A0A0A;">
<tr><td align="center" style="background-color:#0A0A0A;padding:0;">
<table class="email-wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#0A0A0A;border:1px solid #2A2520;font-family:Arial,sans-serif;">

  <tr>
    <td style="background-color:#111111;padding:28px 40px;border-bottom:1px solid #2A2520;text-align:center;">
      <p style="color:#7A6E66;font-size:10px;letter-spacing:4px;margin:0 0 4px 0;text-transform:uppercase;font-family:Arial,sans-serif;">Occasion Style Guide</p>
      <h1 style="color:#F2EDE6;font-size:14px;letter-spacing:5px;margin:0;font-weight:600;font-family:Arial,sans-serif;">OUTFITIFY</h1>
    </td>
  </tr>

  <tr>
    <td style="background-color:#0A0A0A;padding:44px 40px;">
      <h2 style="color:#F2EDE6;font-size:26px;font-weight:300;margin:0 0 12px 0;line-height:1.2;font-family:Arial,sans-serif;">Your ${occasionName} guide is ready.</h2>
      <p style="color:#7A6E66;font-size:14px;line-height:1.7;margin:0 0 32px 0;font-family:Arial,sans-serif;">${introBody}</p>
      
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px 0;">
        <tr>
          <td style="background-color:#F2EDE6;text-align:center;padding:0;">
            <a href="${downloadUrl}" style="display:block;background-color:#F2EDE6;color:#0A0A0A;text-align:center;padding:18px 16px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;text-transform:uppercase;font-family:Arial,sans-serif;">DOWNLOAD MY STYLE GUIDE →</a>
          </td>
        </tr>
      </table>

      ${upsellCard}

      <p style="color:#4A4440;font-size:12px;text-align:center;border-top:1px solid #2A2520;padding-top:20px;margin:0;font-family:Arial,sans-serif;">This link is unique to you. If you have any issues, reply to this email.</p>
    </td>
  </tr>

  <tr>
    <td style="background-color:#111111;border-top:1px solid #2A2520;padding:16px 40px;text-align:center;">
      <p style="color:#4A4440;font-size:10px;letter-spacing:2px;margin:0;font-family:Arial,sans-serif;">OUTFITIFY · MAKING STYLE EFFORTLESS · OUTFITIFY.CO.UK</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`,
  };
  const response = await axios.post('https://api.zeptomail.eu/v1.1/email', emailBody, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: process.env.ZEPTO_SMTP_PASS },
  });
  console.log(`Occasion email sent to ${toEmail}:`, response.data);
}

// ── SEND BUNDLE EMAIL ─────────────────────────────────────────────────────────

async function sendBundleEmail(toEmail, guides, sessionId) {
  const guideButtons = guides.map(g => `
    <div style="margin-bottom:16px">
      <p style="color:#B8A898;font-size:10px;letter-spacing:2px;font-weight:600;margin:0 0 8px;text-transform:uppercase">${g.occasionName}</p>
      <a href="${g.downloadUrl}" style="display:block;background:#F2EDE6;color:#0A0A0A;text-align:center;padding:14px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;text-transform:uppercase">DOWNLOAD ${g.occasionName.toUpperCase()} GUIDE →</a>
    </div>`).join('');

  const emailBody = {
    from: { address: 'outfitify@outfitify.co.uk', name: 'Outfitify' },
    to: [{ email_address: { address: toEmail } }],
    subject: `Your ${guides.length} Occasion Style Guides Are Ready`,
    htmlbody: `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<style>
  :root { color-scheme: dark; supported-color-schemes: dark; }
  body { margin:0!important; padding:0!important; background-color:#0A0A0A!important; }
  * { -webkit-text-size-adjust:none; }
  @media (prefers-color-scheme: dark) {
    body { background-color:#0A0A0A!important; }
    .email-wrap { background-color:#0A0A0A!important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#0A0A0A;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0A0A0A;">
<tr><td align="center" style="background-color:#0A0A0A;padding:0;">
<table class="email-wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#0A0A0A;border:1px solid #2A2520;font-family:Arial,sans-serif;">

  <tr>
    <td style="background-color:#111111;padding:28px 40px;border-bottom:1px solid #2A2520;text-align:center;">
      <p style="color:#7A6E66;font-size:10px;letter-spacing:4px;margin:0 0 4px 0;text-transform:uppercase;font-family:Arial,sans-serif;">Occasion Style Guides</p>
      <h1 style="color:#F2EDE6;font-size:14px;letter-spacing:5px;margin:0;font-weight:600;font-family:Arial,sans-serif;">OUTFITIFY</h1>
    </td>
  </tr>

  <tr>
    <td style="background-color:#0A0A0A;padding:44px 40px;">
      <h2 style="color:#F2EDE6;font-size:26px;font-weight:300;margin:0 0 12px 0;line-height:1.2;font-family:Arial,sans-serif;">Your ${guides.length} guides are ready.</h2>
      <p style="color:#7A6E66;font-size:14px;line-height:1.7;margin:0 0 32px 0;font-family:Arial,sans-serif;">All ${guides.length} of your personalised occasion style guides have been built. Download each one below.</p>
      ${guideButtons}

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;border:1px solid #2A2520;border-left:3px solid #B8A898;">
        <tr>
          <td style="background-color:#111111;padding:24px;">
            <p style="color:#B8A898;font-size:10px;letter-spacing:3px;font-weight:600;margin:0 0 10px 0;text-transform:uppercase;font-family:Arial,sans-serif;">Need another occasion?</p>
            <p style="color:#C8BFB5;font-size:13px;line-height:1.7;margin:0 0 16px 0;font-family:Arial,sans-serif;">Pick up any remaining occasion guides at £2.49 each.</p>
            <a href="https://occasions.outfitify.co.uk" style="display:block;background-color:#B8A898;color:#0A0A0A;text-align:center;padding:14px;font-size:11px;font-weight:600;letter-spacing:3px;text-decoration:none;text-transform:uppercase;font-family:Arial,sans-serif;">BROWSE ALL OCCASIONS →</a>
          </td>
        </tr>
      </table>

      <p style="color:#4A4440;font-size:12px;text-align:center;border-top:1px solid #2A2520;padding-top:20px;margin:0;font-family:Arial,sans-serif;">These links are unique to you. If you have any issues, reply to this email.</p>
    </td>
  </tr>

  <tr>
    <td style="background-color:#111111;border-top:1px solid #2A2520;padding:16px 40px;text-align:center;">
      <p style="color:#4A4440;font-size:10px;letter-spacing:2px;margin:0;font-family:Arial,sans-serif;">OUTFITIFY · MAKING STYLE EFFORTLESS · OUTFITIFY.CO.UK</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`,
  };
  const response = await axios.post('https://api.zeptomail.eu/v1.1/email', emailBody, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: process.env.ZEPTO_SMTP_PASS },
  });
  console.log(`Bundle email sent to ${toEmail}:`, response.data);
}

// ── LEGACY STYLE BLUEPRINT (kept intact for existing blueprint customers) ──────

const sessions = new Map();

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

app.post('/api/free-report', async (req, res) => {
  const { budget, struggles, lifestyle, goal, fit, email } = req.body;
  if (!budget || !email) return res.status(400).json({ error: 'Missing required fields' });
  const sessionId = crypto.randomBytes(16).toString('hex');
  const quizData = { budget, struggles, lifestyle, goal, fit, sessionId };
  saveFreeSession(sessionId, { ...quizData, email, createdAt: Date.now() });
  res.json({ success: true, sessionId });
  generateAndStoreReport(sessionId, quizData, email, 'free').catch(err => {
    console.error(`Free report failed ${sessionId}:`, err);
  });
});

app.post('/api/create-checkout', async (req, res) => {
  const { sessionId, tier } = req.body;
  const resolvedTier = tier || 'standard';
  const quizData = sessions.get(sessionId) || getFreeSession(sessionId);
  if (!quizData) return res.status(400).json({ error: 'Session not found or expired' });
  const tierConfig = {
    standard: { amount: 499, name: 'Outfitify Personal Style Blueprint — Standard' },
    premium:  { amount: 999, name: 'Outfitify Personal Style Blueprint — Premium' },
  };
  const config = tierConfig[resolvedTier] || tierConfig.standard;
  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], customer_creation: 'always', allow_promotion_codes: true,
      line_items: [{ price_data: { currency: 'gbp', product_data: { name: config.name }, unit_amount: config.amount }, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || 'https://success.outfitify.co.uk'}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}&value=${(config.amount/100).toFixed(2)}`,
      metadata: { sessionId, tier: resolvedTier, budget: quizData.budget || '', struggles: quizData.struggles || '', lifestyle: quizData.lifestyle || '', goal: quizData.goal || '', fit: quizData.fit || '' },
    });
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
});

app.get('/api/upgrade-to-premium/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const dl = getDownload(sessionId);
  const quizData = dl?.quizData || sessions.get(sessionId) || getFreeSession(sessionId);
  if (!quizData) return res.redirect('https://quiz.outfitify.co.uk?msg=session_expired');
  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], customer_creation: 'always', allow_promotion_codes: true,
      line_items: [{ price_data: { currency: 'gbp', product_data: { name: 'Outfitify Personal Style Blueprint — Premium' }, unit_amount: 999 }, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || 'https://success.outfitify.co.uk'}?token={CHECKOUT_SESSION_ID}&sid=${sessionId}&value=9.99`,
      metadata: { sessionId, tier: 'premium', budget: quizData.budget || '', struggles: quizData.struggles || '', lifestyle: quizData.lifestyle || '', goal: quizData.goal || '', fit: quizData.fit || '' },
    });
    res.redirect(checkoutSession.url);
  } catch (err) {
    console.error('Upgrade checkout error:', err);
    res.redirect(`https://unlock.outfitify.co.uk?sid=${sessionId}`);
  }
});

// ── LEGACY: GENERATE AND STORE BLUEPRINT REPORT ──────────────────────────────

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
    console.log(`${tier} report ready for session ${sessionId}`);
  } catch (err) {
    console.error(`Report generation failed for ${sessionId}:`, err);
  } finally {
    activeJobs--;
    console.log(`Job done for ${sessionId}. Active jobs remaining: ${activeJobs}`);
  }
}

// ── LEGACY: FETCH PRODUCTS (blueprint product — filters by old Style column) ──

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
  });

  return selected;
}

// ── LEGACY: GENERATE REPORT CONTENT ──────────────────────────────────────────

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
- If you must use a fashion term, explain it immediately in plain English
- Replace jargon with plain English throughout
- Never start with "Remember" or "Note that"
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
- recommendedPieces: 6-9 pieces for paid tiers
- whereToInvest: exactly 4 brands, UK-accessible only
- JSON only, no markdown, no preamble`;

  let parsed = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = message.content[0].text.trim();
      const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(text);
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

// ── LEGACY: BUILD PDF ─────────────────────────────────────────────────────────

async function buildPDF(content, quizData, products, tier = 'standard') {
  const pdfPath = path.join(DOWNLOADS_DIR, `outfitify-${Date.now()}.pdf`);
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
    bg();
    doc.rect(0, 40, PW, 200).fill('#0E0C0A');
    doc.moveTo(0, 240).lineTo(PW, 240).strokeColor(BORDER).lineWidth(0.5).stroke();
    pageHeader('Your Free Style Starter');

    const nameParts = (content.styleIdentity?.name || 'YOUR STYLE').split(' ');
    doc.fontSize(54).fillColor(WHITE).font('Helvetica-Bold').text((nameParts[0] || '').toUpperCase(), PAD, 60);
    doc.fontSize(54).fillColor(GREEN).font('Helvetica-Bold').text((nameParts.slice(1).join(' ') || '').toUpperCase(), PAD, 118);
    doc.fontSize(10).fillColor(GREY).font('Helvetica-Oblique').text(content.styleIdentity?.tagline || '', PAD, 194, { width: IW });

    const introText = content.styleIdentity?.intro || '';
    const introH = Math.max(textH(introText, 10, 'Helvetica', IW - 28) + 36, 72);
    lcard(PAD, 256, IW, introH, GREEN);
    doc.fontSize(10).fillColor(MUTED).font('Helvetica').text(introText, PAD + 14, 272, { width: IW - 28, lineGap: 3 });

    const paletteY = 256 + introH + 20;
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold').text('YOUR COLOURS', PAD, paletteY, { characterSpacing: 3 });
    doc.moveTo(PAD, paletteY + 12).lineTo(PAD + IW, paletteY + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
    const sw = 80, swGap = 16, swatchY = paletteY + 24;
    (content.colourPalette?.colours || []).slice(0, 3).forEach((hex, i) => {
      doc.rect(PAD + i * (sw + swGap), swatchY, sw, sw).fill(hex);
    });
    doc.fontSize(7).fillColor(GREY).font('Helvetica').text('Colour names and usage guide unlocked in your full blueprint', PAD, swatchY + sw + 8, { width: IW });

    const diagY = swatchY + sw + 36;
    doc.fontSize(6.5).fillColor(GREEN).font('Helvetica-Bold').text("THE PROBLEM WE'VE SPOTTED", PAD, diagY, { characterSpacing: 3 });
    doc.moveTo(PAD, diagY + 12).lineTo(PAD + IW, diagY + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
    lcard(PAD, diagY + 20, IW, 60, GREEN);
    doc.fontSize(12).fillColor(WHITE).font('Helvetica-Bold').text(content.diagnosis?.headline || '', PAD + 16, diagY + 32, { width: IW - 32, lineGap: 2 });

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

    const avoidText = content.styleDNA?.avoid || '';
    if (avoidText && curY + 80 < SAFE_BOTTOM) {
      const avoidCardH = Math.max(textH(avoidText, 9.5, 'Helvetica', IW - 28) + 28, 48);
      doc.fontSize(6.5).fillColor(RED).font('Helvetica-Bold').text('STOP DOING THIS — ONE FREE INSIGHT', PAD, curY, { characterSpacing: 3 });
      doc.moveTo(PAD, curY + 12).lineTo(PAD + IW, curY + 12).strokeColor(BORDER).lineWidth(0.5).stroke();
      lcard(PAD, curY + 20, IW, avoidCardH, RED);
      doc.fontSize(9.5).fillColor(MUTED).font('Helvetica').text(avoidText, PAD + 14, curY + 32, { width: IW - 28, lineGap: 3 });
    }

    footer();

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
  [["Why It's Not Working", 'The real reason — specific to your answers'], ['Your Style DNA', 'What to wear, how it should fit and what to avoid'], ['What To Buy First', "5 priorities in order — your stylist's sequence"], ['Your Personal Edit', 'Hand-picked pieces with clickable links and prices']].forEach(([title, desc], i) => {
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
    try {
      const r = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.zara.com/',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });
      return Buffer.from(r.data);
    } catch { return null; }
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
      doc.save();
      try { doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).clip(); doc.image(imageBuffers[i], PAD + IMG_PAD, imgY, { width: IMG_W, height: IMG_W, cover: [IMG_W, IMG_W] }); }
      catch { doc.rect(PAD + IMG_PAD, imgY, IMG_W, IMG_W).fill(CARD2); }
      finally { doc.restore(); }
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

// ── LEGACY: SEND EMAIL ────────────────────────────────────────────────────────

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
    `,
  };

  const response = await axios.post('https://api.zeptomail.eu/v1.1/email', emailBody, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: process.env.ZEPTO_SMTP_PASS },
  });
  console.log(`${tier} email sent to ${toEmail}:`, response.data);
}

// ── START SERVER ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Outfitify backend running on port ${PORT}`));
