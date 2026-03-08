# Outfitify Backend — Setup Guide

## What this is
A Node.js backend that:
1. Receives quiz answers from your unlock page
2. Creates a Stripe checkout session
3. After payment, reads your Google Sheet product database
4. Calls Claude AI to generate personalised outfit content
5. Builds a branded PDF with product images
6. Serves it as an instant download
7. Sends a backup email via ZeptoMail

---

## Step 1 — Deploy to Railway (free)

1. Go to railway.app and sign up with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Upload this folder as a GitHub repo first (github.com → new repo → upload files)
4. Railway will detect Node.js and deploy automatically
5. Copy your Railway URL (e.g. https://outfitify-backend.railway.app)

---

## Step 2 — Set environment variables in Railway

In Railway dashboard → your project → Variables, add each line from .env.example:

- STRIPE_SECRET_KEY → from stripe.com → Developers → API Keys
- STRIPE_WEBHOOK_SECRET → set up webhook first (Step 4)
- ANTHROPIC_API_KEY → from console.anthropic.com
- GOOGLE_SHEET_ID → already filled in (your sheet ID)
- GOOGLE_SERVICE_ACCOUNT_JSON → see Step 3
- ZEPTO_SMTP_USER → "emailapikey" (literal string)
- ZEPTO_SMTP_PASS → your ZeptoMail API key
- BASE_URL → your Railway URL
- UNLOCK_PAGE_URL → https://unlock.outfitify.co.uk

---

## Step 3 — Google Sheets access

1. Go to console.cloud.google.com
2. Create a new project → Enable "Google Sheets API"
3. Create a Service Account → download JSON key
4. Copy the entire JSON content into GOOGLE_SERVICE_ACCOUNT_JSON env var
5. In your Google Sheet → Share → paste the service account email → Viewer access

---

## Step 4 — Stripe setup

1. Go to stripe.com → sign up
2. Developers → API Keys → copy Secret Key → STRIPE_SECRET_KEY
3. Developers → Webhooks → Add endpoint:
   - URL: https://your-railway-app.railway.app/webhook
   - Event: checkout.session.completed
4. Copy the Webhook Signing Secret → STRIPE_WEBHOOK_SECRET

---

## Step 5 — Update your HTML files

In unlock.html and success.html, replace:
  BACKEND_URL
with your actual Railway URL, e.g.:
  https://outfitify-backend.railway.app

---

## Step 6 — Deploy HTML files to Netlify

1. Upload unlock.html to Netlify as unlock.outfitify.co.uk
2. Upload success.html to Netlify as success.outfitify.co.uk
   (or as pages within your existing Netlify site)

---

## Step 7 — Connect Tally quiz

In Tally → your form → Settings → Redirects:
Set redirect URL to:
  https://unlock.outfitify.co.uk?style={What style are you going for?}&budget={How much would you Ideally spend}&colours={Any colour preferences?}&struggles={What do you struggle the most with}&email={Where are we sending your FREE fits?}

Map each {field} to the actual Tally field name from your form.

---

## Step 8 — Turn off free results in Make

In your Make scenario, disable or delete the step that sends the free results email.
Your ZeptoMail template can stay — it'll now only send the backup download link.

---

## That's it. The full flow is:

Tally quiz → unlock.outfitify.co.uk → Stripe £9.99 →
success.outfitify.co.uk (shows loading) →
Backend generates PDF → Download button appears →
Backup email sent via ZeptoMail

---

## Running costs
- Railway: Free tier (500 hrs/month)
- Stripe: 1.4% + 20p per transaction (£0.34 per £9.99 sale)
- Anthropic API: ~£0.02 per PDF generated
- ZeptoMail: existing setup
- Total cost per sale: ~£0.36

Profit per sale at £9.99: ~£9.63
