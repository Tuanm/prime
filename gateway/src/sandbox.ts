// GET /mcp - the Sandbox: this browser as a device. The signed-in device
// (HTTP Basic, as on /files) uploads JavaScript tools - one file per tool, an
// 'export default async function' documented with JSDoc - kept in this browser's
// storage. Tools are validated, and later run, in a sandboxed iframe with an
// opaque origin and no network (GET /mcp?frame=runtime), never in the page.

import { FAVICON, UI_CSS } from "./ui-css";
import { authorizeDevice } from "./files-routes";
import type { Env } from "./config";

const SANDBOX_CSS = `
      body { width: 720px; }
      .cols { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
      .tname { width: 150px; flex: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .targs { width: 150px; flex: none; font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tdesc { flex: 1; min-width: 0; font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dot.pending { background: #ccc; }
      .row { flex-wrap: wrap; }
      .terr { flex-basis: 100%; margin: 4px 0 0 22px; font-size: 11px; color: #b91c1c; }
      .dot-spacer { width: 10px; flex: none; }
      .dropzone { flex: 1; min-height: 46px; border: 1px dashed #bbb; background: #fff; color: #999; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; box-sizing: border-box; }
      .dropzone:hover, .dropzone.over { border-color: #111; color: #111; }
      .plus:disabled { opacity: 0.35; cursor: default; }
      .connect-row { margin-top: 28px; display: flex; align-items: center; gap: 14px; }
      .connect { font: inherit; font-weight: 600; padding: 10px 22px; background: #111; color: #fff; border: 1px solid #111; cursor: pointer; }
      .connect:hover { background: #000; }
      .dlg.dlg-wide { width: 680px; max-width: calc(100vw - 32px); }
      .dlg.dlg-wide .dlg-body { padding: 14px 16px 16px; }
      .dlg.dlg-wide .dlg-msg { padding: 10px 0 0; }
      .src { width: 100%; height: 340px; box-sizing: border-box; font: inherit; font-size: 12px; line-height: 1.5; padding: 10px 12px; border: 1px solid #ddd; background: #fafafa; resize: vertical; white-space: pre; tab-size: 2; }
      .src:focus { outline: none; border-color: #111; }
      .dlg-bar { display: flex; justify-content: flex-end; margin-top: 10px; }
      .btn { font: inherit; font-size: 12px; font-weight: 600; padding: 6px 16px; background: #111; color: #fff; border: 1px solid #111; cursor: pointer; }
      .btn:disabled { opacity: 0.4; cursor: default; }
`;

const RUNTIME_JS = String.raw`(function () {
  "use strict";
  var NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
  var MAX_SOURCE = 200000;
  var HEAD_RE = /export\s+default\s+async\s+function\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/;

  function fail(msg) { var e = new Error(msg); e.userFacing = true; throw e; }

  function schemaFor(type) {
    var t = String(type || "").trim();
    if (!t || t === "*" || /^any$/i.test(t)) return {};
    if (t.indexOf("|") >= 0) {
      var parts = t.split("|").map(function (p) { return schemaFor(p).type; }).filter(Boolean);
      return parts.length ? { type: parts } : {};
    }
    if (/\[\]$/.test(t) || /^array(<.*>)?$/i.test(t) || /^Array\./.test(t)) return { type: "array" };
    var l = t.toLowerCase();
    if (l === "number") return { type: "number" };
    if (l === "integer" || l === "int") return { type: "integer" };
    if (l === "string") return { type: "string" };
    if (l === "boolean" || l === "bool") return { type: "boolean" };
    if (l === "object" || /^object(<.*>)?$/i.test(t) || /^\{.*\}$/.test(t)) return { type: "object" };
    if (l === "null") return { type: "null" };
    fail("unsupported @param type {" + t + "} - use number, integer, string, boolean, object, array, a union, or *");
  }

  function analyze(source, filename) {
    source = String(source == null ? "" : source);
    if (!source.trim()) fail("the file is empty");
    if (source.length > MAX_SOURCE) fail("the file is larger than " + MAX_SOURCE / 1000 + " KB");
    var m = HEAD_RE.exec(source);
    if (!m) fail("the file must contain 'export default async function (...)'");
    if ((source.match(/\bexport\b/g) || []).length !== 1) fail("only one export is allowed: the default async function");
    if (/^\s*import\b/m.test(source) || /\bimport\s*\(/.test(source)) fail("imports are not available: a tool runs offline in the browser");

    // Syntax: compile (never run) the module body as a function.
    var body = "var __tool__;\n" + source.replace(/export\s+default\s+async\s+function/, "__tool__ = async function") + "\n;return __tool__;";
    try { new Function(body); } catch (err) { fail("syntax error: " + (err && err.message || err)); }

    // Signature: plain parameters (with optional defaults) only.
    var sig = [];
    m[2].split(",").map(function (p) { return p.trim(); }).filter(Boolean).forEach(function (p) {
      var pm = /^([A-Za-z_$][\w$]*)\s*(=[\s\S]*)?$/.exec(p);
      if (!pm) fail("parameter '" + p + "': use plain parameters (no destructuring or ...rest) - document each with @param");
      sig.push({ name: pm[1], hasDefault: !!pm[2] });
    });

    // JSDoc: the block comment right before the function.
    var before = source.slice(0, m.index);
    var dm = /\/\*\*([\s\S]*?)\*\/\s*$/.exec(before);
    if (!dm) fail("add a JSDoc comment (/** ... */) right above the function: its text is the tool's description");
    var lines = dm[1].split(/\r?\n/).map(function (l) { return l.replace(/^\s*\*? ?/, ""); });
    var desc = [], params = [], inTag = false;
    lines.forEach(function (line) {
      var t = line.trim();
      if (/^@param\b/.test(t)) {
        inTag = true;
        var pm = /^@param\s+\{([^}]+)\}\s+(\[)?([A-Za-z_$][\w$]*)(?:=([^\]]*))?\]?\s*(?:-\s*)?([\s\S]*)$/.exec(t);
        if (!pm) fail("cannot read '" + t + "' - write it as @param {type} name description");
        var type = pm[1].trim(), optional = !!pm[2];
        if (/=$/.test(type)) { optional = true; type = type.slice(0, -1); }
        params.push({ name: pm[3], type: type, description: pm[5].trim(), optional: optional });
      } else if (/^@/.test(t)) {
        inTag = true;
      } else if (inTag && params.length && t) {
        params[params.length - 1].description += " " + t;
      } else if (!inTag) {
        desc.push(line);
      }
    });
    var description = desc.join("\n").trim();
    if (!description) fail("the JSDoc comment needs a description (text before the @param tags)");

    var docNames = params.map(function (p) { return p.name; }).join(", ");
    var sigNames = sig.map(function (p) { return p.name; }).join(", ");
    if (docNames !== sigNames) fail("the @param tags (" + (docNames || "none") + ") must match the function's parameters (" + (sigNames || "none") + "), in order");

    var properties = {}, required = [];
    params.forEach(function (p, i) {
      var s = schemaFor(p.type);
      if (p.description) s.description = p.description;
      properties[p.name] = s;
      if (!p.optional && !sig[i].hasDefault) required.push(p.name);
      else p.optional = true;
    });

    var stem = String(filename || "").replace(/^.*[\\/]/, "").replace(/\.(m?js)$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[^A-Za-z]+/, "");
    var name = m[1] || stem;
    if (!NAME_RE.test(name || "")) fail("cannot derive a tool name: name the function (letters, digits, _ or -, starting with a letter)");

    return {
      ok: true,
      name: name,
      description: description,
      params: params,
      inputSchema: { type: "object", properties: properties, required: required, additionalProperties: false }
    };
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var d = e.data || {};
    if (d.type !== "analyze") return;
    var result;
    try { result = analyze(d.source, d.filename); }
    catch (err) { result = { ok: false, error: err && err.userFacing ? err.message : "invalid tool: " + (err && err.message || err) }; }
    parent.postMessage({ type: "analyzed", id: d.id, result: result }, "*");
  });
  parent.postMessage({ type: "ready" }, "*");
})();`;

const PAGE_JS = String.raw`(function () {
  "use strict";
  var DEVICE = window.__DEVICE__;
  var KEY = "code-mcp.sandbox.tools." + DEVICE;
  var MAX_TOOLS = 50;
  var tools = load();
  var pending = [];
  var nextQid = 1;
  var showDropzone = false;
  var connected = false;
  var list = document.getElementById("list");
  var statusEl = document.getElementById("status");
  var picker = document.getElementById("picker");

  // ---- the sandbox runtime (opaque origin, no network, no storage) ----------
  var frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = "/mcp?frame=runtime";
  frame.title = "tool runtime";
  frame.style.display = "none";
  document.body.appendChild(frame);
  var ready, readyResolve;
  ready = new Promise(function (r) { readyResolve = r; });
  var waiting = {}, nextId = 1;
  window.addEventListener("message", function (e) {
    if (e.source !== frame.contentWindow) return;
    var d = e.data || {};
    if (d.type === "ready") readyResolve();
    if (d.type === "analyzed" && waiting[d.id]) { waiting[d.id](d.result); delete waiting[d.id]; }
  });
  function analyze(source, filename) {
    return ready.then(function () {
      return new Promise(function (resolve) {
        var id = nextId++;
        var timer = setTimeout(function () { delete waiting[id]; resolve({ ok: false, error: "validation timed out" }); }, 5000);
        waiting[id] = function (r) { clearTimeout(timer); resolve(r); };
        frame.contentWindow.postMessage({ type: "analyze", id: id, source: source, filename: filename }, "*");
      });
    });
  }

  // ---- storage -----------------------------------------------------------------
  function load() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(tools)); return true; }
    catch (e) { setStatus("could not save to this browser's storage: " + (e && e.message || e), true); return false; }
  }

  function setStatus(msg, isErr) { statusEl.textContent = msg || ""; statusEl.style.color = isErr ? "#b91c1c" : "#666"; }
  function argsLabel(t) {
    return "(" + (t.params || []).map(function (p) { return p.name + (p.optional ? "?" : ""); }).join(", ") + ")";
  }
  function closeMenus() { document.querySelectorAll(".menu.open").forEach(function (m) { m.classList.remove("open"); }); }
  document.addEventListener("click", closeMenus);

  function row(dotClass, cols, items, opts) {
    opts = opts || {};
    var li = document.createElement("li");
    li.className = "row" + (opts.disabled ? " disabled" : "");
    var d = document.createElement("span"); d.className = dotClass; li.appendChild(d);
    var box = document.createElement("div"); box.className = "box"; box.style.background = opts.tint || "#fff";
    var c = document.createElement("div"); c.className = "cols";
    cols.forEach(function (col) { var el = document.createElement("div"); el.className = col[0]; el.textContent = col[1]; if (col[2]) el.title = col[2]; c.appendChild(el); });
    box.appendChild(c);
    var wrap = document.createElement("div"); wrap.className = "menu-wrap";
    var btn = document.createElement("button"); btn.className = "menu-btn"; btn.type = "button"; btn.textContent = "\u22ef"; btn.setAttribute("aria-label", "Actions");
    var menu = document.createElement("div"); menu.className = "menu";
    items.forEach(function (item) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = item.label;
      if (item.danger) b.className = "danger";
      if (item.disabled) b.disabled = true;
      b.addEventListener("click", function (ev) { ev.stopPropagation(); closeMenus(); item.run(); });
      menu.appendChild(b);
    });
    btn.addEventListener("click", function (ev) { ev.stopPropagation(); var open = menu.classList.contains("open"); closeMenus(); if (!open) menu.classList.add("open"); });
    wrap.appendChild(btn); wrap.appendChild(menu); box.appendChild(wrap);
    li.appendChild(box);
    if (opts.error) { var er = document.createElement("div"); er.className = "terr"; er.textContent = opts.error; li.appendChild(er); }
    return li;
  }

  function render() {
    list.innerHTML = "";
    tools.forEach(function (t) {
      var locked = connected;
      list.appendChild(row(t.active ? "dot on" : "dot off",
        [["tname", t.name], ["targs", argsLabel(t), argsLabel(t)], ["tdesc", t.description.split("\n")[0], t.description]],
        [
          { label: "View", run: function () { view(t); } },
          { label: "Download", run: function () { download(t.filename || t.name + ".js", t.source); } },
          { label: t.active ? "Deactivate" : "Activate", disabled: locked, run: function () { t.active = !t.active; persist(); render(); } },
          { label: "Delete", danger: true, disabled: locked, run: function () { if (confirm("Delete the tool '" + t.name + "'?")) { tools = tools.filter(function (x) { return x !== t; }); persist(); render(); } } }
        ], { disabled: !t.active }));
    });
    pending.forEach(function (p) {
      list.appendChild(row("dot pending",
        [["tname", p.filename], ["targs", ""], ["tdesc", p.error ? "not valid" : "not saved"]],
        [
          { label: "Save", disabled: connected, run: function () { savePending(p); } },
          { label: "View", run: function () { view(null, p); } },
          { label: "Delete", danger: true, run: function () { pending = pending.filter(function (x) { return x !== p; }); render(); } }
        ], { tint: p.error ? "#fee2e2" : "#fff", error: p.error }));
    });
    if (showDropzone && !connected) {
      var li = document.createElement("li"); li.className = "row";
      var sp = document.createElement("span"); sp.className = "dot-spacer"; li.appendChild(sp);
      var dz = document.createElement("div"); dz.className = "dropzone"; dz.id = "dropzone"; dz.textContent = "Drop a .js file here, or click to choose";
      dz.addEventListener("click", function () { picker.click(); });
      dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("over"); });
      dz.addEventListener("dragleave", function () { dz.classList.remove("over"); });
      dz.addEventListener("drop", function (e) { e.preventDefault(); dz.classList.remove("over"); addFiles(e.dataTransfer.files); });
      li.appendChild(dz); list.appendChild(li);
    }
    if (!tools.length && !pending.length && !showDropzone) {
      var em = document.createElement("li"); em.className = "empty"; em.textContent = "No tools yet. Click + to add one."; list.appendChild(em);
    }
    document.getElementById("addBtn").disabled = connected;
    var active = tools.filter(function (t) { return t.active; }).length;
    document.getElementById("count").textContent = tools.length + " tool" + (tools.length === 1 ? "" : "s") + " \u00b7 " + active + " active";
  }

  function addFiles(fileList) {
    Array.prototype.forEach.call(fileList || [], function (f) {
      if (!/\.(m?js)$/i.test(f.name)) { setStatus(f.name + ": only .js files can be tools", true); return; }
      if (f.size > 200000) { setStatus(f.name + ": larger than 200 KB", true); return; }
      f.text().then(function (text) {
        pending.push({ qid: nextQid++, filename: f.name, source: text });
        showDropzone = false; setStatus(f.name + " loaded - Save to add it as a tool"); render();
      });
    });
  }
  picker.addEventListener("change", function () { addFiles(picker.files); picker.value = ""; });
  document.getElementById("addBtn").addEventListener("click", function () { if (connected) return; showDropzone = !showDropzone; render(); });

  /** Validate, then store. 'existing' is the tool being replaced (edit), if any. */
  function validateAndStore(source, filename, existing) {
    return analyze(source, filename).then(function (r) {
      if (!r.ok) return r;
      var clash = tools.filter(function (t) { return t.name === r.name && t !== existing; })[0];
      if (clash) return { ok: false, error: "a tool named '" + r.name + "' already exists" };
      if (!existing && tools.length >= MAX_TOOLS) return { ok: false, error: "at most " + MAX_TOOLS + " tools" };
      var tool = existing || { id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), active: true };
      tool.name = r.name; tool.description = r.description; tool.params = r.params; tool.inputSchema = r.inputSchema;
      tool.source = source; tool.filename = filename; tool.savedAt = new Date().toISOString();
      if (!existing) tools.push(tool);
      if (!persist()) { if (!existing) tools.pop(); return { ok: false, error: "browser storage is full" }; }
      return { ok: true, tool: tool };
    });
  }
  function savePending(p) {
    validateAndStore(p.source, p.filename, null).then(function (r) {
      if (!r.ok) { p.error = r.error; setStatus(p.filename + ": " + r.error, true); render(); return; }
      pending = pending.filter(function (x) { return x !== p; });
      setStatus("saved tool '" + r.tool.name + "'"); render();
    });
  }

  function download(name, text) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function view(tool, p) {
    var overlay = document.createElement("div"); overlay.className = "overlay";
    var dlg = document.createElement("div"); dlg.className = "dlg dlg-wide";
    var head = document.createElement("div"); head.className = "dlg-head";
    var title = document.createElement("span"); title.textContent = tool ? tool.name : p.filename;
    var sub = document.createElement("span"); sub.className = "dlg-id"; sub.textContent = tool ? argsLabel(tool) : "not saved";
    var x = document.createElement("button"); x.type = "button"; x.className = "dlg-close"; x.title = "Close"; x.innerHTML = "&times;";
    head.appendChild(title); head.appendChild(sub); head.appendChild(x);
    var body = document.createElement("div"); body.className = "dlg-body";
    var ta = document.createElement("textarea"); ta.className = "src"; ta.spellcheck = false; ta.value = tool ? tool.source : p.source;
    ta.readOnly = connected;
    var msg = document.createElement("div"); msg.className = "dlg-msg";
    msg.textContent = connected ? "Connected: disconnect to edit." : "Edit, then Save. The file is validated before it is stored.";
    var bar = document.createElement("div"); bar.className = "dlg-bar";
    var save = document.createElement("button"); save.type = "button"; save.className = "btn"; save.textContent = "Save"; save.disabled = connected;
    bar.appendChild(save);
    body.appendChild(ta); body.appendChild(msg); body.appendChild(bar);
    dlg.appendChild(head); dlg.appendChild(body); overlay.appendChild(dlg); document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    x.addEventListener("click", close);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    save.addEventListener("click", function () {
      save.disabled = true;
      var filename = tool ? tool.filename || tool.name + ".js" : p.filename;
      validateAndStore(ta.value, filename, tool).then(function (r) {
        save.disabled = false;
        if (!r.ok) { msg.textContent = r.error; msg.className = "dlg-msg err"; return; }
        if (p) pending = pending.filter(function (q) { return q !== p; });
        setStatus("saved tool '" + r.tool.name + "'"); render(); close();
      });
    });
  }

  // ---- connect (wired to the gateway in the next step) -------------------------
  document.getElementById("connect").addEventListener("click", function () {
    setStatus("Connecting this sandbox to the gateway is not available yet.", true);
  });

  window.__sandbox = { analyze: analyze, tools: function () { return tools; } };
  render();
})();`;

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderSandboxPage(deviceId: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <meta name="referrer" content="no-referrer" />',
    "    <title>Prime - Sandbox</title>",
    '    <link rel="icon" href="' + FAVICON + '" />',
    '    <link rel="preconnect" href="https://fonts.googleapis.com" />',
    '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
    '    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />',
    "    <style>" + UI_CSS + SANDBOX_CSS + "    </style>",
    "  </head>",
    "  <body>",
    "    <h1>Sandbox</h1>",
    '    <div class="sub">this browser as a device &middot; ' + esc(deviceId) + "</div>",
    '    <div class="row-head">',
    "      <h2>Tools</h2>",
    '      <button class="plus" id="addBtn" type="button" title="Add a tool">+</button>',
    "    </div>",
    '    <ul id="list"></ul>',
    '    <div class="status" id="status"></div>',
    '    <div class="status" id="count"></div>',
    '    <div class="connect-row"><button class="connect" id="connect" type="button">Connect</button></div>',
    '    <input id="picker" type="file" accept=".js,.mjs,text/javascript" multiple style="display:none" />',
    "    <script>window.__DEVICE__ = " + JSON.stringify(deviceId).replace(/</g, "\\u003c") + ";</script>",
    "    <script>" + PAGE_JS + "</script>",
    "  </body>",
    "</html>",
  ].join("\n");
}

export { RUNTIME_JS };

export function renderRuntimeFrame(): string {
  return '<!doctype html><html><head><meta charset="utf-8"><title>tool runtime</title></head><body><script>' + RUNTIME_JS + "</script></body></html>";
}

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src data: blob:",
  "frame-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// The runtime is sandboxed by its own response too, so even opened directly it
// has an opaque origin: no cookies, no storage, no credentials, no network.
const RUNTIME_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "img-src data:",
  "frame-ancestors 'self'",
].join("; ");

/** GET/HEAD /mcp. Anything else at exactly /mcp is a 405. */
export async function handleSandbox(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method not allowed", hint: "MCP clients POST to /mcp/{deviceId}" }, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const base = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
  if (url.searchParams.get("frame") === "runtime") {
    return new Response(request.method === "HEAD" ? null : renderRuntimeFrame(), {
      headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": RUNTIME_CSP },
    });
  }
  const auth = await authorizeDevice(env, request);
  if (auth instanceof Response) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...base, "content-type": "application/json; charset=utf-8", "www-authenticate": 'Basic realm="Prime sandbox", charset="UTF-8"' },
    });
  }
  return new Response(request.method === "HEAD" ? null : renderSandboxPage(auth.deviceId), {
    headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP },
  });
}
