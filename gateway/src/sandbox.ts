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
      .src { width: 100%; height: 340px; box-sizing: border-box; font: inherit; font-size: 12px; line-height: 1.5; padding: 10px 12px; border: 1px solid #ddd; background: #fafafa; resize: none; white-space: pre; tab-size: 2; }
      .src:focus { outline: none; border-color: #111; }
      .dlg-bar { display: flex; justify-content: flex-end; margin-top: 10px; }
      .btn { font: inherit; font-size: 12px; font-weight: 600; padding: 6px 16px; background: #111; color: #fff; border: 1px solid #111; cursor: pointer; }
      .btn:disabled { opacity: 0.4; cursor: default; }
      .connect:disabled { opacity: 0.5; cursor: default; }
      .connect.on { background: #fff; color: #111; }
      .connect.on:hover { background: #f2f2f2; }
      .conninfo { font-size: 11px; color: #666; line-height: 1.5; word-break: break-all; }
      /* ---- dash: where tools put UI and drive cursors ---- */
      #dash { margin-top: 28px; }
      #dash[hidden] { display: none; }
      .dash-area { position: relative; min-height: 320px; border: 1px dashed #bbb; padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow: auto; max-height: 70vh; }
      .dash-empty { color: #999; font-size: 12px; margin: auto; text-align: center; }
      .dash-empty[hidden] { display: none; }
      /* Components: the page's own vocabulary - mono type, black on white, 1px lines. */
      .uc { font-size: 13px; color: #111; min-width: 0; }
      .uc-heading { font-size: 15px; font-weight: 700; letter-spacing: 0.3px; }
      .uc-text { white-space: pre-wrap; line-height: 1.5; }
      .uc-text.muted { color: #666; font-size: 12px; }
      .uc-code pre { margin: 0; background: #f5f5f5; border: 1px solid #ddd; padding: 10px 12px; font: inherit; font-size: 12px; overflow-x: auto; white-space: pre; }
      .uc-image img { display: block; max-width: 100%; border: 1px solid #111; }
      .uc-label { font-size: 10px; color: #999; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
      .uc-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 10px; }
      .uc-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }
      .uc-card { border: 1px solid #111; padding: 12px 14px; }
      .uc-card .uc-body { display: flex; flex-direction: column; gap: 10px; }
      .uc-status { display: flex; align-items: center; gap: 8px; font-size: 12px; }
      .uc-divider { border-top: 1px solid #ddd; }
      .uc-status .dot.pending { background: #ccc; }
      .ubtn { font: inherit; font-size: 12px; font-weight: 600; padding: 7px 16px; background: #111; color: #fff; border: 1px solid #111; cursor: pointer; transition: transform 0.08s; }
      .ubtn:hover { background: #000; }
      .ubtn.secondary { background: #fff; color: #111; }
      .ubtn.secondary:hover { background: #f2f2f2; }
      .ubtn.danger { background: #b91c1c; border-color: #b91c1c; }
      .ubtn:disabled { opacity: 0.4; cursor: default; }
      .ubtn.pressed { transform: scale(0.96); }
      .uinput { font: inherit; font-size: 13px; width: 100%; box-sizing: border-box; border: 0; border-bottom: 1px dotted #999; padding: 4px 0; background: transparent; color: #111; }
      .uinput:focus { outline: none; border-bottom: 1px solid #111; }
      .utextarea, .ueditor { font: inherit; font-size: 12px; width: 100%; box-sizing: border-box; border: 1px solid #ddd; padding: 8px 10px; background: #fff; color: #111; resize: none; line-height: 1.5; }
      .ueditor { background: #fafafa; white-space: pre; tab-size: 2; }
      .utextarea:focus, .ueditor:focus { outline: none; border-color: #111; }
      /* Drawn controls: no native checkbox, select or range anywhere. */
      .ucheck { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; user-select: none; outline: none; }
      .ucheck-box { width: 14px; height: 14px; border: 1px solid #111; background: #fff; display: inline-flex; align-items: center; justify-content: center; flex: none; box-sizing: border-box; }
      .ucheck-box svg { width: 10px; height: 10px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; opacity: 0; }
      .ucheck.on .ucheck-box { background: #111; }
      .ucheck.on .ucheck-box svg { opacity: 1; }
      .ucheck:focus-visible .ucheck-box { box-shadow: 0 0 0 2px #fff, 0 0 0 3px #111; }
      .ucheck.disabled { opacity: 0.4; cursor: default; }
      .usel { display: inline-flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 140px; box-sizing: border-box; border: 1px solid #111; background: #fff; color: #111; font-size: 12px; padding: 5px 8px 5px 10px; cursor: pointer; user-select: none; outline: none; }
      .usel:focus-visible, .usel.open { box-shadow: 0 0 0 1px #111; }
      .usel-chev { display: inline-flex; }
      .usel-chev svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 2.2; transition: transform 0.12s; }
      .usel.open .usel-chev svg { transform: rotate(180deg); }
      .usel.disabled { opacity: 0.4; cursor: default; }
      .usel-list { position: fixed; z-index: 1000; max-height: 240px; overflow-y: auto; background: #fff; border: 1px solid #111; padding: 4px 0; font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; box-sizing: border-box; }
      .usel-item { position: relative; padding: 6px 12px 6px 26px; cursor: pointer; white-space: nowrap; color: #111; }
      .usel-item.active { background: #f2f2f2; }
      .usel-item[aria-selected="true"] { font-weight: 700; }
      .usel-item[aria-selected="true"]::before { content: "\\2713"; position: absolute; left: 10px; }
      .uslide { display: inline-flex; align-items: center; gap: 12px; width: 260px; padding: 6px 0; cursor: pointer; touch-action: none; user-select: none; outline: none; }
      .uslide-track { position: relative; flex: 1; height: 2px; background: #ddd; }
      .uslide-fill { position: absolute; left: 0; top: 0; bottom: 0; background: #111; }
      .uslide-thumb { position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; background: #111; border: 2px solid #fff; box-shadow: 0 0 0 1px #111; box-sizing: border-box; }
      .uslide:focus-visible .uslide-thumb, .uslide.dragging .uslide-thumb { box-shadow: 0 0 0 1px #111, 0 0 0 4px rgba(17,17,17,0.12); }
      .uslide-value { font-size: 11px; color: #666; min-width: 28px; text-align: right; }
      .uslide.disabled { opacity: 0.4; cursor: default; }
      .btn.secondary { background: #fff; color: #111; }
      .btn.danger { background: #b91c1c; border-color: #b91c1c; }
      .dlg-bar .btn + .btn { margin-left: 8px; }
      .dlg.dlg-confirm { width: 420px; max-width: calc(100vw - 32px); }
      .dlg.dlg-confirm .dlg-body { padding: 14px 16px 16px; }
      .dlg.dlg-confirm .dlg-msg { padding: 0 0 12px; color: #111; }
      .uc.dragging { opacity: 0.45; }
      /* Virtual cursors: a black arrow and the client's name. */
      .cur { position: absolute; left: 0; top: 0; z-index: 20; pointer-events: none; transform: translate(12px, 12px); }
      .cur svg { width: 16px; height: 20px; display: block; fill: #111; stroke: #fff; stroke-width: 1.2; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.25)); }
      .cur-name { position: absolute; left: 14px; top: 16px; font-size: 10px; font-weight: 600; color: #fff; padding: 2px 6px; white-space: nowrap; letter-spacing: 0.3px; }
      .cur.click svg { animation: curclick 0.16s ease-out; }
      .cur.grab svg { transform: scale(0.9); }
      .cur::after { content: ""; position: absolute; left: -6px; top: -6px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--cur); opacity: 0; }
      .cur.click::after { animation: curring 0.4s ease-out; }
      @keyframes curclick { 50% { transform: scale(0.85); } }
      @keyframes curring { from { opacity: 0.9; transform: scale(0.4); } to { opacity: 0; transform: scale(2.2); } }
      /* ---- the components reference ---- */
      .gallery { margin-top: 36px; }
      .gallery summary { cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; list-style: none; }
      .gallery summary::-webkit-details-marker { display: none; }
      .gallery summary::before { content: "+ "; }
      .gallery[open] summary::before { content: "\\2212  "; }
      .gal-intro { font-size: 12px; color: #666; margin: 12px 0 4px; line-height: 1.6; }
      .gal-item { display: grid; grid-template-columns: 130px 1fr; gap: 6px 14px; padding: 12px 0; border-bottom: 1px solid #eee; align-items: start; }
      .gal-name { font-size: 11px; color: #666; padding-top: 4px; }
      .gal-code { grid-column: 2; font-size: 10.5px; color: #888; background: none; border: 0; padding: 0; word-break: break-all; }
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

  // ---- running a tool (one iframe per call; the page owns everything else) ----
  var seq = 1, waiting = {}, logs = [], logBytes = 0;
  function api(method, args) {
    return new Promise(function (resolve, reject) {
      var s = seq++;
      waiting[s] = { resolve: resolve, reject: reject };
      var clean;
      try { clean = JSON.parse(JSON.stringify(args)); } catch (err) { delete waiting[s]; reject(new Error(method + ": arguments must be plain data")); return; }
      parent.postMessage({ type: "api", seq: s, method: method, args: clean }, "*");
    });
  }
  function fmt(v) {
    if (typeof v === "string") return v;
    try { var j = JSON.stringify(v); return j === undefined ? String(v) : j; } catch (e) { return String(v); }
  }
  function log(level) {
    return function () {
      var line = (level === "log" ? "" : level + ": ") + Array.prototype.map.call(arguments, fmt).join(" ");
      if (logs.length < 200 && logBytes < 20000) { logs.push(line.slice(0, 2000)); logBytes += line.length; }
    };
  }
  var sandboxConsole = Object.freeze({ log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") });
  var ui = Object.freeze({
    add: function (spec) { return api("ui.add", [spec]); },
    update: function (id, props) { return api("ui.update", [id, props]); },
    get: function (id) { return api("ui.get", [id]); },
    remove: function (id) { return api("ui.remove", [id]); },
    clear: function () { return api("ui.clear", []); },
    list: function () { return api("ui.list", []); },
    wait: function (id, options) { return api("ui.wait", [id, options || {}]); },
    events: function (options) { return api("ui.events", [options || {}]); }
  });
  var cursor = Object.freeze({
    move: function (id) { return api("cursor.move", [id]); },
    click: function (id) { return api("cursor.click", [id]); },
    type: function (id, text) { return api("cursor.type", [id, String(text)]); },
    fill: function (id, text) { return api("cursor.fill", [id, String(text)]); },
    check: function (id, value) { return api("cursor.check", [id, value === undefined ? true : !!value]); },
    select: function (id, value) { return api("cursor.select", [id, String(value)]); },
    drag: function (id, target) { return api("cursor.drag", [id, target]); }
  });
  function result(ok, value, error) {
    var text = null;
    if (ok) text = value === undefined ? "" : (typeof value === "string" ? value : fmt(value));
    parent.postMessage({ type: "result", ok: ok, text: text, error: error || null, logs: logs }, "*");
  }
  function run(d) {
    var source = String(d.source || "");
    var body = "var __tool__;\n" + source.replace(/export\s+default\s+async\s+function/, "__tool__ = async function") + "\n;return __tool__;";
    var fn;
    try { fn = new Function("ui", "cursor", "console", "client", "event", body)(ui, cursor, sandboxConsole, Object.freeze(d.client || {}), d.event ? Object.freeze(d.event) : null); }
    catch (err) { result(false, null, "the tool failed to load: " + (err && err.message || err)); return; }
    if (typeof fn !== "function") { result(false, null, "the tool has no default function"); return; }
    Promise.resolve().then(function () { return fn.apply(null, d.args || []); }).then(
      function (v) { result(true, v); },
      function (err) { result(false, null, err && err.message ? String(err.message) : String(err)); }
    );
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var d = e.data || {};
    if (d.type === "run") { run(d); return; }
    if (d.type === "api-result") {
      var w = waiting[d.seq];
      if (!w) return;
      delete waiting[d.seq];
      if (d.ok) w.resolve(d.value); else w.reject(new Error(d.error || "failed"));
      return;
    }
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
  var SEEDED_KEY = "code-mcp.sandbox.seeded." + DEVICE;
  var STARTERS = window.__STARTERS__ || [];
  var pending = [];
  var nextQid = 1;
  var showDropzone = false;
  var connected = false;
  var calls = [];
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
    for (var i = 0; i < calls.length; i++) {
      if (calls[i].frame.contentWindow === e.source) { calls[i].onMessage(e.data || {}); return; }
    }
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
          { label: "Delete", danger: true, disabled: locked, run: function () { askConfirm("Delete tool", "Delete the tool '" + t.name + "'? This cannot be undone.", "Delete").then(function (yes) { if (yes) { tools = tools.filter(function (x) { return x !== t; }); persist(); render(); } }); } }
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

  /** The page's own confirmation dialog (resolves true for the confirm button). */
  function askConfirm(title, message, okLabel) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div"); overlay.className = "overlay";
      var dlg = document.createElement("div"); dlg.className = "dlg dlg-confirm"; dlg.setAttribute("role", "alertdialog");
      var head = document.createElement("div"); head.className = "dlg-head";
      var t = document.createElement("span"); t.textContent = title; head.appendChild(t);
      var body = document.createElement("div"); body.className = "dlg-body";
      var msg = document.createElement("div"); msg.className = "dlg-msg"; msg.textContent = message;
      var bar = document.createElement("div"); bar.className = "dlg-bar";
      var cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn secondary"; cancel.textContent = "Cancel";
      var ok = document.createElement("button"); ok.type = "button"; ok.className = "btn danger"; ok.textContent = okLabel || "OK";
      bar.appendChild(cancel); bar.appendChild(ok); body.appendChild(msg); body.appendChild(bar);
      dlg.appendChild(head); dlg.appendChild(body); overlay.appendChild(dlg); document.body.appendChild(overlay);
      function done(v) { document.removeEventListener("keydown", key, true); overlay.remove(); resolve(v); }
      function key(e) { if (e.key === "Escape") { e.preventDefault(); done(false); } }
      document.addEventListener("keydown", key, true);
      cancel.addEventListener("click", function () { done(false); });
      ok.addEventListener("click", function () { done(true); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) done(false); });
      cancel.focus();
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

  // ===========================================================================
  // Connection: a Worker owns the WebSocket (timers in a background tab are
  // throttled; a Worker's are not), the page speaks MCP over the tunnel.
  // ===========================================================================
  var connectBtn = document.getElementById("connect");
  var connInfo = document.getElementById("conninfo");
  var dashSection = document.getElementById("dash");
  var dashArea = document.getElementById("dash-area");
  var clientsEl = document.getElementById("clients");
  var conn = { worker: null, state: "idle", userClosed: false, retry: 0, timer: null, mcpUrl: "", registered: false };
  var WORKER_SRC = [
    "var ws = null, beat = null;",
    "onmessage = function (e) {",
    "  var d = e.data || {};",
    "  if (d.type === 'open') {",
    "    try { ws = new WebSocket(d.url); } catch (err) { postMessage({ type: 'close', code: 0, reason: String(err) }); return; }",
    "    ws.onopen = function () { ws.send(JSON.stringify({ type: 'register', deviceId: d.deviceId })); beat = setInterval(function () { try { ws.send('{\"type\":\"keepalive\"}'); } catch (x) {} }, 20000); postMessage({ type: 'open' }); };",
    "    ws.onmessage = function (ev) { postMessage({ type: 'message', data: ev.data }); };",
    "    ws.onclose = function (ev) { clearInterval(beat); postMessage({ type: 'close', code: ev.code, reason: ev.reason }); };",
    "  } else if (d.type === 'send') { if (ws && ws.readyState === 1) ws.send(d.data); }",
    "  else if (d.type === 'close') { if (ws) ws.close(1000, 'disconnected by the user'); }",
    "};"
  ].join("\n");

  function setConn(state, info) {
    conn.state = state;
    var wasConnected = connected;
    connected = state !== "idle";
    connectBtn.disabled = state === "connecting";
    connectBtn.textContent = state === "idle" ? "Connect" : state === "connecting" ? "Connecting\u2026" : "Disconnect";
    connectBtn.classList.toggle("on", state === "connected");
    dashSection.hidden = state === "idle";
    connInfo.textContent = info || "";
    if (state === "idle") { abortCalls("the sandbox was disconnected"); clearDash(); }
    if (wasConnected !== connected) render();
  }

  function connect(first) {
    conn.userClosed = false;
    clearTimeout(conn.timer);
    if (first) setConn("connecting");
    fetch("/mcp?ticket=1", { method: "POST", headers: { "x-sandbox": "1" }, credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (r.status === 401) throw new Error("signed out - reload the page and sign in again");
        if (!r.ok) throw new Error("ticket request failed (HTTP " + r.status + ")");
        return r.json();
      })
      .then(function (t) {
        if (conn.userClosed) return;
        if (t.online && first) {
          setConn("idle");
          setStatus("Device " + DEVICE + " is already connected from somewhere else (for example code-mcp or 'mcp connect'). Stop it there, then Connect.", true);
          return;
        }
        conn.mcpUrl = t.mcp_url;
        openSocket(t.ws_url);
      })
      .catch(function (err) {
        if (conn.userClosed) return;
        if (first) { setConn("idle"); setStatus("Could not connect: " + (err && err.message || err), true); }
        else scheduleReconnect();
      });
  }

  function openSocket(url) {
    if (conn.worker) conn.worker.terminate();
    var blobUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
    var w = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);
    conn.worker = w;
    conn.registered = false;
    w.onmessage = function (e) {
      if (w !== conn.worker) return;
      var d = e.data || {};
      if (d.type === "message") onFrame(d.data);
      else if (d.type === "close") onClose(d.code, d.reason);
    };
    w.postMessage({ type: "open", url: url, deviceId: DEVICE });
  }

  function onFrame(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "registered") {
      conn.registered = true;
      conn.retry = 0;
      setStatus("");
      setConn("connected");
      return;
    }
    if (msg.type) return;
    if (typeof msg.id === "string" && msg.request) handleRpc(msg);
  }

  function onClose(code, reason) {
    if (conn.worker) { conn.worker.terminate(); conn.worker = null; }
    if (conn.userClosed || conn.state === "idle") return;
    if (!conn.registered && conn.state === "connecting") {
      setConn("idle");
      setStatus("Could not connect: the gateway refused the tunnel (" + (reason || "code " + code) + "). Is " + DEVICE + " connected from somewhere else?", true);
      return;
    }
    if (/replaced/.test(reason || "")) {
      setConn("idle");
      setStatus("Disconnected: another connection for " + DEVICE + " replaced this one.", true);
      return;
    }
    abortCalls("the connection to the gateway was lost");
    scheduleReconnect();
  }

  function scheduleReconnect() {
    conn.retry += 1;
    if (conn.retry > 8) { setConn("idle"); setStatus("Disconnected: the gateway could not be reached. Connect to try again.", true); return; }
    var delay = Math.min(30000, 1000 * Math.pow(2, conn.retry - 1));
    setConn("reconnecting", "Reconnecting in " + Math.round(delay / 1000) + " s\u2026");
    conn.timer = setTimeout(function () { connect(false); }, delay);
  }

  function disconnect() {
    conn.userClosed = true;
    clearTimeout(conn.timer);
    if (conn.worker) { conn.worker.postMessage({ type: "close" }); var w = conn.worker; conn.worker = null; setTimeout(function () { w.terminate(); }, 500); }
    setConn("idle");
    setStatus("Disconnected.");
  }

  connectBtn.addEventListener("click", function () {
    if (conn.state === "idle") connect(true); else disconnect();
  });
  window.addEventListener("beforeunload", function () { if (conn.worker) conn.worker.postMessage({ type: "close" }); });

  function send(obj) { if (conn.worker) conn.worker.postMessage({ type: "send", data: JSON.stringify(obj) }); }

  // ===========================================================================
  // MCP: exactly two tools, search and call.
  // ===========================================================================
  var SEARCH_TOOL = {
    name: "search",
    description: "Search the tools available in the browser sandbox of device " + DEVICE + ". Returns each match's name, description and inputSchema; run one with the 'call' tool. An empty query lists every active tool.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Words to look for in tool names, descriptions and parameter names" }, limit: { type: "integer", minimum: 1, maximum: 50, description: "At most this many results (default 20)" } }, additionalProperties: false }
  };
  var CALL_TOOL = {
    name: "call",
    description: "Run one of the sandbox's tools (find them with 'search') in the browser of device " + DEVICE + ". Tools can show UI and use a virtual cursor in the page's dash area.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "The tool's name, as returned by search" }, arguments: { type: "object", description: "The tool's arguments, matching its inputSchema" } }, required: ["name"], additionalProperties: false }
  };

  function handleRpc(env) {
    var req = env.request || {};
    var client = env.client && typeof env.client === "object" ? { id: String(env.client.id || "client").slice(0, 32), name: String(env.client.name || "client").slice(0, 40) } : { id: "client", name: "client" };
    if (!Object.prototype.hasOwnProperty.call(req, "id")) { send({ id: env.id, response: null }); return; }
    Promise.resolve().then(function () { return dispatch(req, client); }).then(
      function (result) { send({ id: env.id, response: { jsonrpc: "2.0", id: req.id, result: result } }); },
      function (err) { send({ id: env.id, response: { jsonrpc: "2.0", id: req.id, error: { code: err && err.code || -32603, message: String(err && err.message || err) } } }); }
    );
  }

  function rpcError(code, message) { var e = new Error(message); e.code = code; return e; }
  function textResult(text, isError) { var r = { content: [{ type: "text", text: text }] }; if (isError) r.isError = true; return r; }

  function dispatch(req, client) {
    var p = req.params || {};
    if (req.method === "initialize") {
      return {
        protocolVersion: typeof p.protocolVersion === "string" ? p.protocolVersion : "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "code-mcp-sandbox", version: "1.0.0" },
        instructions: "Tools run in a browser (device " + DEVICE + "). Use 'search' to find a tool and its inputSchema, then 'call' it with {name, arguments}."
      };
    }
    if (req.method === "ping") return {};
    if (req.method === "tools/list") return { tools: [SEARCH_TOOL, CALL_TOOL] };
    if (req.method === "resources/list") return { resources: [] };
    if (req.method === "prompts/list") return { prompts: [] };
    if (req.method === "tools/call") {
      if (p.name === "search") return search(p.arguments || {});
      if (p.name === "call") return callTool(p.arguments || {}, client);
      return textResult("unknown tool '" + p.name + "': this device has 'search' and 'call'", true);
    }
    throw rpcError(-32601, "method not found: " + req.method);
  }

  function activeTools() { return tools.filter(function (t) { return t.active; }); }
  function toolView(t) { return { name: t.name, description: t.description, inputSchema: t.inputSchema }; }

  function search(args) {
    if (args.query !== undefined && typeof args.query !== "string") return textResult("'query' must be a string", true);
    var limit = args.limit === undefined ? 20 : args.limit;
    if (typeof limit !== "number" || !(limit >= 1 && limit <= 50) || Math.floor(limit) !== limit) return textResult("'limit' must be an integer from 1 to 50", true);
    var words = String(args.query || "").toLowerCase().split(/\s+/).filter(Boolean);
    var scored = [];
    activeTools().forEach(function (t) {
      var name = t.name.toLowerCase(), desc = t.description.toLowerCase();
      var params = (t.params || []).map(function (q) { return (q.name + " " + q.description).toLowerCase(); }).join(" ");
      var score = 0, all = true;
      words.forEach(function (w) {
        var s = (name.indexOf(w) >= 0 ? 3 : 0) + (desc.indexOf(w) >= 0 ? 2 : 0) + (params.indexOf(w) >= 0 ? 1 : 0);
        if (!s) all = false;
        score += s;
      });
      if (all) scored.push({ t: t, score: score });
    });
    scored.sort(function (a, b) { return b.score - a.score || (a.t.name < b.t.name ? -1 : 1); });
    var out = { total: scored.length, tools: scored.slice(0, limit).map(function (s) { return toolView(s.t); }) };
    return textResult(JSON.stringify(out, null, 2));
  }

  function typeOk(value, schema) {
    if (!schema || schema.type === undefined) return true;
    var types = Array.isArray(schema.type) ? schema.type : [schema.type];
    return types.some(function (t) {
      if (t === "integer") return typeof value === "number" && Math.floor(value) === value;
      if (t === "array") return Array.isArray(value);
      if (t === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
      if (t === "null") return value === null;
      return typeof value === t;
    });
  }

  function argProblems(t, a) {
    var props = t.inputSchema.properties || {}, problems = [];
    Object.keys(a).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(props, k)) problems.push("unknown argument '" + k + "'"); });
    (t.inputSchema.required || []).forEach(function (k) { if (a[k] === undefined) problems.push("missing required argument '" + k + "'"); });
    Object.keys(props).forEach(function (k) {
      if (a[k] !== undefined && !typeOk(a[k], props[k])) problems.push("'" + k + "' must be " + [].concat(props[k].type).join(" or "));
    });
    return problems;
  }

  function callTool(args, client) {
    if (typeof args.name !== "string") return textResult("'name' must be a string: the tool's name from search", true);
    var t = activeTools().filter(function (x) { return x.name === args.name; })[0];
    if (!t) return textResult("no active tool named '" + args.name + "' - use search to list the tools", true);
    var a = args.arguments === undefined ? {} : args.arguments;
    if (a === null || typeof a !== "object" || Array.isArray(a)) return textResult("'arguments' must be an object", true);
    var problems = argProblems(t, a);
    if (problems.length) return textResult("invalid arguments for '" + t.name + "': " + problems.join("; ") + ". inputSchema: " + JSON.stringify(t.inputSchema), true);
    var positional = (t.params || []).map(function (q) { return a[q.name]; });
    return runTool(t, positional, client).then(function (r) {
      var text = r.ok ? r.text : "error: " + r.error;
      if (r.logs && r.logs.length) text += "\n--- console ---\n" + r.logs.join("\n");
      return textResult(text, !r.ok);
    });
  }

  // One sandboxed iframe per call: calls cannot see each other, and a hung or
  // runaway tool is stopped by removing its frame.
  var CALL_TIMEOUT_MS = 120000;
  var runner = document.createElement("div");
  runner.style.display = "none";
  document.body.appendChild(runner);

  function runTool(tool, args, client, event) {
    return new Promise(function (resolve) {
      var f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts");
      f.src = "/mcp?frame=runtime";
      var call = { frame: f, tool: tool, client: client, done: false, waiters: [] };
      var timer = setTimeout(function () { finish({ ok: false, error: "the tool did not finish within " + CALL_TIMEOUT_MS / 1000 + " s and was stopped", logs: [] }); }, CALL_TIMEOUT_MS);
      function finish(r) {
        if (call.done) return;
        call.done = true;
        clearTimeout(timer);
        f.remove();
        calls = calls.filter(function (c) { return c !== call; });
        call.waiters.slice().forEach(function (w) { w.cancel("the call ended"); });
        updateRunning();
        resolve(r);
      }
      call.finish = finish;
      call.onMessage = function (d) {
        if (d.type === "ready") f.contentWindow.postMessage({ type: "run", source: tool.source, args: args, client: client, event: event || null }, "*");
        else if (d.type === "result") finish({ ok: !!d.ok, text: d.text == null ? "" : String(d.text), error: d.error, logs: Array.isArray(d.logs) ? d.logs.map(String) : [] });
        else if (d.type === "api") handleApi(call, d);
      };
      calls.push(call);
      runner.appendChild(f);
      updateRunning();
    });
  }

  function abortCalls(why) { calls.slice().forEach(function (c) { c.finish({ ok: false, error: why, logs: [] }); }); }
  function updateRunning() {
    var n = calls.length;
    document.getElementById("running").textContent = n ? n + " call" + (n === 1 ? "" : "s") + " running" : "";
  }

  function handleApi(call, d) {
    var fn = API[d.method];
    Promise.resolve().then(function () {
      if (!fn) throw new Error("unknown method " + d.method);
      return fn(call, Array.isArray(d.args) ? d.args : []);
    }).then(
      function (v) { if (!call.done) call.frame.contentWindow.postMessage({ type: "api-result", seq: d.seq, ok: true, value: v === undefined ? null : v }, "*"); },
      function (err) { if (!call.done) call.frame.contentWindow.postMessage({ type: "api-result", seq: d.seq, ok: false, error: String(err && err.message || err) }, "*"); }
    );
  }

  // ===========================================================================
  // Dash: components (rendered by the page, styled by the page) and cursors.
  // ===========================================================================
  var comps = {}, order = 0, cursors = {};
  var MAX_COMPONENTS = 300;
  var CONTAINERS = { row: 1, card: 1 };
  var PALETTE = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed", "#0891b2", "#ca8a04"];

  function str(v, max) { return v === undefined || v === null ? "" : String(v).slice(0, max || 2000); }
  function compOf(id) { var c = comps[id]; if (!c) throw new Error("no component '" + id + "'"); return c; }
  function emptyHint() {
    var e = dashArea.querySelector(".dash-empty");
    var any = Object.keys(comps).length > 0;
    if (e) e.hidden = any;
  }

  // ---- drawn controls (no native checkbox, select or range) ----------------------
  // Each exposes the properties the dash code reads - value / checked / options
  // / disabled - and fires "change" (and "input") like the native ones would.
  function prop(el, name, get, set) { Object.defineProperty(el, name, { get: get, set: set, configurable: true }); }
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

  function makeCheckbox(text, initial) {
    var root = document.createElement("div");
    root.className = "ucheck"; root.tabIndex = 0; root.setAttribute("role", "checkbox");
    var box = document.createElement("span"); box.className = "ucheck-box";
    box.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 L5 8.6 L9.6 3.6" /></svg>';
    var t = document.createElement("span"); t.textContent = text;
    root.appendChild(box); root.appendChild(t);
    var checked = !!initial, disabled = false;
    function paint() { root.classList.toggle("on", checked); root.setAttribute("aria-checked", checked ? "true" : "false"); }
    prop(root, "checked", function () { return checked; }, function (v) { checked = !!v; paint(); });
    prop(root, "disabled", function () { return disabled; }, function (v) { disabled = !!v; root.classList.toggle("disabled", disabled); root.tabIndex = disabled ? -1 : 0; root.setAttribute("aria-disabled", String(disabled)); });
    function toggle() { if (disabled) return; checked = !checked; paint(); fire(root, "change"); }
    root.addEventListener("click", toggle);
    root.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
    paint();
    return root;
  }

  var openSelect = null;
  document.addEventListener("click", function (e) { if (openSelect && !openSelect.contains(e.target) && !openSelect.__list.contains(e.target)) openSelect.__close(); });
  window.addEventListener("resize", function () { if (openSelect) openSelect.__close(); });
  document.addEventListener("scroll", function () { if (openSelect) openSelect.__close(); }, true);

  function makeSelect(opts, initial) {
    var root = document.createElement("div");
    root.className = "usel"; root.tabIndex = 0;
    root.setAttribute("role", "combobox"); root.setAttribute("aria-haspopup", "listbox"); root.setAttribute("aria-expanded", "false");
    var shown = document.createElement("span"); shown.className = "usel-value";
    var chev = document.createElement("span"); chev.className = "usel-chev";
    chev.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" /></svg>';
    root.appendChild(shown); root.appendChild(chev);
    // The list is fixed-positioned on the page, so the dash's scroll box cannot clip it.
    var list = document.createElement("div"); list.className = "usel-list"; list.setAttribute("role", "listbox");
    var current = opts.some(function (o) { return o.value === initial; }) ? initial : opts[0].value;
    var active = 0, disabled = false;
    var items = opts.map(function (o, i) {
      var it = document.createElement("div"); it.className = "usel-item"; it.setAttribute("role", "option"); it.textContent = o.label;
      it.addEventListener("mousedown", function (e) { e.preventDefault(); });
      it.addEventListener("click", function (e) { e.stopPropagation(); choose(o.value); root.focus(); });
      it.addEventListener("mousemove", function () { setActive(i); });
      list.appendChild(it);
      return it;
    });
    function indexOf(v) { for (var i = 0; i < opts.length; i++) if (opts[i].value === v) return i; return -1; }
    function paint() {
      var i = indexOf(current);
      shown.textContent = i >= 0 ? opts[i].label : "";
      items.forEach(function (it, k) { it.setAttribute("aria-selected", k === i ? "true" : "false"); });
    }
    function setActive(i) { active = Math.max(0, Math.min(opts.length - 1, i)); items.forEach(function (it, k) { it.classList.toggle("active", k === active); }); items[active].scrollIntoView({ block: "nearest" }); }
    function open() {
      if (disabled || root.__isOpen) return;
      if (openSelect && openSelect !== root) openSelect.__close();
      document.body.appendChild(list);
      var r = root.getBoundingClientRect();
      list.style.minWidth = r.width + "px";
      list.style.left = r.left + "px";
      var h = Math.min(list.scrollHeight, 240);
      list.style.top = (r.bottom + 4 + h > window.innerHeight && r.top - 4 - h > 0 ? r.top - 4 - h : r.bottom + 4) + "px";
      root.__isOpen = true; openSelect = root;
      root.classList.add("open"); root.setAttribute("aria-expanded", "true");
      setActive(Math.max(0, indexOf(current)));
    }
    function close() {
      if (!root.__isOpen) return;
      root.__isOpen = false; if (openSelect === root) openSelect = null;
      list.remove(); root.classList.remove("open"); root.setAttribute("aria-expanded", "false");
    }
    function choose(v) { var changed = v !== current; current = v; paint(); close(); if (changed) fire(root, "change"); }
    root.addEventListener("click", function () { if (root.__isOpen) close(); else open(); });
    root.addEventListener("keydown", function (e) {
      if (disabled) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!root.__isOpen) open(); else setActive(active + (e.key === "ArrowDown" ? 1 : -1)); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (root.__isOpen) choose(opts[active].value); else open(); }
      else if (e.key === "Escape" || e.key === "Tab") close();
      else if (e.key === "Home" && root.__isOpen) { e.preventDefault(); setActive(0); }
      else if (e.key === "End" && root.__isOpen) { e.preventDefault(); setActive(opts.length - 1); }
    });
    root.addEventListener("blur", function () { setTimeout(function () { if (document.activeElement !== root) close(); }, 0); });
    prop(root, "value", function () { return current; }, function (v) { v = String(v); if (indexOf(v) >= 0) { current = v; paint(); } });
    prop(root, "options", function () { return opts.map(function (o) { return { value: o.value, label: o.label }; }); });
    prop(root, "disabled", function () { return disabled; }, function (v) { disabled = !!v; if (disabled) close(); root.classList.toggle("disabled", disabled); root.tabIndex = disabled ? -1 : 0; root.setAttribute("aria-disabled", String(disabled)); });
    root.__open = open; root.__close = close; root.__list = list;
    root.__item = function (v) { var i = indexOf(v); return i >= 0 ? items[i] : null; };
    paint();
    return root;
  }

  function makeSlider(min, max, step, initial) {
    var root = document.createElement("div");
    root.className = "uslide"; root.tabIndex = 0; root.setAttribute("role", "slider");
    root.setAttribute("aria-valuemin", String(min)); root.setAttribute("aria-valuemax", String(max));
    var track = document.createElement("div"); track.className = "uslide-track";
    var fill = document.createElement("div"); fill.className = "uslide-fill";
    var thumb = document.createElement("div"); thumb.className = "uslide-thumb";
    var out = document.createElement("span"); out.className = "uslide-value";
    track.appendChild(fill); track.appendChild(thumb); root.appendChild(track); root.appendChild(out);
    var value = min, disabled = false;
    function snap(v) {
      v = Math.max(min, Math.min(max, Number(v)));
      if (!isFinite(v)) v = min;
      v = min + Math.round((v - min) / step) * step;
      return Math.max(min, Math.min(max, Number(v.toFixed(10))));
    }
    function paint() {
      var p = (value - min) / (max - min) * 100;
      fill.style.width = p + "%"; thumb.style.left = p + "%";
      out.textContent = String(value); root.setAttribute("aria-valuenow", String(value));
    }
    function set(v, evt) { var n = snap(v); if (n === value) return; value = n; paint(); if (evt) fire(root, "input"); }
    function fromX(x) { var r = track.getBoundingClientRect(); return min + (Math.max(0, Math.min(r.width, x - r.left)) / (r.width || 1)) * (max - min); }
    root.addEventListener("pointerdown", function (e) {
      if (disabled) return;
      e.preventDefault(); root.focus();
      var start = value;
      root.setPointerCapture(e.pointerId);
      root.classList.add("dragging");
      set(fromX(e.clientX), true);
      function move(ev) { set(fromX(ev.clientX), true); }
      function up() {
        root.removeEventListener("pointermove", move); root.removeEventListener("pointerup", up); root.removeEventListener("pointercancel", up);
        root.classList.remove("dragging");
        if (value !== start) fire(root, "change");
      }
      root.addEventListener("pointermove", move); root.addEventListener("pointerup", up); root.addEventListener("pointercancel", up);
    });
    root.addEventListener("keydown", function (e) {
      if (disabled) return;
      var before = value, big = Math.max(step, (max - min) / 10);
      if (e.key === "ArrowRight" || e.key === "ArrowUp") set(value + step, true);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") set(value - step, true);
      else if (e.key === "PageUp") set(value + big, true);
      else if (e.key === "PageDown") set(value - big, true);
      else if (e.key === "Home") set(min, true);
      else if (e.key === "End") set(max, true);
      else return;
      e.preventDefault();
      if (value !== before) fire(root, "change");
    });
    prop(root, "value", function () { return String(value); }, function (v) { set(v, false); });
    prop(root, "min", function () { return String(min); }, function () {});
    prop(root, "max", function () { return String(max); }, function () {});
    prop(root, "disabled", function () { return disabled; }, function (v) { disabled = !!v; root.classList.toggle("disabled", disabled); root.tabIndex = disabled ? -1 : 0; root.setAttribute("aria-disabled", String(disabled)); });
    value = snap(initial); paint();
    return root;
  }

  window.__buildComponent = buildComponent;
  function buildComponent(spec) {
    var type = spec.type;
    var el = document.createElement("div");
    el.className = "uc uc-" + type;
    var input = null, body = null;
    function label(text) { if (!text) return; var l = document.createElement("div"); l.className = "uc-label"; l.textContent = str(text, 120); el.appendChild(l); }
    if (type === "heading") { el.textContent = str(spec.text, 200); }
    else if (type === "text") { el.textContent = str(spec.text, 20000); if (spec.muted) el.classList.add("muted"); }
    else if (type === "code") { var pre = document.createElement("pre"); pre.textContent = str(spec.text, 50000); el.appendChild(pre); }
    else if (type === "image") {
      var src = str(spec.src, 3000000);
      if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+\/=]+$/.test(src)) throw new Error("image: src must be a base64 data:image/... URL (tools have no network)");
      var img = document.createElement("img"); img.src = src; img.alt = str(spec.alt, 200);
      if (spec.width) img.style.width = Math.max(16, Math.min(640, Number(spec.width) || 0)) + "px";
      el.appendChild(img);
    }
    else if (type === "editor") { label(spec.label); input = document.createElement("textarea"); input.className = "ueditor"; input.spellcheck = false; input.value = str(spec.value, 200000); input.rows = Math.max(3, Math.min(30, Number(spec.rows) || 10)); input.readOnly = !!spec.readonly; el.appendChild(input); }
    else if (type === "button") {
      input = document.createElement("button"); input.type = "button"; input.className = "ubtn" + (spec.variant === "secondary" ? " secondary" : spec.variant === "danger" ? " danger" : ""); input.textContent = str(spec.label || "Button", 80); input.disabled = !!spec.disabled; el.appendChild(input);
    }
    else if (type === "input") { label(spec.label); input = document.createElement("input"); input.type = "text"; input.className = "uinput"; input.placeholder = str(spec.placeholder, 200); input.value = str(spec.value, 5000); el.appendChild(input); }
    else if (type === "textarea") { label(spec.label); input = document.createElement("textarea"); input.className = "utextarea"; input.placeholder = str(spec.placeholder, 200); input.value = str(spec.value, 100000); input.rows = Math.max(2, Math.min(20, Number(spec.rows) || 4)); el.appendChild(input); }
    else if (type === "checkbox") { input = makeCheckbox(str(spec.label, 200), !!spec.checked); el.appendChild(input); }
    else if (type === "select") {
      label(spec.label);
      var opts = (Array.isArray(spec.options) ? spec.options : []).slice(0, 200).map(function (o) {
        return o && typeof o === "object" ? { value: str(o.value, 200), label: str(o.label === undefined ? o.value : o.label, 200) } : { value: str(o, 200), label: str(o, 200) };
      });
      if (!opts.length) throw new Error("select: give it options, e.g. options: ['S', 'M', 'L']");
      input = makeSelect(opts, spec.value === undefined ? undefined : str(spec.value, 200));
      el.appendChild(input);
    }
    else if (type === "slider") {
      label(spec.label);
      var min = Number(spec.min) || 0, max = spec.max === undefined ? 100 : Number(spec.max);
      if (!(max > min)) throw new Error("slider: max must be greater than min");
      input = makeSlider(min, max, Number(spec.step) > 0 ? Number(spec.step) : 1, spec.value === undefined ? min : Number(spec.value));
      el.appendChild(input);
    }
    else if (type === "status") {
      var dot = document.createElement("span"); dot.className = "dot " + (spec.state === "off" ? "off" : spec.state === "pending" ? "pending" : "on");
      var t = document.createElement("span"); t.textContent = str(spec.text, 200);
      el.appendChild(dot); el.appendChild(t);
    }
    else if (type === "divider") { }
    else if (type === "row") { body = el; }
    else if (type === "card") {
      if (spec.title) { var h = document.createElement("div"); h.className = "uc-title"; h.textContent = str(spec.title, 120); el.appendChild(h); }
      body = document.createElement("div"); body.className = "uc-body"; el.appendChild(body);
    }
    else throw new Error("unknown component type '" + type + "' - use heading, text, code, image, editor, button, input, textarea, checkbox, select, slider, status, divider, row or card");
    return { el: el, input: input, body: body };
  }

  // Every interaction - by the person or by a client's cursor - is logged (for
  // ui.events), wakes ui.wait / ui.events callers, and runs the component's
  // handler, if it has one.
  var eventLog = [], eventSeq = 0, eventWaiters = [], handlerRuns = 0;
  var MAX_HANDLER_RUNS = 4;
  function notify(c, ev) {
    ev.seq = ++eventSeq;
    ev.at = new Date().toISOString();
    ev.type = c.type;
    eventLog.push(ev);
    if (eventLog.length > 200) eventLog.shift();
    c.waiters.slice().forEach(function (w) { if (!w.event || w.event === ev.event) w.resolve(ev); });
    eventWaiters.slice().forEach(function (w) { w.check(); });
    runHandler(c, ev);
  }

  function handlerSpec(on) {
    if (on === undefined || on === null) return null;
    if (typeof on !== "object" || Array.isArray(on)) throw new Error("'on' must be an object like { click: { tool: 'name', args: {...} } }");
    var out = {};
    Object.keys(on).forEach(function (ev) {
      if (ev !== "click" && ev !== "change") throw new Error("'on' supports click and change, not '" + ev + "'");
      var h = on[ev];
      if (typeof h === "string") h = { tool: h };
      if (!h || typeof h.tool !== "string") throw new Error("on." + ev + " needs { tool: 'name', args: {...} }");
      var t = activeTools().filter(function (x) { return x.name === h.tool; })[0];
      if (!t) throw new Error("on." + ev + ": no active tool named '" + h.tool + "'");
      var args = h.args === undefined ? {} : h.args;
      if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("on." + ev + ".args must be an object");
      var problems = argProblems(t, args);
      if (problems.length) throw new Error("on." + ev + " -> " + t.name + ": " + problems.join("; "));
      out[ev] = { tool: t.name, args: args };
    });
    return out;
  }

  function dashNote(text, isErr) {
    var el = document.getElementById("running");
    el.textContent = text; el.style.color = isErr ? "#b91c1c" : "#666";
    clearTimeout(dashNote.t);
    dashNote.t = setTimeout(function () { el.style.color = "#666"; updateRunning(); }, 6000);
  }

  function runHandler(c, ev) {
    var h = c.handlers && c.handlers[ev.event];
    if (!h || conn.state === "idle") return;
    if (c.handlerBusy) { ev.handler = "skipped: the previous run of " + h.tool + " is still going"; return; }
    if (handlerRuns >= MAX_HANDLER_RUNS) { ev.handler = "skipped: too many handlers running"; return; }
    var t = activeTools().filter(function (x) { return x.name === h.tool; })[0];
    if (!t) { ev.handler = "skipped: tool " + h.tool + " is not active"; return; }
    c.handlerBusy = true; handlerRuns++;
    ev.handler = h.tool;
    var positional = (t.params || []).map(function (q) { return h.args[q.name]; });
    var detail = {}; Object.keys(ev).forEach(function (k) { if (k !== "handler") detail[k] = ev[k]; });
    runTool(t, positional, c.ownerClient, detail).then(function (r) {
      c.handlerBusy = false; handlerRuns--;
      if (!r.ok) dashNote(h.tool + " (on " + ev.event + " of " + c.id + ") failed: " + r.error, true);
    });
  }

  function wire(c) {
    var i = c.input;
    if (!i) return;
    if (c.type === "button") i.addEventListener("click", function () { if (!c.synthetic) notify(c, { event: "click", id: c.id, by: "user" }); });
    else if (c.type === "checkbox") i.addEventListener("change", function () { if (!c.synthetic) notify(c, { event: "change", id: c.id, checked: i.checked, by: "user" }); });
    else {
      i.addEventListener("change", function () { if (!c.synthetic) notify(c, { event: "change", id: c.id, value: i.value, by: "user" }); });
      if (c.type === "input") i.addEventListener("keydown", function (e) { if (e.key === "Enter") i.blur(); });
    }
  }

  function addComponent(call, spec) {
    if (!spec || typeof spec !== "object") throw new Error("ui.add needs a component, e.g. { type: 'button', label: 'Run' }");
    if (Object.keys(comps).length >= MAX_COMPONENTS) throw new Error("the dash holds at most " + MAX_COMPONENTS + " components");
    var built = buildComponent(spec);
    var id = "c" + (++order);
    var handlers = handlerSpec(spec.on);
    var c = { id: id, type: spec.type, el: built.el, input: built.input, body: built.body, owner: call ? call.client.id : "", ownerClient: call ? call.client : { id: "page", name: "page" }, waiters: [], spec: spec, handlers: handlers };
    built.el.dataset.cid = id;
    var host = dashArea;
    if (spec.parent !== undefined && spec.parent !== null) {
      var p = compOf(String(spec.parent));
      if (!p.body) throw new Error("parent '" + spec.parent + "' is a " + p.type + "; only row and card hold components");
      host = p.body;
    }
    host.appendChild(built.el);
    reveal(built.el);
    comps[id] = c;
    wire(c);
    emptyHint();
    return id;
  }

  function removeComponent(id) {
    var c = comps[id];
    if (!c) return;
    c.el.querySelectorAll("[data-cid]").forEach(function (child) { delete comps[child.dataset.cid]; });
    c.waiters.slice().forEach(function (w) { w.cancel("the component was removed"); });
    if (openSelect && c.el.contains(openSelect)) openSelect.__close();
    c.el.remove();
    delete comps[id];
    emptyHint();
  }

  function clearDash() {
    Object.keys(comps).forEach(removeComponent);
    Object.keys(cursors).forEach(function (k) { cursors[k].el.remove(); });
    cursors = {};
    clientsEl.textContent = "";
    eventLog = []; eventSeq = 0;
    emptyHint();
  }

  function describe(c) {
    var d = { id: c.id, type: c.type };
    if (c.spec.label !== undefined) d.label = str(c.spec.label, 200);
    if (c.spec.text !== undefined) d.text = str(c.spec.text, 2000);
    if (c.type === "checkbox") d.checked = c.input.checked;
    else if (c.input && "value" in c.input && c.type !== "button") d.value = c.input.value;
    if (c.input && c.input.disabled) d.disabled = true;
    if (c.handlers) d.on = c.handlers;
    return d;
  }

  function update(c, props) {
    if (!props || typeof props !== "object") throw new Error("ui.update needs an object of properties");
    if (CONTAINERS[c.type]) {
      if (props.title !== undefined && c.type === "card") { var t = c.el.querySelector(".uc-title"); if (t) t.textContent = str(props.title, 120); }
      return describe(c);
    }
    if (props.on !== undefined) c.handlers = handlerSpec(props.on);
    var spec = Object.assign({}, c.spec, props, { type: c.type, parent: c.spec.parent });
    if (c.input && props.value === undefined && c.type !== "button" && c.type !== "checkbox") spec.value = c.input.value;
    if (c.type === "checkbox" && props.checked === undefined) spec.checked = c.input.checked;
    var built = buildComponent(spec);
    built.el.dataset.cid = c.id;
    c.el.replaceWith(built.el);
    c.el = built.el; c.input = built.input; c.spec = spec;
    wire(c);
    return describe(c);
  }

  // ---- cursors ------------------------------------------------------------------
  function cursorFor(client) {
    var cur = cursors[client.id];
    if (cur) return cur;
    // The first colour no cursor on the dash is using: clients stay apart.
    var used = Object.keys(cursors).map(function (k) { return cursors[k].color; });
    var color = PALETTE.filter(function (c) { return used.indexOf(c) < 0; })[0] || PALETTE[used.length % PALETTE.length];
    var el = document.createElement("div");
    el.className = "cur";
    el.innerHTML = '<svg viewBox="0 0 16 20" aria-hidden="true"><path d="M1 1 L1 16 L5 12 L8 19 L11 17.6 L8 11 L14 11 Z" /></svg><span class="cur-name"></span>';
    el.querySelector(".cur-name").textContent = client.name;
    el.querySelector(".cur-name").style.background = color;
    el.style.setProperty("--cur", color);
    dashArea.appendChild(el);
    cur = { el: el, x: 12, y: 12, client: client, color: color };
    el.style.transform = "translate(12px, 12px)";
    cursors[client.id] = cur;
    clientsEl.textContent = "clients: " + Object.keys(cursors).map(function (k) { return cursors[k].client.name; }).join(", ");
    return cur;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Keep what a tool works on in view: inside the dash's own scroll area only.
  function reveal(el) {
    var a = dashArea.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.bottom > a.bottom) dashArea.scrollTop += r.bottom - a.bottom + 16;
    else if (r.top < a.top) dashArea.scrollTop -= a.top - r.top + 16;
  }
  function pointIn(c, fx, fy) {
    reveal(c.el);
    var a = dashArea.getBoundingClientRect(), r = (c.input || c.el).getBoundingClientRect();
    return { x: r.left - a.left + dashArea.scrollLeft + r.width * (fx === undefined ? 0.5 : fx), y: r.top - a.top + dashArea.scrollTop + r.height * (fy === undefined ? 0.5 : fy) };
  }
  function moveTo(cur, p, ms) {
    cur.el.style.transition = "transform " + (ms || 380) + "ms cubic-bezier(.3,.7,.4,1)";
    cur.el.style.transform = "translate(" + Math.round(p.x) + "px, " + Math.round(p.y) + "px)";
    cur.x = p.x; cur.y = p.y;
    return sleep((ms || 380) + 40);
  }
  function pulse(cur) {
    cur.el.classList.remove("click"); void cur.el.offsetWidth; cur.el.classList.add("click");
    return sleep(160);
  }
  function needInput(c, kinds) {
    if (kinds.indexOf(c.type) < 0) throw new Error("component '" + c.id + "' is a " + c.type + "; this works on " + kinds.join(", "));
    if (c.input.disabled) throw new Error("component '" + c.id + "' is disabled");
  }
  function setValue(c, value, by) {
    c.synthetic = true;
    c.input.value = value;
    c.input.dispatchEvent(new Event("input", { bubbles: true }));
    c.synthetic = false;
    notify(c, { event: "change", id: c.id, value: c.input.value, by: by });
  }

  var TEXTUAL = ["input", "textarea", "editor"];
  var API = {
    "ui.add": function (call, a) { return addComponent(call, a[0]); },
    "ui.update": function (call, a) { return update(compOf(String(a[0])), a[1]); },
    "ui.get": function (call, a) { return describe(compOf(String(a[0]))); },
    "ui.remove": function (call, a) { compOf(String(a[0])); removeComponent(String(a[0])); return true; },
    "ui.clear": function (call) {
      var n = 0;
      Object.keys(comps).forEach(function (id) { if (comps[id] && comps[id].owner === call.client.id) { removeComponent(id); n++; } });
      return n;
    },
    "ui.list": function () { return Object.keys(comps).map(function (id) { return describe(comps[id]); }); },
    "ui.wait": function (call, a) {
      var c = compOf(String(a[0])), o = a[1] || {};
      var ms = Math.max(100, Math.min(CALL_TIMEOUT_MS - 5000, Number(o.timeout) || 60000));
      return new Promise(function (resolve, reject) {
        var w = { event: o.event === "click" || o.event === "change" ? o.event : null };
        var timer = setTimeout(function () { done(); resolve({ event: "timeout", id: c.id }); }, ms);
        function done() { clearTimeout(timer); c.waiters = c.waiters.filter(function (x) { return x !== w; }); call.waiters = call.waiters.filter(function (x) { return x !== w; }); }
        w.resolve = function (ev) { done(); resolve(ev); };
        w.cancel = function (why) { done(); reject(new Error(why)); };
        c.waiters.push(w); call.waiters.push(w);
      });
    },
    "ui.events": function (call, a) {
      var o = a[0] || {}, since = Number(o.since) || 0;
      var ids = Array.isArray(o.ids) ? o.ids.map(String) : o.id !== undefined ? [String(o.id)] : null;
      function pick() { return eventLog.filter(function (e) { return e.seq > since && (!ids || ids.indexOf(e.id) >= 0); }); }
      function result(list) { return { events: list, next: list.length ? list[list.length - 1].seq : Math.max(since, 0), latest: eventSeq }; }
      var now = pick();
      var ms = Math.max(0, Math.min(CALL_TIMEOUT_MS - 5000, (Number(o.timeout) || 0)));
      if (now.length || !ms) return result(now);
      return new Promise(function (resolve, reject) {
        var w = {};
        var timer = setTimeout(function () { done(); resolve(result([])); }, ms);
        function done() { clearTimeout(timer); eventWaiters = eventWaiters.filter(function (x) { return x !== w; }); call.waiters = call.waiters.filter(function (x) { return x !== w; }); }
        w.check = function () { var l = pick(); if (l.length) { done(); resolve(result(l)); } };
        w.cancel = function (why) { done(); reject(new Error(why)); };
        eventWaiters.push(w); call.waiters.push(w);
      });
    },
    "cursor.move": function (call, a) { var c = compOf(String(a[0])); return moveTo(cursorFor(call.client), pointIn(c)).then(function () { return true; }); },
    "cursor.click": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client);
      return moveTo(cur, pointIn(c)).then(function () { return pulse(cur); }).then(function () {
        if (c.input && c.input.disabled) throw new Error("component '" + c.id + "' is disabled");
        if (c.type === "button") { c.input.classList.add("pressed"); setTimeout(function () { c.input.classList.remove("pressed"); }, 180); notify(c, { event: "click", id: c.id, by: call.client.name }); }
        else if (c.type === "checkbox") { c.input.checked = !c.input.checked; notify(c, { event: "change", id: c.id, checked: c.input.checked, by: call.client.name }); }
        else if (c.input && c.input.focus) c.input.focus();
        return describe(c);
      });
    },
    "cursor.type": function (call, a) {
      var c = compOf(String(a[0])), text = str(a[1], 5000), cur = cursorFor(call.client);
      needInput(c, TEXTUAL);
      if (c.input.readOnly) throw new Error("component '" + c.id + "' is read-only");
      var stepMs = text.length > 400 ? 2 : text.length > 100 ? 10 : 35;
      return moveTo(cur, pointIn(c, 0.15)).then(function () { return pulse(cur); }).then(function () {
        c.input.focus();
        var i = 0;
        return new Promise(function (resolve) {
          (function next() {
            if (i >= text.length || !comps[c.id]) { resolve(); return; }
            var chunk = stepMs < 5 ? text.slice(i, i + 8) : text[i];
            i += chunk.length;
            c.input.value += chunk;
            c.input.dispatchEvent(new Event("input", { bubbles: true }));
            setTimeout(next, stepMs);
          })();
        });
      }).then(function () { notify(c, { event: "change", id: c.id, value: c.input.value, by: call.client.name }); return describe(c); });
    },
    "cursor.fill": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client);
      needInput(c, TEXTUAL);
      if (c.input.readOnly) throw new Error("component '" + c.id + "' is read-only");
      return moveTo(cur, pointIn(c, 0.15)).then(function () { return pulse(cur); }).then(function () { setValue(c, str(a[1], 200000), call.client.name); return describe(c); });
    },
    "cursor.check": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client);
      needInput(c, ["checkbox"]);
      return moveTo(cur, pointIn(c)).then(function () { return pulse(cur); }).then(function () {
        if (c.input.checked !== !!a[1]) { c.input.checked = !!a[1]; notify(c, { event: "change", id: c.id, checked: c.input.checked, by: call.client.name }); }
        return describe(c);
      });
    },
    "cursor.select": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client), v = str(a[1], 200);
      needInput(c, ["select"]);
      if (!c.input.options.some(function (o) { return o.value === v; })) throw new Error("select '" + c.id + "' has no option '" + v + "'");
      return moveTo(cur, pointIn(c)).then(function () { return pulse(cur); }).then(function () {
        c.input.__open();
        var item = c.input.__item(v), a = dashArea.getBoundingClientRect(), r = item.getBoundingClientRect();
        return moveTo(cur, { x: r.left - a.left + dashArea.scrollLeft + Math.min(24, r.width / 2), y: r.top - a.top + dashArea.scrollTop + r.height / 2 }, 300);
      }).then(function () { return pulse(cur); }).then(function () {
        c.input.__close();
        if (c.input.value !== v) { c.synthetic = true; c.input.value = v; c.synthetic = false; notify(c, { event: "change", id: c.id, value: v, by: call.client.name }); }
        return describe(c);
      });
    },
    "cursor.drag": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client), target = a[1];
      if (c.type === "slider") {
        if (typeof target !== "number") throw new Error("dragging a slider needs a number to drag it to");
        needInput(c, ["slider"]);
        var min = Number(c.input.min), max = Number(c.input.max), v = Math.max(min, Math.min(max, target));
        var from = (Number(c.input.value) - min) / ((max - min) || 1), to = (v - min) / ((max - min) || 1);
        return moveTo(cur, pointIn(c, from)).then(function () { cur.el.classList.add("grab"); return moveTo(cur, pointIn(c, to), 600); })
          .then(function () { cur.el.classList.remove("grab"); setValue(c, String(v), call.client.name); return describe(c); });
      }
      var t = compOf(String(target));
      if (t === c || c.el.contains(t.el)) throw new Error("cannot drag a component onto itself");
      return moveTo(cur, pointIn(c)).then(function () { cur.el.classList.add("grab"); c.el.classList.add("dragging"); return moveTo(cur, pointIn(t, 0.5, 0.1), 650); })
        .then(function () {
          cur.el.classList.remove("grab"); c.el.classList.remove("dragging");
          t.el.parentNode.insertBefore(c.el, t.el);
          return { moved: c.id, before: t.id };
        });
    }
  };

  // ---- the Components reference (same renderer as the dash) -----------------------
  var SAMPLES = [
    ["heading", { type: "heading", text: "Heading" }],
    ["text", { type: "text", text: "Plain text, wrapping as needed." }],
    ["code", { type: "code", text: "const x = 42;" }],
    ["status", { type: "status", text: "Running", state: "on" }],
    ["button", { type: "button", label: "Run" }],
    ["button (secondary)", { type: "button", label: "Cancel", variant: "secondary" }],
    ["button (danger)", { type: "button", label: "Delete", variant: "danger" }],
    ["input", { type: "input", label: "Name", placeholder: "type here" }],
    ["textarea", { type: "textarea", label: "Notes", rows: 2 }],
    ["checkbox", { type: "checkbox", label: "I agree" }],
    ["select", { type: "select", label: "Size", options: ["S", "M", "L"], value: "M" }],
    ["slider", { type: "slider", label: "Volume", min: 0, max: 10, value: 4 }],
    ["editor", { type: "editor", label: "Editor", value: "function hi() {\n  return 'hi';\n}", rows: 3 }],
    ["card", { type: "card", title: "Card" }]
  ];
  var gal = document.getElementById("gallery-list");
  SAMPLES.forEach(function (s) {
    var item = document.createElement("div"); item.className = "gal-item";
    var name = document.createElement("div"); name.className = "gal-name"; name.textContent = s[0];
    var demo = document.createElement("div"); demo.className = "gal-demo";
    var b = buildComponent(s[1]);
    if (b.body) { var inner = buildComponent({ type: "text", text: "Components inside a card or row.", muted: true }); b.body.appendChild(inner.el); }
    demo.appendChild(b.el);
    var code = document.createElement("code"); code.className = "gal-code"; code.textContent = "ui.add(" + JSON.stringify(s[1]) + ")";
    item.appendChild(name); item.appendChild(demo); item.appendChild(code);
    gal.appendChild(item);
  });

  // ---- starter tools: added once, on a first visit with no tools --------------
  function seedStarters() {
    var seeded = null;
    try { seeded = localStorage.getItem(SEEDED_KEY); } catch (e) {}
    if (seeded || tools.length || !STARTERS.length) return;
    var chain = Promise.resolve(), added = 0;
    STARTERS.forEach(function (s) {
      chain = chain.then(function () {
        return validateAndStore(s.source, s.filename, null).then(function (r) { if (r.ok) added++; });
      });
    });
    chain.then(function () {
      try { localStorage.setItem(SEEDED_KEY, new Date().toISOString()); } catch (e) {}
      render();
      if (added) setStatus("Added " + added + " starter tools for building an interactive dashboard - View them as examples, or delete the ones you do not need.");
    });
  }
  seedStarters();

  window.__sandbox = { analyze: analyze, tools: function () { return tools; }, comps: function () { return comps; }, state: function () { return conn.state; } };
  render();
})();`;

/** Example tools added on a first visit with no tools: building blocks for an
 *  interactive dashboard, and templates for writing new tools. */
export const STARTER_TOOLS: { filename: string; source: string }[] = [
  {
    "filename": "dashboard_add.js",
    "source": "/**\n * Add a component to the dashboard and return its id. Types: heading, text, code,\n * image (data URL), editor, button, input, textarea, checkbox, select, slider,\n * status, divider, row, card. Put it inside a row or card with spec.parent.\n * Example spec: {\"type\": \"card\", \"title\": \"Build\"} or {\"type\": \"button\", \"label\": \"Run\", \"parent\": \"c1\"}.\n * Make it interactive with \"on\": {\"click\": {\"tool\": \"increment\", \"args\": {\"id\": \"c2\"}}}\n * (or \"change\"): each click or change runs that tool in the browser, no agent needed.\n * @param {object} spec The component, e.g. {\"type\": \"text\", \"text\": \"Hello\"}\n */\nexport default async function dashboard_add(spec) {\n  return await ui.add(spec);\n}\n"
  },
  {
    "filename": "dashboard_update.js",
    "source": "/**\n * Change a dashboard component: its text, label, value, options, checked,\n * variant, state or disabled. Returns the component as it is now.\n * @param {string} id The component id (from dashboard_add or dashboard_list)\n * @param {object} props The properties to change, e.g. {\"text\": \"Done\", \"state\": \"off\"}\n */\nexport default async function dashboard_update(id, props) {\n  return await ui.update(id, props);\n}\n"
  },
  {
    "filename": "dashboard_list.js",
    "source": "/**\n * List every component on the dashboard with its id, type and current value,\n * so an agent can see what is there - including what the user typed or checked.\n */\nexport default async function dashboard_list() {\n  return await ui.list();\n}\n"
  },
  {
    "filename": "dashboard_remove.js",
    "source": "/**\n * Remove one component (and anything inside it), or - with no id - everything\n * this client added to the dashboard.\n * @param {string} [id] The component to remove; omit to clear your components\n */\nexport default async function dashboard_remove(id) {\n  if (id === undefined) return { removed: await ui.clear() };\n  await ui.remove(id);\n  return { removed: 1 };\n}\n"
  },
  {
    "filename": "dashboard_events.js",
    "source": "/**\n * What happened on the dashboard: clicks and changes by the person at the\n * browser or by any client's cursor, oldest first. Pass the returned 'next' as\n * 'since' to get only newer events; with timeout_seconds, wait for one.\n * @param {integer} [since=0] Only events after this sequence number\n * @param {number} [timeout_seconds=0] Wait up to this long when nothing new has happened\n */\nexport default async function dashboard_events(since = 0, timeout_seconds = 0) {\n  return await ui.events({ since, timeout: Math.min(timeout_seconds, 110) * 1000 });\n}\n"
  },
  {
    "filename": "ask_user.js",
    "source": "/**\n * Ask the person at the browser a question and wait for the answer (typed into\n * a box on the dashboard, sent with Enter or the Send button).\n * @param {string} question What to ask\n * @param {string} [placeholder] Hint shown in the empty answer box\n * @param {number} [timeout_seconds=100] How long to wait for an answer\n */\nexport default async function ask_user(question, placeholder, timeout_seconds = 100) {\n  const card = await ui.add({ type: \"card\", title: \"Question\" });\n  await ui.add({ type: \"text\", text: question, parent: card });\n  const row = await ui.add({ type: \"row\", parent: card });\n  const answer = await ui.add({ type: \"input\", placeholder: placeholder || \"your answer\", parent: row });\n  const send = await ui.add({ type: \"button\", label: \"Send\", parent: row });\n  const timeout = Math.min(timeout_seconds, 110) * 1000;\n  const quiet = (p) => p.catch(() => ({ event: \"cancelled\" }));\n  const ev = await Promise.race([quiet(ui.wait(send, { event: \"click\", timeout })), quiet(ui.wait(answer, { event: \"change\", timeout }))]);\n  const text = (await ui.get(answer)).value;\n  await ui.remove(card);\n  if (ev.event === \"timeout\") return { answered: false };\n  return { answered: true, answer: text };\n}\n"
  },
  {
    "filename": "confirm.js",
    "source": "/**\n * Ask the person at the browser to confirm something: shows the message with\n * Yes and No buttons and waits for a click. Returns true for Yes.\n * @param {string} message What to confirm\n * @param {number} [timeout_seconds=100] How long to wait\n */\nexport default async function confirm(message, timeout_seconds = 100) {\n  const card = await ui.add({ type: \"card\", title: \"Confirm\" });\n  await ui.add({ type: \"text\", text: message, parent: card });\n  const row = await ui.add({ type: \"row\", parent: card });\n  const yes = await ui.add({ type: \"button\", label: \"Yes\", parent: row });\n  const no = await ui.add({ type: \"button\", label: \"No\", variant: \"secondary\", parent: row });\n  const timeout = Math.min(timeout_seconds, 110) * 1000;\n  const quiet = (p) => p.catch(() => ({ event: \"cancelled\" }));\n  const ev = await Promise.race([quiet(ui.wait(yes, { event: \"click\", timeout })), quiet(ui.wait(no, { event: \"click\", timeout }))]);\n  await ui.remove(card);\n  if (ev.event !== \"click\") return { answered: false };\n  return { answered: true, confirmed: ev.id === yes };\n}\n"
  },
  {
    "filename": "bar_chart.js",
    "source": "/**\n * Draw a bar chart on the dashboard (an SVG image). Returns the image's id;\n * call it again with the same id to redraw it with new numbers.\n * @param {string} title The chart's title\n * @param {string[]} labels One label per bar\n * @param {number[]} values One number per bar\n * @param {string} [id] An existing chart to redraw instead of adding a new one\n */\nexport default async function bar_chart(title, labels, values, id) {\n  if (labels.length !== values.length) throw new Error(\"labels and values must have the same length\");\n  const esc = (s) => String(s).replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\").replace(/>/g, \"&gt;\");\n  const W = 560, H = 240, pad = 34, bw = (W - pad * 2) / Math.max(1, values.length);\n  const max = Math.max(1, ...values.map(Math.abs));\n  let bars = \"\";\n  values.forEach((v, i) => {\n    const h = Math.round((Math.abs(v) / max) * (H - pad * 2 - 14));\n    const x = pad + i * bw + bw * 0.15, y = H - pad - h;\n    bars += '<rect x=\"' + x + '\" y=\"' + y + '\" width=\"' + bw * 0.7 + '\" height=\"' + h + '\" fill=\"#111\"/>';\n    bars += '<text x=\"' + (x + bw * 0.35) + '\" y=\"' + (y - 4) + '\" text-anchor=\"middle\" font-size=\"10\">' + esc(v) + '</text>';\n    bars += '<text x=\"' + (x + bw * 0.35) + '\" y=\"' + (H - pad + 14) + '\" text-anchor=\"middle\" font-size=\"10\" fill=\"#666\">' + esc(labels[i]) + '</text>';\n  });\n  const svg = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"' + W + '\" height=\"' + H + '\" font-family=\"JetBrains Mono, monospace\">' +\n    '<rect width=\"100%\" height=\"100%\" fill=\"#fff\"/>' +\n    '<text x=\"' + pad + '\" y=\"20\" font-size=\"12\" font-weight=\"700\">' + esc(title) + '</text>' +\n    '<line x1=\"' + pad + '\" y1=\"' + (H - pad) + '\" x2=\"' + (W - pad) + '\" y2=\"' + (H - pad) + '\" stroke=\"#111\"/>' + bars + '</svg>';\n  const src = \"data:image/svg+xml;base64,\" + btoa(unescape(encodeURIComponent(svg)));\n  if (id) { await ui.update(id, { src, alt: title }); return id; }\n  return await ui.add({ type: \"image\", src, alt: title });\n}\n"
  },
  {
    "filename": "table.js",
    "source": "/**\n * Show rows of data as an aligned table on the dashboard. Returns its id.\n * @param {string[]} columns The column headings\n * @param {array} rows The rows: each an array with one value per column\n * @param {string} [title] A heading above the table\n */\nexport default async function table(columns, rows, title) {\n  const cells = [columns.map(String)].concat(rows.map((r) => columns.map((_, i) => (r[i] === undefined || r[i] === null ? \"\" : String(r[i])))));\n  const widths = columns.map((_, i) => Math.max(...cells.map((r) => r[i].length)));\n  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join(\"  \").trimEnd();\n  const text = [line(cells[0]), widths.map((w) => \"-\".repeat(w)).join(\"  \")].concat(cells.slice(1).map(line)).join(\"\\n\");\n  if (!title) return await ui.add({ type: \"code\", text });\n  const card = await ui.add({ type: \"card\", title });\n  await ui.add({ type: \"code\", text, parent: card });\n  return card;\n}\n"
  },
  {
    "filename": "increment.js",
    "source": "/**\n * Add to the number shown by a text or heading component - an example of an\n * event handler: give a button on: {click: {tool: \"increment\", args: {id: \"c2\"}}}\n * and every click counts up, in the browser. The click itself arrives as 'event'.\n * @param {string} id The text or heading showing the number\n * @param {number} [by=1] How much to add\n */\nexport default async function increment(id, by = 1) {\n  const current = Number((await ui.get(id)).text) || 0;\n  await ui.update(id, { text: String(current + by) });\n  return { value: current + by, clicked_by: event ? event.by : null };\n}\n"
  },
  {
    "filename": "cursor_click.js",
    "source": "/**\n * Move your named cursor to a component and click it (a button presses, a\n * checkbox toggles, a text box gets focus). Returns the component's state.\n * @param {string} id The component to click\n */\nexport default async function cursor_click(id) {\n  return await cursor.click(id);\n}\n"
  },
  {
    "filename": "cursor_type.js",
    "source": "/**\n * Move your named cursor to a text box (input, textarea or editor) and type\n * into it, key by key. With replace=true the box is cleared first.\n * @param {string} id The text box\n * @param {string} text What to type\n * @param {boolean} [replace=false] Clear the box before typing\n */\nexport default async function cursor_type(id, text, replace = false) {\n  if (replace) await cursor.fill(id, \"\");\n  return await cursor.type(id, text);\n}\n"
  }
];

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
    '    <div class="connect-row"><button class="connect" id="connect" type="button">Connect</button><div class="conninfo" id="conninfo"></div></div>',
    '    <section id="dash" hidden>',
    '      <div class="row-head section"><h2>Dash</h2><span class="status" id="clients"></span><span class="status" id="running"></span></div>',
    '      <div class="dash-area" id="dash-area"><div class="dash-empty">Connected. Tools called by MCP clients show their UI here.</div></div>',
    "    </section>",
    '    <details class="gallery" id="gallery">',
    "      <summary>Components</summary>",
    '      <p class="gal-intro">Inside a tool, <code>ui.add({...})</code> returns a component id; <code>ui.update</code>, <code>ui.get</code>, <code>ui.remove</code>, <code>ui.clear</code>, <code>ui.list</code> and <code>ui.wait(id)</code> (the next click or change) work on it. Give a component <code>on: { click: { tool: \'name\', args: {...} } }</code> (or <code>change</code>) and every click or change runs that tool in the browser - it receives the details as <code>event</code>; <code>ui.events({ since, timeout })</code> returns what happened, for agents to react to. <code>cursor.move</code>, <code>click</code>, <code>type</code>, <code>fill</code>, <code>check</code>, <code>select</code> and <code>drag</code> drive this client\'s named cursor. Pass <code>parent</code> to put a component in a row or card. Tools have no network; images are data URLs.</p>',
    '      <div id="gallery-list"></div>',
    "    </details>",
    '    <input id="picker" type="file" accept=".js,.mjs,text/javascript" multiple style="display:none" />',
    "    <script>window.__DEVICE__ = " + JSON.stringify(deviceId).replace(/</g, "\\u003c") + "; window.__STARTERS__ = " + JSON.stringify(STARTER_TOOLS).replace(/</g, "\\u003c") + ";</script>",
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

// ---- WebSocket tickets ----------------------------------------------------------
// "<exp>.<nonce>.<sig>", sig = HMAC-SHA256(device token, "sandbox|id|exp|nonce").
// Short-lived (30 s), bound to the device id, single-use (the DO remembers the
// nonce). Signed with the device's own token: no extra secret to manage, and
// rotating the token invalidates outstanding tickets.
export const TICKET_TTL_MS = 30_000;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ticketSig(deviceId: string, token: string, exp: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("sandbox|" + deviceId + "|" + exp + "|" + nonce));
  return b64url(new Uint8Array(sig));
}

export async function signTicket(deviceId: string, token: string, now = Date.now()): Promise<string> {
  const exp = String(now + TICKET_TTL_MS);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return exp + "." + nonce + "." + (await ticketSig(deviceId, token, exp, nonce));
}

export async function verifyTicket(deviceId: string, ticket: string, token: string, now = Date.now()): Promise<{ nonce: string } | null> {
  const parts = ticket.split(".");
  if (parts.length !== 3 || !/^\d{13}$/.test(parts[0]) || !/^[\w-]{16,64}$/.test(parts[1])) return null;
  const exp = Number(parts[0]);
  if (exp < now || exp > now + TICKET_TTL_MS + 5_000) return null;
  const expected = await ticketSig(deviceId, token, parts[0], parts[1]);
  if (expected.length !== parts[2].length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  return diff === 0 ? { nonce: parts[1] } : null;
}

function basicPassword(request: Request): string | null {
  const h = request.headers.get("authorization") || "";
  if (!/^basic /i.test(h)) return null;
  try {
    const raw = atob(h.slice(6).trim());
    const i = raw.indexOf(":");
    return i < 0 ? null : raw.slice(i + 1);
  } catch {
    return null;
  }
}

function sandboxUnauthorized(base: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...base, "content-type": "application/json; charset=utf-8", "www-authenticate": 'Basic realm="Prime sandbox", charset="UTF-8"' },
  });
}

/** GET/HEAD /mcp (page, runtime frame); POST /mcp?ticket=1 (WebSocket ticket). */
export async function handleSandbox(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "POST" && url.searchParams.has("ticket")) {
    const base = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    // A custom header forces a CORS preflight, so another site cannot make the
    // browser mint a ticket with its remembered Basic credentials.
    if (request.headers.get("x-sandbox") !== "1") return Response.json({ error: "missing x-sandbox header" }, { status: 400, headers: base });
    const auth = await authorizeDevice(env, request);
    const token = basicPassword(request);
    if (auth instanceof Response || !token) return sandboxUnauthorized(base);
    let online = false;
    try {
      const r = await env.DEVICES.get(env.DEVICES.idFromName(auth.deviceId)).fetch("https://device/online");
      online = ((await r.json()) as { online?: boolean }).online === true;
    } catch {}
    const ticket = await signTicket(auth.deviceId, token);
    const wsBase = (url.protocol === "https:" ? "wss://" : "ws://") + url.host;
    return Response.json(
      { device_id: auth.deviceId, online, ticket, ws_url: wsBase + "/ws/" + encodeURIComponent(auth.deviceId) + "?ticket=" + encodeURIComponent(ticket), mcp_url: url.origin + "/mcp/" + encodeURIComponent(auth.deviceId), expires_in_ms: TICKET_TTL_MS },
      { headers: base },
    );
  }
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
  if (auth instanceof Response) return sandboxUnauthorized(base);
  const ws = (url.protocol === "https:" ? "wss://" : "ws://") + url.host;
  return new Response(request.method === "HEAD" ? null : renderSandboxPage(auth.deviceId), {
    headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP + "; connect-src 'self' " + ws + "; worker-src blob:" },
  });
}
