// HTML for the temporary-file pages: GET /files (manage) and GET /files/{id}
// (download). Styled from the same stylesheet as /admin so the two match
// exactly; only the file-specific bits (the grey pending dot, the column
// layout, the download icon) are added here.

import { FAVICON, UI_CSS } from "./ui-css";
import type { FileLimits } from "./config";

const FILES_CSS = `
      /* The admin page's 540px column is sized for one input per row. A file row
         carries four columns plus a menu, and a locked file adds a key prompt on
         top of that, so these pages need a little more room or the filename
         collapses to an ellipsis. Everything else - colours, borders, type,
         components - is the admin page's stylesheet, unchanged. */
      body {
        width: 720px;
      }
      /* File rows: name | expiry | protected key | menu. */
      .cols {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .fname {
        flex: 1;
        min-width: 0;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* Size sits before the expiry so a row reads name | size | expiry | key. */
      .fsize {
        width: 78px;
        flex: none;
        font-size: 12px;
        color: #666;
        text-align: right;
      }
      .fexp {
        width: 132px;
        flex: none;
        font-size: 12px;
        color: #666;
      }
      .fkey {
        width: 110px;
        flex: none;
        font-size: 12px;
        color: #666;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fexp.soon {
        color: #b91c1c;
      }
      /* Grey = reserved but not uploaded yet (see FilesDO status). */
      .dot.pending {
        background: #ccc;
      }
      .opts {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        font-size: 11px;
        color: #666;
      }
      .opts select,
      .opts input {
        font-family: inherit;
        font-size: 11px;
        border: 1px solid #111;
        background: #fff;
        padding: 3px 5px;
      }
      .opts input {
        flex: 1;
        min-width: 0;
      }
      /* The key prompt sits in the same row as the columns, so it must not
         compete for width: the filename has to stay readable. */
      .kform {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: none;
      }
      .kform input {
        width: 140px;
        font-family: inherit;
        font-size: 11px;
        border: 1px solid #111;
        background: #fff;
        padding: 3px 5px;
      }
      .dl {
        width: 28px;
        height: 28px;
        flex: none;
        border: 1px solid #111;
        background: #fff;
        color: #111;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
      }
      .dl:hover {
        background: #f5f5f5;
      }
      .dl svg {
        width: 14px;
        height: 14px;
        fill: currentColor;
      }
      .meta {
        font-size: 12px;
        color: #666;
        margin-bottom: 14px;
      }
      .meta b {
        color: #111;
      }

      /* Last in the sheet on purpose: these override rules of equal specificity
         above, and a media query does not win on its own - only source order
         does. The width override also has to beat the admin page's own mobile
         query, which is emitted before this file. */
      @media (max-width: 760px) {
        body {
          width: auto;
          margin: 24px 14px;
        }
        /* Four fixed columns cannot fit a phone, so the name takes its own line
           and the expiry and key move beneath it. */
        .cols {
          flex-wrap: wrap;
          row-gap: 2px;
        }
        .fname {
          flex: 1 0 100%;
          min-width: 0;
        }
        .fexp,
        .fkey {
          width: auto;
          flex: 0 0 auto;
        }
      }
`;


const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-4.7 1.4-1.4L12 13.6V3h0zM5 19h14v2H5z"/></svg>';

/** Escape for HTML text and attribute contexts. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function head(title: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    // The download page URL can carry ?key=..., so stop it leaking through the
    // Referer header to the fonts CDN (or anywhere else).
    '    <meta name="referrer" content="no-referrer" />',
    "    <title>" + esc(title) + "</title>",
    '    <link rel="icon" href="' + FAVICON + '" />',
    '    <link rel="preconnect" href="https://fonts.googleapis.com" />',
    '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
    '    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />',
    "    <style>",
    UI_CSS + FILES_CSS,
    "    </style>",
    "  </head>",
  ].join("\n");
}

function browserScript(): string {
  // Plain ES5-style DOM code, no build step, no dependencies.
  return [
    "      (function () {",
    "        var listEl = document.getElementById('list');",
    "        var statusEl = document.getElementById('status');",
    "        var addBtn = document.getElementById('addBtn');",
    "        var picker = document.getElementById('picker');",
    // Never render a protection key: it is a secret, and the owner has no need to
    // read it back - "Copy link" carries it into a shareable URL instead.
    "        var MASK = '\u2022\u2022\u2022\u2022\u2022\u2022';",
    // Card tints: blue while bytes are moving, red if the upload failed.
    "        var FILL = '#dbeafe';",
    "        var FAIL = '#fee2e2';",
    "        var nextQid = 1;",
    "        var queued = [];",
    "        var files = window.__FILES__ || [];",
    "        var usageEl = document.getElementById('usage');",
    "        var budgetEl = document.getElementById('budget');",
    // What the account is spending on R2 this month, against the configured cap.
    "        function showBudget(b) {",
    "          if (!budgetEl || !b) return;",
    "          budgetEl.textContent = 'R2 this month: $' + Number(b.cost_usd).toFixed(4) + ' of $' + Number(b.budget_usd).toFixed(2) + ' (' + fmtBytes(Number(b.max_bytes)) + ' budgeted storage)';",
    "        }",
    "        function setStatus(msg, isErr) { statusEl.textContent = msg || ''; statusEl.style.color = isErr ? '#b91c1c' : '#666'; }",
    "        function human(ms) {",
    "          if (ms <= 0) return 'expired';",
    "          var m = Math.floor(ms / 60000);",
    "          if (m < 60) return 'in ' + m + ' min';",
    "          var h = Math.round(m / 60);",
    "          if (h < 48) return 'in ' + h + ' h';",
    "          return 'in ' + Math.round(h / 24) + ' days';",
    "        }",
    "        function dotClass(f) {",
    "          if (f.status !== 'ready') return 'dot pending';",
    "          return 'dot ' + (f.expires_in_ms <= 3 * 86400000 ? 'off' : 'on');",
    "        }",
    "        function row(dot, name, size, expiry, key, menuItems, cell, qid) {",
    "          var li = document.createElement('li');",
    "          li.className = 'row';",
    "          var d = document.createElement('span');",
    "          d.className = dot;",
    "          li.appendChild(d);",
    "          var box = document.createElement('div');",
    "          box.className = 'box';",
    "          if (qid) box.dataset.qid = qid;",
    "          else box.style.background = '#fff';",
    "          var cols = document.createElement('div');",
    "          cols.className = 'cols';",
    "          var n = document.createElement('div'); n.className = 'fname'; n.textContent = name;",
    "          var s = document.createElement('div'); s.className = 'fsize'; s.textContent = size;",
    "          var e = document.createElement('div'); e.className = expiry.soon ? 'fexp soon' : 'fexp'; e.textContent = expiry.text;",
    "          var k = document.createElement('div'); k.className = 'fkey'; k.textContent = key;",
    "          cols.appendChild(n); cols.appendChild(s); cols.appendChild(e); cols.appendChild(k);",
    "          box.appendChild(cols);",
    "          if (cell) box.appendChild(cell);",
    "          var wrap = document.createElement('div'); wrap.className = 'menu-wrap';",
    "          var btn = document.createElement('button');",
    "          btn.className = 'menu-btn'; btn.type = 'button'; btn.textContent = '\u22ef';",
    "          var menu = document.createElement('div'); menu.className = 'menu';",
    "          menuItems.forEach(function (item) {",
    "            var b = document.createElement('button');",
    "            b.type = 'button'; b.textContent = item.label;",
    "            if (item.danger) b.className = 'danger';",
    "            if (item.disabled) b.disabled = true;",
    "            b.addEventListener('click', function (ev) { ev.stopPropagation(); item.run(); });",
    "            menu.appendChild(b);",
    "          });",
    "          btn.addEventListener('click', function (ev) {",
    "            ev.stopPropagation();",
    "            var open = menu.classList.contains('open');",
    "            closeMenus();",
    "            if (!open) menu.classList.add('open');",
    "          });",
    "          wrap.appendChild(btn); wrap.appendChild(menu);",
    "          box.appendChild(wrap);",
    "          li.appendChild(box);",
    "          return li;",
    "        }",
    "        function closeMenus() {",
    "          Array.prototype.forEach.call(document.querySelectorAll('.menu.open'), function (m) { m.classList.remove('open'); });",
    "        }",
    "        document.addEventListener('click', closeMenus);",
    "        function render() {",
    "          listEl.innerHTML = '';",
    "          files.forEach(function (f) {",
  
    "            listEl.appendChild(row(",
    "              dotClass(f), f.name,",
    "              f.size ? fmtBytes(f.size) : '-',",
    "              { text: f.status === 'ready' ? human(f.expires_in_ms) : 'not uploaded', soon: f.status === 'ready' && f.expires_in_ms <= 3 * 86400000 },",
    "              f.protected ? MASK : '-',",
    "              [",
    "                { label: 'Save', run: function () { saveFile(f); } },",
    "                { label: 'Copy link', run: function () { copy(f.page_url); } },",
    "                { label: 'Delete', danger: true, run: function () { remove(f.id); } }",
    "              ]",
    "            ));",
    "          });",
    "          queued.forEach(function (q) {",
    "            listEl.appendChild(box = row(",
    "              'dot pending', q.file.name,",
    "              q.file.size ? fmtBytes(q.file.size) : '-',",
    "              { text: 'not uploaded', soon: false },",
    "              '-',",
    "              [",
    "                { label: 'Upload', run: function () { send(q); } },",
    "                { label: 'Delete', danger: true, run: function () { queued.splice(queued.indexOf(q), 1); render(); } }",
    "              ],",
    "              null, q.qid",
    "            ));",
    "          });",
    "          if (files.length === 0 && queued.length === 0) {",
    "            var empty = document.createElement('div');",
    "            empty.className = 'empty';",
    "            empty.textContent = 'No files. Use + to choose one, then Upload.';",
    "            listEl.appendChild(empty);",
    "          }",
    "          if (usageEl) usageEl.textContent = files.length + '/' + window.__LIMITS__.max_files + ' files, ' + fmtBytes(window.__USAGE__.bytes) + ' of ' + fmtBytes(window.__LIMITS__.max_total_bytes);",
    "        }",
    "        function fmtBytes(n) {",
    "          if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MiB';",
    "          if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';",
    "          return n + ' B';",
    "        }",
    // A plain navigation: the browser replays the device Basic credentials, which
    // the gateway accepts in place of a key for the owner, and streams the body
    // natively (no blob in memory). So the page never needs the key itself.
    "        function saveFile(f) {",
    "          setStatus('downloading ' + f.name + ' ...');",
    "          window.location = f.download_url;",
    "        }",
    "        function copy(text) {",
    "          if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { setStatus('link copied'); }, function () { setStatus(text); });",
    "          else setStatus(text);",
    "        }",
    // XHR rather than fetch so a large upload can report progress; the browser
    // also sets Content-Length for a File body, which keeps the upload on the
    // streamed (non-multipart) path.
    "        function send(q) {",
    // Uploads from this page are unprotected and take the maximum lifetime - both
    // remain REST-API options (key=, expiry_days=), not page controls.
    "          var url = '/api/files?name=' + encodeURIComponent(q.file.name);",
    "          var xhr = new XMLHttpRequest();",
    "          xhr.open('POST', url);",
    "          xhr.setRequestHeader('content-type', q.file.type || 'application/octet-stream');",
    // Paint the card itself, so a big upload is legible at a glance rather than
    // only in the status line. The element is found by data attribute because
    // render() rebuilds the list.
    "          function paint(pct) {",
    "            var box = document.querySelector('[data-qid=\"' + q.qid + '\"]');",
    "            if (box) box.style.background = 'linear-gradient(90deg, ' + FILL + ' ' + pct + '%, #fff ' + pct + '%)';",
    "          }",
    "          function paintFail() {",
    "            var box = document.querySelector('[data-qid=\"' + q.qid + '\"]');",
    "            if (box) box.style.background = FAIL;",
    "          }",
    "          paint(0);",
    "          xhr.upload.onprogress = function (e) {",
    "            if (!e.lengthComputable) return;",
    "            var pct = Math.round((e.loaded / e.total) * 100);",
    "            paint(pct);",
    "            setStatus('uploading ' + q.file.name + ' - ' + pct + '% of ' + fmtBytes(e.total));",
    "          };",
    "          xhr.onload = function () {",
    "            var j = {};",
    "            try { j = JSON.parse(xhr.responseText); } catch (err) {}",
    "            if (xhr.status !== 201) { paintFail(); setStatus('upload failed: ' + (j.error || ('HTTP ' + xhr.status)), true); return; }",
    "            queued.splice(queued.indexOf(q), 1);",
    "            files.unshift(j.file);",
    "            setStatus('uploaded ' + j.file.name);",
    "            render(); refresh();",
    "          };",
    "          xhr.onerror = function () { paintFail(); setStatus('upload failed', true); };",
    "          setStatus('uploading ' + q.file.name + ' ...');",
    "          xhr.send(q.file);",
    "        }",
    "        function remove(id) {",
    "          if (!confirm('Delete this file permanently?')) return;",
    "          fetch('/api/files/' + id, { method: 'DELETE' })",
    "            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })",
    "            .then(function () { files = files.filter(function (f) { return f.id !== id; }); setStatus('deleted'); render(); refresh(); })",
    "            .catch(function (e) { setStatus('delete failed: ' + e.message, true); });",
    "        }",
    "        function refresh() {",
    "          fetch('/api/files').then(function (r) { return r.json(); }).then(function (j) {",
    "            files = j.files || [];",
    "            window.__USAGE__ = j.usage || { bytes: 0, count: 0 };",
    "            showBudget(j.budget);",
    "            render();",
    "          }).catch(function () {});",
    "        }",
    "        addBtn.addEventListener('click', function () { picker.click(); });",
    "        picker.addEventListener('change', function () {",
    "          Array.prototype.forEach.call(picker.files, function (f) { queued.push({ file: f, qid: nextQid++ }); });",
    "          picker.value = '';",
    "          render();",
    "        });",
    "        showBudget(window.__BUDGET__);",
    "        render();",
    "      })();",
  ].join("\n");
}

export interface FileView {
  id: string;
  name: string;
  size: number;
  content_type: string;
  created_at: string;
  expires_at: string;
  expires_in_ms: number;
  status: string;
  protected: boolean;
  key?: string;
  download_url: string;
  page_url: string;
  [extra: string]: unknown;
}

/** GET /files - the management page (device basic auth required). */
export function renderFilesPage(input: {
  budget?: Record<string, unknown> | null;
  deviceId: string;
  files: FileView[];
  usage: { count: number; bytes: number };
  limits: FileLimits;
}): string {
  const { deviceId, files, usage, limits } = input;
  const budget = input.budget ?? null;
  const body = [
    "  <body>",
    "    <h1>Files</h1>",
    '    <div class="sub">file management &middot; ' + esc(deviceId) + "</div>",
    '    <div class="row-head">',
    "      <h2>Files</h2>",
    '      <button class="plus" id="addBtn" type="button" title="Choose files">+</button>',
    "    </div>",
    '    <ul id="list"></ul>',
    '    <div class="status" id="status"></div>',
    '    <div class="status" id="usage"></div>',
    '    <div class="status" id="budget"></div>',
    '    <input id="picker" type="file" multiple style="display:none" />',
    "    <script>",
    "      window.__FILES__ = " + safeJson(files) + ";",
    "      window.__USAGE__ = " + safeJson(usage) + ";",
      "      window.__BUDGET__ = " + safeJson(budget) + ";",
    "      window.__LIMITS__ = " +
      safeJson({
        max_files: limits.maxPerDevice,
        max_upload_bytes: limits.maxUploadBytes,
        max_total_bytes: limits.maxTotalBytes,
        max_expiry_ms: limits.maxExpiryMs,
      }) +
      ";",
    "    </script>",
    "    <script>",
    browserScript(),
    "    </script>",
    "  </body>",
    "</html>",
  ].join("\n");
  return head("Prime - Files") + "\n" + body;
}

/**
 * GET /files/{id} - the download page.
 *
 * Three states: unknown/expired, protected-but-locked (prompt for the key), and
 * ready. The download itself always goes through the API with the key in a
 * request header, so typing it into the prompt never puts it in a URL.
 */
export function renderDownloadPage(input: {
  file: FileView | null;
  key?: string;
  protectedFile?: boolean;
  authorised?: boolean;
  wrongKey?: boolean;
}): string {
  const file = input.file;
  const locked = Boolean(file && input.protectedFile && !input.authorised);
  const scripts: string[] = [];
  const rows: string[] = [];

  if (!file) {
    rows.push('    <div class="empty">This file is not available. It may have expired or been deleted.</div>');
  } else {
    const soon = file.expires_in_ms <= 3 * 86400000;
    const dot = file.status !== "ready" ? "dot pending" : soon ? "dot off" : "dot on";

    let control: string;
    if (locked) {
      // No key known: ask for it. The submission downloads with a header, so the
      // key never reaches the address bar, history or a Referer.
      scripts.push("      window.__DL__ = " + safeJson({ id: file.id, name: file.name, key: "" }) + ";");
      control =
        '<form class="kform" id="keyForm">' +
        '<input id="k" type="password" placeholder="key" autocomplete="off" aria-label="protection key" autofocus />' +
        '<button class="plus" type="submit" title="Unlock">&#8594;</button>' +
        "</form>";
    } else if (file.protected) {
      // Authorised: hand the key to the page script, which sends it as a header.
      control = '<button class="dl" id="dlBtn" type="button" title="Download">' + DOWNLOAD_ICON + "</button>";
      scripts.push(
        "      window.__DL__ = " +
          safeJson({ id: file.id, name: file.name, key: input.key ?? file.key ?? "" }) +
          ";",
      );
    } else {
      // Unprotected: a plain link, so the browser streams it natively.
      control = '<a class="dl" href="/api/files/' + esc(file.id) + '" title="Download" download>' + DOWNLOAD_ICON + "</a>";
    }

    rows.push('    <ul id="list">');
    rows.push('      <li class="row">');
    rows.push('        <span class="' + dot + '"></span>');
    rows.push('        <div class="box">');
    rows.push('          <div class="cols">');
    rows.push('            <div class="fname">' + esc(file.name) + "</div>");
    rows.push('            <div class="fsize">' + esc(fmtBytes(file.size)) + "</div>");
    rows.push('            <div class="fexp' + (soon ? " soon" : "") + '">' + esc(expiryLabel(file)) + "</div>");
    rows.push('            <div class="fkey">' + esc(file.protected ? "(protected)" : "-") + "</div>");
    rows.push("          </div>");
    rows.push("          " + control);
    rows.push("        </div>");
    rows.push("      </li>");
    rows.push("    </ul>");
    rows.push(
      '    <div class="meta">' +
        esc(file.content_type) +
        " &middot; <b>" +
        esc(fmtBytes(file.size)) +
        "</b> &middot; expires " +
        esc(new Date(file.expires_at).toUTCString()) +
        "</div>",
    );
    rows.push('    <div class="status" id="status">' + (locked ? "This file is protected. Enter its key to download." : "") + "</div>");
  }

  if (file && (locked || input.protectedFile)) {
    scripts.push("      window.__PROTECTED__ = " + (locked ? "true" : "false") + ";");
    scripts.push("      window.__WRONG__ = " + (input.wrongKey ? "true" : "false") + ";");
  }

  const body = [
    "  <body>",
    "    <h1>Files</h1>",
    '    <div class="sub">file download' + (file ? " &middot; " + esc(deviceLabel(file)) : "") + "</div>",
    '    <div class="row-head"><h2>Files</h2></div>',
    ...rows,
    "    <script>",
    ...scripts,
    "    </script>",
    "    <script>",
    downloadScript(),
    "    </script>",
    "  </body>",
    "</html>",
  ].join("\n");
  return head(file ? "Download " + file.name : "File not available") + "\n" + body;
}

/**
 * Page script for the download page.
 *
 * Every protected download goes through fetch with the key in a request header
 * and is saved from a blob. That keeps the secret out of the URL even when the
 * visitor typed it into the prompt, and it is why the page needs its own control
 * instead of a plain link.
 */
function downloadScript(): string {
  return [
    "      (function () {",
    "        var statusEl = document.getElementById('status');",
    "        function say(msg, isErr) { if (statusEl) { statusEl.textContent = msg; statusEl.style.color = isErr ? '#b91c1c' : '#666'; } }",
    "        function save(id, name, key) {",
    "          say('downloading ...');",
    "          fetch('/api/files/' + id, { headers: { 'X-File-Key': key } })",
    "            .then(function (r) { if (!r.ok) throw new Error(r.status === 401 ? 'wrong key' : ('HTTP ' + r.status)); return r.blob(); })",
    "            .then(function (blob) {",
    "              var url = URL.createObjectURL(blob);",
    "              var a = document.createElement('a');",
    "              a.href = url; a.download = name;",
    "              document.body.appendChild(a); a.click(); a.remove();",
    "              setTimeout(function () { URL.revokeObjectURL(url); }, 10000);",
    "              say('saved ' + name);",
    "            })",
    "            .catch(function (e) { say('download failed: ' + e.message, true); });",
    "        }",
    "        var btn = document.getElementById('dlBtn');",
    "        if (btn && window.__DL__) btn.addEventListener('click', function () { save(window.__DL__.id, window.__DL__.name, window.__DL__.key); });",
    "        var form = document.getElementById('keyForm');",
    "        if (form && window.__DL__) {",
    "          if (window.__WRONG__) say('wrong key - try again', true);",
    "          form.addEventListener('submit', function (ev) {",
    "            ev.preventDefault();",
    "            var key = document.getElementById('k').value;",
    "            if (key) save(window.__DL__.id, window.__DL__.name, key);",
    "          });",
    "        }",
    "      })();",
  ].join("\n");
}

function deviceLabel(file: FileView): string {
  // The page URL does not carry the device; the file name is the useful label.
  return file.name;
}

function expiryLabel(file: FileView): string {
  const ms = file.expires_in_ms;
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return "in " + minutes + " min";
  const hours = Math.round(minutes / 60);
  if (hours < 48) return "in " + hours + " h";
  return "in " + Math.round(hours / 24) + " days";
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return bytes + " B";
}

/** JSON for embedding in a <script> tag, with the sequences that could close it escaped. */
function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
