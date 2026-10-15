const fs = require('fs');
const path = require('path');

const DIST_HTML_PATH = path.join(__dirname, '..', 'dist', 'index.html');

if (!fs.existsSync(DIST_HTML_PATH)) {
  console.log('⚠️ dist/index.html not found, skipping startup diagnostic injection.');
  process.exit(0);
}

let html = fs.readFileSync(DIST_HTML_PATH, 'utf8');

const headDiagnosticScript = `
    <!-- MeriBaari Pre-React Startup Diagnostic & Error Capture -->
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <script>
      (function() {
        window.__mb_errors = [];
        window.__mb_show_error = function() {
          var fb = document.getElementById('mb-startup-fallback');
          var errBox = document.getElementById('mb-error-box');
          var msg = document.getElementById('mb-fallback-msg');
          if (fb) fb.style.display = 'flex';
          if (errBox) {
            errBox.style.display = 'block';
            errBox.textContent = window.__mb_errors.join('\\n');
          }
          if (msg) msg.textContent = 'A loading error occurred before the app could start:';
        };

        window.addEventListener('error', function(e) {
          var text = (e && e.message) || String(e || 'Unknown error');
          var file = (e && e.filename) ? (e.filename.split('/').pop() + ':' + (e.lineno || '')) : '';
          var full = text + (file ? ' [' + file + ']' : '');
          window.__mb_errors.push(full);
          console.error('[MeriBaari Startup Error]', e);
          window.__mb_show_error();
        });

        window.addEventListener('unhandledrejection', function(e) {
          var r = e && e.reason;
          var text = (r && r.message) || String(r || 'Unhandled rejection');
          window.__mb_errors.push('Promise: ' + text);
          console.error('[MeriBaari Unhandled Rejection]', e);
          window.__mb_show_error();
        });

        window.__mb_recover = async function() {
          var btn = document.getElementById('mb-recovery-btn');
          if (btn) btn.innerText = 'Clearing Cache & Workers...';
          try {
            if ('serviceWorker' in navigator) {
              var regs = await navigator.serviceWorker.getRegistrations();
              for (var i = 0; i < regs.length; i++) {
                await regs[i].unregister();
              }
            }
            if ('caches' in window) {
              var keys = await caches.keys();
              for (var j = 0; j < keys.length; j++) {
                await caches.delete(keys[j]);
              }
            }
            if (window.sessionStorage) sessionStorage.clear();
          } catch (err) {
            console.error('Clear failed:', err);
          }
          var u = new URL(window.location.href);
          u.searchParams.set('t', Date.now().toString());
          window.location.replace(u.toString());
        };
      })();
    </script>
`;

const bodyDiagnosticMarkup = `
    <!-- MeriBaari Pre-React Startup Fallback & Recovery UI -->
    <div id="mb-startup-fallback" style="display:none; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; position:fixed; inset:0; z-index:99999; background:#F8FAFC; color:#0F172A; text-align:center; flex-direction:column; align-items:center; justify-content:center; padding:20px; box-sizing:border-box;">
      <div style="background:#FFFFFF; max-width:380px; width:100%; border-radius:16px; padding:28px 24px; box-shadow:0 10px 25px -5px rgba(0,0,0,0.1); border:1px solid #E2E8F0;">
        <div style="width:48px; height:48px; border-radius:12px; background:#E0F2FE; color:#0369A1; display:flex; align-items:center; justify-content:center; margin:0 auto 16px; font-size:22px; font-weight:bold;">MB</div>
        <h2 style="font-size:18px; font-weight:700; margin:0 0 8px; color:#0F172A;">MeriBaari Startup</h2>
        <p id="mb-fallback-msg" style="font-size:14px; color:#64748B; margin:0 0 16px; line-height:1.5;">The app is taking longer than usual to load on this browser.</p>
        <div id="mb-error-box" style="display:none; text-align:left; background:#FEF2F2; border:1px solid #FCA5A5; border-radius:8px; padding:10px 12px; margin-bottom:16px; font-size:12px; color:#991B1B; word-break:break-word; max-height:120px; overflow-y:auto; font-family:monospace;"></div>
        <button id="mb-recovery-btn" onclick="window.__mb_recover()" style="background:#0369A1; color:#FFFFFF; border:none; border-radius:8px; padding:12px 20px; font-size:14px; font-weight:600; width:100%; cursor:pointer; margin-bottom:8px;">Reset Cache & Reload</button>
        <button onclick="window.location.reload(true)" style="background:#F1F5F9; color:#475569; border:none; border-radius:8px; padding:10px 20px; font-size:13px; font-weight:500; width:100%; cursor:pointer;">Simple Reload</button>
      </div>
    </div>
    <script>
      (function() {
        var root = document.getElementById('root');
        var fb = document.getElementById('mb-startup-fallback');
        
        // Hide fallback immediately when React renders anything inside #root
        if (root && window.MutationObserver) {
          var observer = new MutationObserver(function() {
            if (root.children.length > 0) {
              if (fb) fb.style.display = 'none';
              observer.disconnect();
            }
          });
          observer.observe(root, { childList: true });
        }

        // If root is still empty after 3.5s, display fallback recovery card
        setTimeout(function() {
          if (root && root.children.length === 0) {
            if (fb) fb.style.display = 'flex';
          }
        }, 3500);
      })();
    </script>
`;

// Inject head diagnostic script before </head>
if (!html.includes('__mb_errors')) {
  html = html.replace('</head>', `${headDiagnosticScript}</head>`);
}

// Inject body diagnostic markup before <div id="root">
if (!html.includes('id="mb-startup-fallback"')) {
  html = html.replace('<div id="root">', `${bodyDiagnosticMarkup}<div id="root">`);
}

fs.writeFileSync(DIST_HTML_PATH, html, 'utf8');
console.log('✅ Injected pre-React startup diagnostics and recovery UI into dist/index.html');
