<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your Style Guide — Outfitify</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,700;1,500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">

<!-- Meta Pixel Base Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '869679278931485');
fbq('track', 'PageView');
</script>
<noscript>
  <img height="1" width="1" style="display:none"
    src="https://www.facebook.com/tr?id=869679278931485&ev=PageView&noscript=1"/>
</noscript>
<!-- End Meta Pixel Base Code -->

<style>
  :root {
    --tan: #92714a;
    --tan-dark: #7a5d3c;
    --cream: #f5f0e8;
    --card: #ffffff;
    --ink: #1c1a17;
    --grey: #8a8378;
    --border: #e8e0d2;
    --success-green: #4a7a5e;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background:var(--cream); color:var(--ink);
    font-family:'DM Sans',sans-serif;
    min-height:100vh; display:flex; flex-direction:column;
    align-items:center; justify-content:center; padding:24px;
  }

  .card {
    background:var(--card); border:1px solid var(--border);
    border-radius:18px; padding:48px 40px;
    max-width:480px; width:100%; text-align:center;
    box-shadow: 0 2px 24px rgba(28,26,23,0.06);
  }

  .logo {
    font-family:'Playfair Display',serif; font-weight:700;
    font-size:20px; letter-spacing:3px; color:var(--ink);
    margin-bottom:36px; display:block;
  }
  .logo span { color:var(--tan); }

  .state { display:none; }
  .state.active { display:block; }

  .spinner {
    width:52px; height:52px; border:3px solid var(--border);
    border-top-color:var(--tan); border-radius:50%;
    animation:spin 0.9s linear infinite; margin:0 auto 28px;
  }
  @keyframes spin { to { transform:rotate(360deg); } }

  h2 {
    font-family:'Playfair Display',serif; font-weight:700;
    font-size:32px; line-height:1.2; margin-bottom:14px;
  }
  h2 em { font-style:italic; color:var(--tan); font-weight:500; }

  p { color:var(--grey); font-size:15px; line-height:1.7; margin-bottom:26px; }

  .progress-bar {
    background:var(--border); border-radius:100px;
    height:5px; overflow:hidden; margin-bottom:12px;
  }
  .progress-fill {
    height:100%; background:var(--tan);
    border-radius:100px;
    animation-name: progress; animation-duration: 170s;
    animation-timing-function: linear; animation-fill-mode: forwards;
  }
  @keyframes progress { from{width:5%} to{width:95%} }
  .progress-label { font-size:12px; color:var(--grey); letter-spacing:0.3px; }

  .steps { display:flex; flex-direction:column; gap:8px; margin:26px 0 4px; text-align:left; }
  .step {
    display:flex; align-items:center; gap:12px;
    padding:12px 16px; background:var(--cream);
    border-radius:10px; border:1px solid var(--border);
  }
  .step-icon { font-size:16px; flex-shrink:0; }
  .step-text { font-size:13px; color:var(--grey); }
  .step.done .step-text { color:var(--ink); font-weight:500; }
  .step-check { margin-left:auto; font-size:15px; color:var(--tan); opacity:0; transition:opacity 0.3s; }
  .step.done .step-check { opacity:1; }

  .tick-circle {
    width:76px; height:76px; border-radius:50%;
    background:#f0ede4; border:2px solid var(--tan);
    display:flex; align-items:center; justify-content:center;
    margin:0 auto 26px; font-size:32px; color:var(--tan);
    animation:pop 0.4s cubic-bezier(0.175,0.885,0.32,1.275);
  }
  @keyframes pop { from{transform:scale(0)} to{transform:scale(1)} }

  .download-btn {
    display:block; width:100%;
    background:var(--tan); color:#fff;
    font-family:'DM Sans',sans-serif;
    font-size:15px; font-weight:700; letter-spacing:0.5px;
    text-transform:uppercase;
    padding:18px 32px; border-radius:10px; border:none; cursor:pointer;
    text-decoration:none; margin-bottom:16px;
    transition:background 0.15s, transform 0.15s;
  }
  .download-btn:hover { background:var(--tan-dark); transform:translateY(-1px); }

  .backup-note { font-size:12px; color:var(--grey); margin-top:4px; }
  .backup-note a { color:var(--tan); text-decoration:none; font-weight:600; }

  .error-icon { font-size:40px; margin-bottom:18px; }
  .retry-btn {
    display:inline-block; background:transparent;
    border:1.5px solid var(--tan); color:var(--tan-dark);
    padding:13px 32px; border-radius:10px; font-size:14px;
    font-weight:700; cursor:pointer; text-decoration:none;
  }
  .retry-btn:hover { background:var(--cream); }
</style>
</head>
<body>
<div class="card">
  <span class="logo">OUTFIT<span>I</span>FY</span>

  <!-- LOADING STATE -->
  <div class="state active" id="stateLoading">
    <div class="spinner"></div>
    <h2>Building Your <em>Guide</em></h2>
    <p>Our AI is putting together your personalised outfit right now. This usually takes 30–45 seconds.</p>
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    <div class="progress-label" id="progressLabel">Analysing your style profile...</div>
    <div class="steps">
      <div class="step" id="step1"><div class="step-icon">🧠</div><div class="step-text">Analysing your quiz answers</div><div class="step-check">✓</div></div>
      <div class="step" id="step2"><div class="step-icon">🛍️</div><div class="step-text">Selecting products from our database</div><div class="step-check">✓</div></div>
      <div class="step" id="step3"><div class="step-icon">✨</div><div class="step-text">Generating your personalised outfit</div><div class="step-check">✓</div></div>
      <div class="step" id="step4"><div class="step-icon">📄</div><div class="step-text">Building your PDF guide</div><div class="step-check">✓</div></div>
    </div>
  </div>

  <!-- SUCCESS STATE -->
  <div class="state" id="stateSuccess">
    <div class="tick-circle">✓</div>
    <h2>Your Guide Is <em>Ready</em></h2>
    <p>Your personalised style guide is ready to download — the exact outfit, why it works, and where to buy it.</p>
    <a class="download-btn" id="downloadBtn" href="#" download="Outfitify-Style-Guide.pdf">
      Download My Style Guide
    </a>
    <div class="backup-note">A backup download link has also been sent to your email.</div>
  </div>

  <!-- ERROR STATE -->
  <div class="state" id="stateError">
    <div class="error-icon">⏳</div>
    <h2>Taking A Little <em>Longer</em></h2>
    <p>Your guide is still being generated. Check your email in a few minutes — we'll send it there automatically.</p>
    <a class="retry-btn" href="https://outfitify.co.uk">Back to Outfitify</a>
  </div>
</div>

<script>
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sid');
  const purchaseValue = parseFloat(params.get('value')) || 2.49; // fallback only if value is ever missing
  const BACKEND = 'BACKEND_URL';

  let pollCount = 0;
  const MAX_POLLS = 60; // 180 seconds max — webhook delivery + generation can take longer than 90s
  let stepTimer;

  // Animate steps
  const stepDelays = [3000, 8000, 16000, 28000];
  stepDelays.forEach((delay, i) => {
    setTimeout(() => {
      document.getElementById(`step${i+1}`).classList.add('done');
    }, delay);
  });

  const labels = [
    'Analysing your style profile...',
    'Matching products to your budget...',
    'Writing your personalised style story...',
    'Adding finishing touches...',
    'Almost ready...'
  ];
  let labelIdx = 0;
  const labelInterval = setInterval(() => {
    labelIdx = (labelIdx + 1) % labels.length;
    document.getElementById('progressLabel').textContent = labels[labelIdx];
  }, 8000);

  // Poll for readiness
  async function poll() {
    if (!sessionId) { showError(); return; }

    try {
      const res = await fetch(`${BACKEND}/api/report-status/${sessionId}`);
      const data = await res.json();

      if (data.ready && data.downloadToken) {
        clearInterval(labelInterval);
        showSuccess(data.downloadToken);
      } else {
        pollCount++;
        if (pollCount >= MAX_POLLS) {
          showError();
        } else {
          setTimeout(poll, 3000);
        }
      }
    } catch (err) {
      pollCount++;
      if (pollCount >= MAX_POLLS) showError();
      else setTimeout(poll, 3000);
    }
  }

  function showSuccess(token) {
    document.getElementById('stateLoading').classList.remove('active');
    document.getElementById('stateSuccess').classList.add('active');
    document.getElementById('downloadBtn').href = `${BACKEND}/api/download/${token}`;

    // Fire Meta Pixel Purchase event with the actual amount paid
    if (typeof fbq !== 'undefined') {
      fbq('track', 'Purchase', {
        value: purchaseValue,
        currency: 'GBP'
      });
    }
  }

  function showError() {
    document.getElementById('stateLoading').classList.remove('active');
    document.getElementById('stateError').classList.add('active');
  }

  // Start polling after a short delay
  setTimeout(poll, 5000);
</script>
</body>
</html>
