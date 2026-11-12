// The page that asks for a device id and token, shown by /files, /mcp and
// /mcp/{device} until the pair has been checked. It posts to /api/session; on
// success the credential is in a cookie and the page reloads into its content.
// Styled from the same stylesheet as every other page.

import { FAVICON, UI_CSS } from "./ui-css";
import { TOASTS_HTML, TOAST_SCRIPT } from "./ui-toast";
import { esc } from "./files-ui";

export function renderGatePage(opts: { title: string; device: string | null; next: string; error?: string }): string {
  const device = opts.device ?? "";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <meta name="referrer" content="no-referrer" />',
    "    <title>Prime - " + esc(opts.title) + "</title>",
    '    <link rel="icon" href="' + FAVICON + '" />',
    '    <link rel="preconnect" href="https://fonts.googleapis.com" />',
    '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
    '    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />',
    "    <style>" + UI_CSS + "    </style>",
    "  </head>",
    "  <body>",
    "    <h1>" + esc(opts.title) + "</h1>",
    '    <div class="sub">sign-in</div>',
    '    <form id="gate">',
    '      <div class="box" style="display:block;padding:14px 16px">',
    '        <label class="gate-label" for="gate-device">ID</label>',
    '        <input id="gate-device" class="gate-input" type="text" autocomplete="username" spellcheck="false" value="' + esc(device) + '"' + (device ? " readonly" : "") + " />",
    '        <label class="gate-label" for="gate-token">Token</label>',
    '        <input id="gate-token" class="gate-input" type="password" autocomplete="current-password" spellcheck="false" />',
    "    " + TOASTS_HTML,
    '        <div class="dlg-bar" style="padding:12px 0 0"><button class="btn" id="gate-go" type="submit">Unlock</button></div>',
    "      </div>",
    "    </form>",
    "    <style>",
    "      .gate-label { display:block; font-size:10px; color:#999; text-transform:uppercase; letter-spacing:0.8px; margin:10px 0 4px; }",
    "      .gate-label:first-child { margin-top:0; }",
    "      .gate-input { font: inherit; font-size: 13px; width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #ddd; background: #fff; color: #111; }",
    "      .gate-input:focus { outline: none; border-color: #111; }",
    "      .gate-input[readonly] { color: #666; background: #fafafa; }",
    "    </style>",
    "    <script>",
    "      (function () {",
    "        var form = document.getElementById('gate');",
    "        var deviceEl = document.getElementById('gate-device');",
    "        var tokenEl = document.getElementById('gate-token');",
    "        var go = document.getElementById('gate-go');",
    ...TOAST_SCRIPT.split("\n"),
    "        function fail(msg) { toast(msg, 'error'); }",
    "        form.addEventListener('submit', function (e) {",
    "          e.preventDefault();",
    "          var device = (deviceEl.value || '').trim(), token = tokenEl.value || '';",
    "          if (!device || !token) { fail('Enter the ID and the token.'); return; }",
    "          go.disabled = true;",
    "          fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ device: device, token: token }) })",
    "            .then(function (r) {",
    "              if (r.ok) return checkCookie();",
    "              go.disabled = false;",
    "              if (r.status === 403) return r.json().then(function (j) { fail(j.error === 'device disabled' ? 'That device is disabled.' : 'Refused.'); }, function () { fail('Refused.'); });",
    "              if (r.status === 401) { fail('That ID and token do not match.'); return; }",
    "              fail('Could not sign in (HTTP ' + r.status + ').');",
    "            })",
    "            .catch(function (err) { go.disabled = false; fail('Network error: ' + (err && err.message || err)); });",
    "        });",
    "        // The pair was accepted; make sure this browser will actually send the",
    "        // session back before leaving the form.",
    "        function checkCookie() {",
    "          fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })",
    "            .then(function (r) {",
    "              if (r.ok) { window.location.replace(" + JSON.stringify(opts.next) + "); return; }",
    "              go.disabled = false;",
    "              fail('Signed in, but this browser is not keeping the session cookie - allow cookies for this site, or open this page in its own tab.');",
    "            })",
    "            .catch(function () { go.disabled = false; fail('Signed in, but the session could not be checked - reload the page and try again.'); });",
    "        }",
    "        (deviceEl.value ? tokenEl : deviceEl).focus();",
    "      })();",
    "    </script>",
    "  </body>",
    "</html>",
  ].join("\n");
}

/** The sign-in form as a response, with the CSP the pages use. */
export function gateResponse(opts: { request: Request; title: string; device: string | null; next: string; error?: string }): Response {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  if (opts.request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(renderGatePage(opts), { headers });
}
