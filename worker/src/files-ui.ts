// HTML for the temporary-file pages: GET /files (manage) and GET /files/{id}
// (download). Styled from the same stylesheet as /admin so the two match
// exactly; only the file-specific bits (the grey pending dot, the column
// layout, the download icon) are added here.

import { UI_CSS } from "./ui-css";
import type { FileLimits } from "./config";

const FILES_CSS = `
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
`;

const FAVICON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='%23111111'%3E%3Cpath%20d='M6%202h7l5%205v15a1%201%200%2001-1%201H6a1%201%200%2001-1-1V3a1%201%200%20011-1zm7%201.5V7h3.5L13%203.5z'/%3E%3C/svg%3E";

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
    "        var daysEl = document.getElementById('days');",
    "        var keyEl = document.getElementById('key');",
    "        var queued = [];",
    "        var files = window.__FILES__ || [];",
    "        var usageEl = document.getElementById('usage');",
    "        function setStatus(msg, isErr) { statusEl.textContent = msg || ''; statusEl.style.color = isErr ? '#b91c1c' : '#666'; }",
    "        function opts() { return { days: daysEl.value, key: keyEl.value }; }",
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
    "        function row(dot, name, expiry, key, menuItems, cell) {",
    "          var li = document.createElement('li');",
    "          li.className = 'row';",
    "          var d = document.createElement('span');",
    "          d.className = dot;",
    "          li.appendChild(d);",
    "          var box = document.createElement('div');",
    "          box.className = 'box';",
    "          var cols = document.createElement('div');",
    "          cols.className = 'cols';",
    "          var n = document.createElement('div'); n.className = 'fname'; n.textContent = name;",
    "          var e = document.createElement('div'); e.className = expiry.soon ? 'fexp soon' : 'fexp'; e.textContent = expiry.text;",
    "          var k = document.createElement('div'); k.className = 'fkey'; k.textContent = key;",
    "          cols.appendChild(n); cols.appendChild(e); cols.appendChild(k);",
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
    "            var saved = f.download_url;",
    "            listEl.appendChild(row(",
    "              dotClass(f), f.name,",
    "              { text: f.status === 'ready' ? human(f.expires_in_ms) : 'not uploaded', soon: f.status === 'ready' && f.expires_in_ms <= 3 * 86400000 },",
    "              f.protected ? f.key : '-',",
    "              [",
    "                { label: 'Save', run: function () { window.location = saved; } },",
    "                { label: 'Copy link', run: function () { copy(f.download_url); } },",
    "                { label: 'Delete', danger: true, run: function () { remove(f.id); } }",
    "              ]",
    "            ));",
    "          });",
    "          queued.forEach(function (q) {",
    "            listEl.appendChild(row(",
    "              'dot pending', q.file.name,",
    "              { text: 'not uploaded', soon: false },",
    "              keyEl.value ? keyEl.value : '-',",
    "              [",
    "                { label: 'Upload', run: function () { send(q); } },",
    "                { label: 'Delete', danger: true, run: function () { queued.splice(queued.indexOf(q), 1); render(); } }",
    "              ]",
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
    "        function copy(text) {",
    "          if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { setStatus('link copied'); }, function () { setStatus(text); });",
    "          else setStatus(text);",
    "        }",
    "        function send(q) {",
    "          var o = opts();",
    "          var url = '/api/files?name=' + encodeURIComponent(q.file.name) + '&expiry_days=' + encodeURIComponent(o.days);",
    "          if (o.key) url += '&key=' + encodeURIComponent(o.key);",
    "          setStatus('uploading ' + q.file.name + ' ...');",
    "          fetch(url, { method: 'POST', body: q.file, headers: { 'content-type': q.file.type || 'application/octet-stream' } })",
    "            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })",
    "            .then(function (j) { queued.splice(queued.indexOf(q), 1); files.unshift(j.file); setStatus('uploaded ' + j.file.name); render(); refresh(); })",
    "            .catch(function (e) { setStatus('upload failed: ' + e.message, true); });",
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
    "            render();",
    "          }).catch(function () {});",
    "        }",
    "        addBtn.addEventListener('click', function () { picker.click(); });",
    "        picker.addEventListener('change', function () {",
    "          Array.prototype.forEach.call(picker.files, function (f) { queued.push({ file: f }); });",
    "          picker.value = '';",
    "          render();",
    "        });",
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
  deviceId: string;
  files: FileView[];
  usage: { count: number; bytes: number };
  limits: FileLimits;
}): string {
  const { deviceId, files, usage, limits } = input;
  const body = [
    "  <body>",
    "    <h1>Files</h1>",
    '    <div class="sub">file management &middot; ' + esc(deviceId) + "</div>",
    '    <div class="row-head">',
    "      <h2>Files</h2>",
    '      <button class="plus" id="addBtn" type="button" title="Choose files">+</button>',
    "    </div>",
    '    <div class="opts">',
    '      <label for="days">expiry</label>',
    '      <select id="days">',
    '        <option value="0.0416667">1 hour</option>',
    '        <option value="1">1 day</option>',
    '        <option value="3">3 days</option>',
    '        <option value="7" selected>7 days</option>',
    "      </select>",
    '      <label for="key">key</label>',
    '      <input id="key" type="text" placeholder="optional protection key" autocomplete="off" />',
    "    </div>",
    '    <ul id="list"></ul>',
    '    <div class="status" id="status"></div>',
    '    <div class="status" id="usage"></div>',
    '    <input id="picker" type="file" multiple style="display:none" />',
    "    <script>",
    "      window.__FILES__ = " + safeJson(files) + ";",
    "      window.__USAGE__ = " + safeJson(usage) + ";",
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

/** GET /files/{id} - the download page. `file` is null when unknown/expired. */
export function renderDownloadPage(input: { file: FileView | null; key?: string }): string {
  const file = input.file;
  const rows: string[] = [];
  if (!file) {
    rows.push('    <div class="empty">This file is not available. It may have expired or been deleted.</div>');
  } else {
    const soon = file.expires_in_ms <= 3 * 86400000;
    const dot = file.status !== "ready" ? "dot pending" : soon ? "dot off" : "dot on";
    const href = "/api/files/" + esc(file.id) + (input.key ? "?key=" + encodeURIComponent(input.key) : "");
    rows.push('    <ul id="list">');
    rows.push('      <li class="row">');
    rows.push('        <span class="' + dot + '"></span>');
    rows.push('        <div class="box">');
    rows.push('          <div class="cols">');
    rows.push('            <div class="fname">' + esc(file.name) + "</div>");
    rows.push('            <div class="fexp' + (soon ? " soon" : "") + '">' + esc(expiryLabel(file)) + "</div>");
    rows.push('            <div class="fkey">' + esc(file.protected ? file.key : "-") + "</div>");
    rows.push("          </div>");
    rows.push('          <a class="dl" href="' + href + '" title="Download" download>' + DOWNLOAD_ICON + "</a>");
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
  }

  const body = [
    "  <body>",
    "    <h1>Files</h1>",
    '    <div class="sub">file download' + (file ? " &middot; " + esc(deviceLabel(file)) : "") + "</div>",
    '    <div class="row-head"><h2>Files</h2></div>',
    ...rows,
    "  </body>",
    "</html>",
  ].join("\n");
  return head(file ? "Download " + file.name : "File not available") + "\n" + body;
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
