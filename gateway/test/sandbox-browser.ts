import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// End-to-end: the Sandbox page (GET /mcp) in Chromium, driven by real MCP
// clients (the official SDK) through a local gateway - or, with BASE=<url>,
// a deployed one whose device demo/demo is registered.
//   bun test/sandbox-browser.ts
const R = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandbox-browser-"));
const LOCAL = !process.env.BASE;
const PORT = 8872, B = process.env.BASE || "http://127.0.0.1:" + PORT;
const ID = "demo", TOKEN = "demo";
let w = null;
if (LOCAL) {
  rmSync(R + "/.wrangler/state-" + PORT, { recursive: true, force: true });
  w = spawn("node", [R + "/node_modules/wrangler/bin/wrangler.js", "dev", "--local", "-c", R + "/wrangler.dev.toml", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", R + "/.wrangler/state-" + PORT, "--var", "RATE_LIMIT_MAX:100000"], { cwd: R, stdio: "ignore" });
}
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };
const auth = "Basic " + btoa(ID + ":" + TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A deployed gateway allows 100 requests a minute per IP: stay under it there.
const recent = [];
async function throttle() {
  if (LOCAL) return;
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 61000) recent.shift();
    if (recent.length < 80) { recent.push(now); return; }
    await sleep(61000 - (now - recent[0]));
  }
}
const throttledFetch = async (url, init) => { await throttle(); return fetch(url, init); };
async function mcpClient(name) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(B + "/mcp/" + ID), { fetch: throttledFetch, requestInit: { headers: { "x-device-token": TOKEN } } }));
  return client;
}
const text = (r) => (r.content || []).map((c) => c.text).join("");
function openWs(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    const t = setTimeout(() => resolve({ ws, ok: false, why: "timeout" }), 8000);
    ws.onmessage = (e) => { if (String(e.data).includes("registered")) { clearTimeout(t); resolve({ ws, ok: true }); } };
    ws.onerror = (e) => { clearTimeout(t); resolve({ ws, ok: false, why: e.message || "error" }); };
  });
}
try {
  if (LOCAL) {
    for (let i = 0; i < 600; i++) { try { await fetch(B + "/"); break; } catch { await sleep(500); } }
    const reg = await fetch(B + "/admin/api/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: ID, token: TOKEN }) });
    ok(reg.ok, "registered " + ID);
  }
  // ---- tickets ----
  ok((await fetch(B + "/mcp?ticket=1", { method: "POST", headers: { authorization: auth } })).status === 400, "ticket without x-sandbox header -> 400");
  ok((await fetch(B + "/mcp?ticket=1", { method: "POST", headers: { "x-sandbox": "1" } })).status === 401, "ticket without credentials -> 401");
  const tr = await fetch(B + "/mcp?ticket=1", { method: "POST", headers: { authorization: auth, "x-sandbox": "1" } });
  const tj = await tr.json();
  ok(tr.status === 200 && tj.ws_url.includes("ticket=") && !tj.ws_url.includes("token=") && tj.online === false, "ticket issued; the WS URL holds the ticket, not the token");
  const first = await openWs(tj.ws_url);
  ok(first.ok, "the ticket opens the tunnel");
  first.ws.close(); await sleep(1500);
  const replay = await openWs(tj.ws_url);
  ok(!replay.ok, "the same ticket a second time is refused (" + replay.why + ")");
  const tampered = await openWs(tj.ws_url.replace(/.(?=$)/, (c) => (c === "A" ? "B" : "A")));
  ok(!tampered.ok, "a tampered ticket is refused");
  const tj2 = await (await fetch(B + "/mcp?ticket=1", { method: "POST", headers: { authorization: auth, "x-sandbox": "1" } })).json();
  const other = await openWs(tj2.ws_url.replace("/ws/" + ID, "/ws/someone-else"));
  ok(!other.ok, "a ticket for " + ID + " does not open another device");
  await sleep(1500);

  // ---- the page ----
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ httpCredentials: { username: ID, password: TOKEN }, viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  let nativeDialogs = 0;
  page.on("dialog", (d) => { nativeDialogs++; d.dismiss(); });
  await page.goto(B + "/mcp", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__sandbox.tools().length >= 12, null, { timeout: 15000 });
  const starterNames = await page.evaluate(() => window.__sandbox.tools().map((t) => t.name));
  ok(starterNames.includes("bar_chart") && starterNames.includes("ask_user") && starterNames.includes("dashboard_add"), "first visit: starter tools added (" + starterNames.length + ")");
  // the user can delete starters, and they do not come back
  const firstRow = page.locator("#list li.row").first();
  await firstRow.locator(".menu-btn").click(); await firstRow.locator(".menu button", { hasText: "Delete" }).click();
  await page.waitForSelector(".dlg-confirm");
  await page.click(".dlg-confirm .btn.secondary");
  ok((await page.evaluate(() => window.__sandbox.tools().length)) === starterNames.length && !(await page.isVisible(".dlg-confirm")), "Delete asks in the page's own dialog; Cancel keeps the tool");
  await firstRow.locator(".menu-btn").click(); await firstRow.locator(".menu button", { hasText: "Delete" }).click();
  await page.click(".dlg-confirm .btn.danger");
  await page.reload({ waitUntil: "networkidle" }); await sleep(800);
  ok((await page.evaluate(() => window.__sandbox.tools().length)) === starterNames.length - 1, "a deleted starter stays deleted after reload");
  await page.evaluate(() => { localStorage.removeItem("code-mcp.sandbox.tools.demo"); });
  await page.reload({ waitUntil: "networkidle" }); await sleep(800);
  ok((await page.evaluate(() => window.__sandbox.tools().length)) === 0, "deleting every tool does not bring the starters back");
  await page.evaluate(() => { localStorage.removeItem("code-mcp.sandbox.seeded.demo"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__sandbox.tools().length >= 12);

  const custom = {
    "add.js": "/**\n * Add two numbers.\n * @param {number} a First\n * @param {number} [b=1] Second\n */\nexport default async function add(a, b = 1) {\n  console.log('adding', a, b);\n  return a + b;\n}\n",
    "boom.js": "/**\n * Always fails.\n */\nexport default async function boom() {\n  throw new Error('kaboom');\n}\n",
    "exfil.js": "/**\n * Tries the network.\n */\nexport default async function exfil() {\n  const r = await fetch('https://example.com/');\n  return r.status;\n}\n",
    "peek.js": "/**\n * Tries the page's storage.\n */\nexport default async function peek() {\n  return localStorage.getItem('code-mcp.sandbox.tools.demo');\n}\n",
    "pick.js": "/**\n * Pick an option with the cursor.\n * @param {string} id The select\n * @param {string} value The option\n */\nexport default async function pick(id, value) {\n  return await cursor.select(id, value);\n}\n",
    "big.js": "/**\n * Stores a value over 1 MB.\n */\nexport default async function big() {\n  return await kv.set('big', 'x'.repeat(1100000));\n}\n",
    "idb.js": "/**\n * Tries to open IndexedDB itself.\n */\nexport default async function idb() {\n  return await new Promise((res, rej) => { const r = indexedDB.open('x'); r.onsuccess = () => res('opened'); r.onerror = () => rej(r.error); });\n}\n",
    "press.js": "/**\n * Press a key with the cursor.\n * @param {string} id The component\n * @param {string} key The key\n */\nexport default async function press(id, key) {\n  return await cursor.press(id, key);\n}\n",
    "slow.js": "/**\n * Works for a while.\n * @param {number} ms How long\n */\nexport default async function slow(ms) {\n  await ui.list();\n  await new Promise((r) => setTimeout(r, ms));\n  return 'done';\n}\n",
    "slide.js": "/**\n * Drag a slider with the cursor.\n * @param {string} id The slider\n * @param {number} to The value\n */\nexport default async function slide(id, to) {\n  return await cursor.drag(id, to);\n}\n",
  };
  for (const [n, s] of Object.entries(custom)) {
    writeFileSync(join(TMP, n), s);
    await page.click("#addBtn"); await page.setInputFiles("#picker", join(TMP, n));
    await page.waitForFunction((n) => document.getElementById("list").textContent.includes(n), n);
    const last = page.locator("#list li.row").last();
    await last.locator(".menu-btn").click(); await last.locator(".menu button", { hasText: "Save" }).click();
    await sleep(300);
  }
  const TOTAL = starterNames.length + 10;
  ok((await page.evaluate(() => window.__sandbox.tools().length)) === TOTAL, "custom tools saved (" + TOTAL + " in total)");

  // ---- connect ----
  await page.click("#connect");
  await page.waitForFunction(() => window.__sandbox.state() === "connected", null, { timeout: 20000 });
  ok(await page.isVisible("#dash") && (await page.textContent("#connect")) === "Disconnect", "Connect: connected, dash shown, button says Disconnect");
  ok(await page.isDisabled("#addBtn"), "while connected, + is disabled");
  const fav = await page.getAttribute("#favicon", "href");
  ok(fav.includes("%2316a34a") && !fav.includes("%23111111") && (await page.title()).startsWith("\u25cf"), "connected: the tab icon turns green (and the title gets a dot)");
  ok((await page.locator("#clients").count()) === 0, "no 'clients:' list in the dash header");
  const lr = page.locator("#list li.row").first(); await lr.locator(".menu-btn").click();
  ok(await lr.locator(".menu button", { hasText: "Delete" }).isDisabled(), "while connected, Delete is disabled");
  await page.keyboard.press("Escape"); await page.click("h1");

  // ---- MCP clients ----
  const raw = await fetch(B + "/mcp/" + ID, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-device-token": TOKEN }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }) });
  ok(raw.status === 200 && /^[0-9a-f-]{36}$/.test(raw.headers.get("mcp-session-id") || ""), "initialize through the gateway returns an Mcp-Session-Id");
  const alpha = await mcpClient("agent-alpha");
  const beta = await mcpClient("agent-beta");
  const listed = (await alpha.listTools()).tools.map((t) => t.name);
  ok(JSON.stringify(listed) === JSON.stringify(["search", "call"]), "tools/list: exactly search and call");
  const found = JSON.parse(text(await alpha.callTool({ name: "search", arguments: { query: "chart" } })));
  ok(found.tools[0].name === "bar_chart" && found.tools[0].inputSchema.required.includes("values"), "search 'chart' -> bar_chart with its schema");
  const all = JSON.parse(text(await alpha.callTool({ name: "search", arguments: {} })));
  ok(all.total === TOTAL, "search with no query lists all " + TOTAL + " active tools");
  const sum = await alpha.callTool({ name: "call", arguments: { name: "add", arguments: { a: 2, b: 3 } } });
  ok(text(sum).startsWith("5") && text(sum).includes("adding 2 3") && !sum.isError, "call add(2,3) -> 5, with console output");
  ok(text(await alpha.callTool({ name: "call", arguments: { name: "add", arguments: { a: 2 } } })).startsWith("3"), "the default for an optional argument applies");
  const bad = await alpha.callTool({ name: "call", arguments: { name: "add", arguments: { a: "x", c: 1 } } });
  ok(bad.isError && text(bad).includes("unknown argument 'c'") && text(bad).includes("'a' must be number"), "invalid arguments are refused with reasons");
  const missing = await alpha.callTool({ name: "call", arguments: { name: "nope" } });
  ok(missing.isError && text(missing).includes("no active tool"), "unknown tool -> error pointing to search");
  const boom = await alpha.callTool({ name: "call", arguments: { name: "boom" } });
  ok(boom.isError && text(boom).includes("kaboom"), "a throwing tool -> isError with its message");
  const exfil = await alpha.callTool({ name: "call", arguments: { name: "exfil" } });
  ok(exfil.isError, "a tool cannot reach the network: " + text(exfil).slice(0, 80));
  const peek = await alpha.callTool({ name: "call", arguments: { name: "peek" } });
  ok(peek.isError && !text(peek).includes("source"), "a tool cannot read the page's storage: " + text(peek).slice(0, 80));

  // ---- dashboard building with the starters ----
  const call = (c, name, args) => c.callTool({ name: "call", arguments: { name, arguments: args } });
  const card = text(await call(alpha, "dashboard_add", { spec: { type: "card", title: "Deploy" } }));
  await call(alpha, "dashboard_add", { spec: { type: "status", text: "idle", state: "pending", parent: card } });
  const box = text(await call(alpha, "dashboard_add", { spec: { type: "input", label: "Release name", parent: card } }));
  const go = text(await call(alpha, "dashboard_add", { spec: { type: "button", label: "Ship it", parent: card } }));
  const typed = await call(alpha, "cursor_type", { id: box, text: "v2.0 rocket" });
  ok(JSON.parse(text(typed)).value === "v2.0 rocket" && (await page.inputValue('[data-cid="' + box + '"] input')) === "v2.0 rocket", "cursor_type types into the box (seen in the page)");
  const names = await page.$$eval(".cur:not(.me) .cur-label", (els) => els.map((e) => e.textContent));
  ok(names.includes("agent-alpha"), "a cursor labelled agent-alpha is in the dash");
  // beta waits for a click on the button, alpha clicks it
  const waitClick = beta.callTool({ name: "call", arguments: { name: "dashboard_list", arguments: {} } });
  ok(JSON.parse(text(await waitClick)).some((c) => c.id === box && c.value === "v2.0 rocket"), "another client sees the same dash and the typed value");
  await call(beta, "cursor_click", { id: go });
  const names2 = await page.$$eval(".cur:not(.me) .cur-label", (els) => els.map((e) => e.textContent));
  ok(names2.includes("agent-alpha") && names2.includes("agent-beta") && names2.length === 2, "two clients, two named cursors: " + names2.join(", "));
  const colors = await page.$$eval(".cur:not(.me) .cur-name", (els) => els.map((e) => e.style.background));
  ok(new Set(colors).size === 2, "each cursor has its own colour");
  const chart = text(await call(alpha, "bar_chart", { title: "Requests / day", labels: ["Mon", "Tue", "Wed", "Thu", "Fri"], values: [12, 30, 22, 41, 18] }));
  ok(/^c\d+$/.test(chart) && (await page.locator('[data-cid="' + chart + '"] img').count()) === 1, "bar_chart draws an image");
  ok(text(await call(alpha, "bar_chart", { title: "Requests / day", labels: ["Mon"], values: [5], id: chart })) === chart, "bar_chart redraws in place by id");
  await call(beta, "table", { title: "Builds", columns: ["id", "status", "time"], rows: [[101, "ok", "2m"], [102, "failed", "5m"]] });
  ok((await page.textContent("#dash-area")).includes("failed"), "table renders");

  // ---- drawn controls: no native select / checkbox / range anywhere ----
  const sel = text(await call(alpha, "dashboard_add", { spec: { type: "select", label: "Region", options: ["sgp", "fra", "iad"], value: "fra" } }));
  const chk = text(await call(alpha, "dashboard_add", { spec: { type: "checkbox", label: "Canary" } }));
  const sld = text(await call(alpha, "dashboard_add", { spec: { type: "slider", label: "Replicas", min: 0, max: 10, value: 2 } }));
  await page.click("#gallery summary");
  const natives = await page.locator("select, option, input[type=checkbox], input[type=radio], input[type=range]").count();
  ok(natives === 0, "no native select, checkbox or range in the dash or the Components section (" + natives + ")");
  await page.click("#gallery summary");
  // the person opens the drawn select and picks with the mouse, then with the keyboard
  await page.click('[data-cid="' + sel + '"] .usel');
  ok(await page.isVisible(".usel-list") && (await page.locator(".usel-item").count()) === 3, "the select opens its own list");
  await page.click(".usel-item:has-text('iad')");
  const afterPick = JSON.parse(text(await call(beta, "dashboard_list", {})));
  ok(afterPick.find((c) => c.id === sel).value === "iad" && !(await page.isVisible(".usel-list")), "picking with the mouse sets the value and closes the list");
  await page.focus('[data-cid="' + sel + '"] .usel');
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Home"); await page.keyboard.press("Enter");
  ok(JSON.parse(text(await call(beta, "dashboard_list", {}))).find((c) => c.id === sel).value === "sgp", "keyboard: ArrowDown opens, Home + Enter picks the first option");
  const picked = JSON.parse(text(await call(beta, "pick", { id: sel, value: "fra" })));
  ok(picked.value === "fra" && (await page.textContent('[data-cid="' + sel + '"] .usel-value')) === "fra", "cursor.select opens the list and picks (agent-beta)");
  await page.click('[data-cid="' + chk + '"] .ucheck');
  ok(JSON.parse(text(await call(beta, "dashboard_list", {}))).find((c) => c.id === chk).checked === true, "the drawn checkbox toggles on click");
  await page.focus('[data-cid="' + chk + '"] .ucheck'); await page.keyboard.press(" ");
  ok(JSON.parse(text(await call(beta, "dashboard_list", {}))).find((c) => c.id === chk).checked === false, "and with the space bar");
  const track = await page.locator('[data-cid="' + sld + '"] .uslide-track').boundingBox();
  await page.mouse.move(track.x + track.width * 0.2, track.y + 1); await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.8, track.y + 1, { steps: 6 }); await page.mouse.up();
  ok(JSON.parse(text(await call(beta, "dashboard_list", {}))).find((c) => c.id === sld).value === "8", "dragging the drawn slider with the mouse -> 8");
  await page.focus('[data-cid="' + sld + '"] .uslide'); await page.keyboard.press("ArrowLeft");
  ok((await page.textContent('[data-cid="' + sld + '"] .uslide-value')) === "7", "keyboard arrows step it -> 7");
  ok(JSON.parse(text(await call(alpha, "slide", { id: sld, to: 3 }))).value === "3", "cursor.drag moves the slider (agent-alpha)");

  // ---- event handlers: components stay interactive after the call ----
  const counter = text(await call(alpha, "dashboard_add", { spec: { type: "heading", text: "0" } }));
  const plus = text(await call(alpha, "dashboard_add", { spec: { type: "button", label: "+1", on: { click: { tool: "increment", args: { id: counter } } } } }));
  const plus5 = text(await call(alpha, "dashboard_add", { spec: { type: "button", label: "+5", on: { click: { tool: "increment", args: { id: counter, by: 5 } } } } }));
  const badOn = await call(alpha, "dashboard_add", { spec: { type: "button", label: "x", on: { click: { tool: "nope" } } } });
  ok(badOn.isError && text(badOn).includes("no active tool named 'nope'"), "a handler naming an unknown tool is refused at ui.add");
  const badArgs = await call(alpha, "dashboard_add", { spec: { type: "button", label: "x", on: { click: { tool: "increment", args: { by: 1 } } } } });
  ok(badArgs.isError && text(badArgs).includes("missing required argument 'id'"), "handler arguments are checked at ui.add");
  await page.click('[data-cid="' + plus + '"] .ubtn');
  await page.waitForFunction((id) => document.querySelector('[data-cid="' + id + '"]').textContent === "1", counter);
  await page.click('[data-cid="' + plus + '"] .ubtn');
  await page.waitForFunction((id) => document.querySelector('[data-cid="' + id + '"]').textContent === "2", counter);
  ok(true, "clicking +1 twice (no tool call running) -> the heading counts 1, 2");
  await call(beta, "cursor_click", { id: plus5 });
  await page.waitForFunction((id) => document.querySelector('[data-cid="' + id + '"]').textContent === "7", counter, { timeout: 10000 });
  ok(true, "an agent's cursor click runs the handler too -> 7");
  const evs = JSON.parse(text(await call(beta, "dashboard_events", {})));
  const clicks = evs.events.filter((e) => e.id === plus || e.id === plus5);
  ok(clicks.length === 3 && clicks[0].by === "user" && clicks[2].by === "agent-beta" && clicks.every((e) => e.handler === "increment"), "dashboard_events lists the clicks, who made them, and the handler they ran");
  const waiting = call(beta, "dashboard_events", { since: evs.next, timeout_seconds: 20 });
  await sleep(500);
  await page.click('[data-cid="' + plus + '"] .ubtn');
  const woke = JSON.parse(text(await waiting));
  ok(woke.events.length >= 1 && woke.events[0].id === plus && woke.events[0].seq > evs.next, "dashboard_events with a timeout waits for the next event");

  // ---- cursors move like a hand, and show a spinner while working ----
  const curOf = (name) => page.evaluate((n) => { const c = [...document.querySelectorAll(".cur:not(.me)")].find((e) => e.querySelector(".cur-label").textContent === n); return c ? c.style.transform : null; }, name);
  const far = text(await call(alpha, "dashboard_add", { spec: { type: "button", label: "Far away" } }));
  await sleep(1200);
  const samples = new Set();
  const moving = call(alpha, "cursor_click", { id: plus });
  for (let i = 0; i < 25; i++) { samples.add(await curOf("agent-alpha")); await sleep(25); }
  await moving;
  ok(samples.size >= 6, "a cursor glides through intermediate positions (" + samples.size + " samples), not a jump");
  const before = await curOf("agent-beta");
  await call(beta, "dashboard_add", { spec: { type: "status", text: "added by beta", state: "on" } });
  await sleep(1200);
  ok((await curOf("agent-beta")) !== before, "adding a component moves the client's cursor to it");
  const spinning = call(beta, "slow", { ms: 2500 });
  await sleep(800);
  const busy = await page.evaluate(() => [...document.querySelectorAll(".cur.busy .cur-label")].map((e) => e.textContent));
  ok(busy.includes("agent-beta") && !busy.includes("agent-alpha"), "a spinner shows beside agent-beta's name while its call works: " + busy.join(","));
  await spinning; await sleep(200);
  ok((await page.locator(".cur.busy").count()) === 0, "and goes when the call ends");
  const waitingCall = call(beta, "confirm", { message: "Waiting is not working" });
  await page.waitForSelector(".uc-card .ubtn:has-text('Yes')"); await sleep(400);
  ok((await page.locator(".cur.busy").count()) === 0, "a call that only waits for the person shows no spinner");
  await page.click(".uc-card .ubtn:has-text('Yes')"); await waitingCall;
  // idle cursors fade away, and come back with the next action
  await page.waitForFunction(() => document.querySelectorAll(".cur:not(.me)").length === 0, null, { timeout: 16000 }).then(() => ok(true, "after 10 s without activity the clients' cursors fade away")).catch(async () => ok(false, "idle cursors fade away: " + (await page.locator(".cur:not(.me)").count()) + " left"));
  const longPoll = call(beta, "dashboard_events", { since: 1e9, timeout_seconds: 14 });
  await sleep(12000);
  ok((await page.locator(".cur:not(.me)").count()) === 0, "a long-poll for events does not bring a cursor back or keep it");
  await longPoll;
  await call(alpha, "cursor_click", { id: plus });
  ok((await page.$$eval(".cur:not(.me) .cur-label", (els) => els.map((e) => e.textContent))).join() === "agent-alpha", "the next action brings the client's cursor back");
  ok(!/running/.test(await page.textContent("#dash")), "no 'call running' text");
  // the person's own cursor
  await page.locator("#dash-area").scrollIntoViewIfNeeded();
  const area = await page.locator("#dash-area").boundingBox();
  await page.mouse.move(area.x + 200, area.y + 60);
  await sleep(100);
  const meBox = await page.locator(".cur.me").boundingBox();
  ok(meBox && Math.abs(meBox.x - (area.x + 200)) < 3 && Math.abs(meBox.y - (area.y + 60)) < 3 && (await page.textContent(".cur.me .cur-label")) === "you", "the person's pointer in the dash is drawn and labelled 'you' " + JSON.stringify({ area, meBox, t: await page.evaluate(() => document.querySelector(".cur.me") && document.querySelector(".cur.me").style.transform) }));
  await page.evaluate(() => { document.getElementById("dash-area").scrollTop += 40; });
  await sleep(100);
  const meBox2 = await page.locator(".cur.me").boundingBox();
  ok(Math.abs(meBox2.y - (area.y + 60)) < 3, "when the dash scrolls under a still pointer, 'you' stays with the real pointer");
  await page.mouse.move(area.x - 50, area.y - 50); await sleep(100);
  ok(!(await page.isVisible(".cur.me")), "and hidden when the pointer leaves the dash");

  // ---- expand the dash to the whole page, and back ----
  await page.click("#dashSize");
  const vp = page.viewportSize();
  const full = await page.locator("#dash").boundingBox();
  ok((await page.getAttribute("#dash", "class")).includes("full") && full.width >= vp.width - 2 && full.height >= vp.height - 2 && (await page.getAttribute("#dashSize", "title")) === "Collapse", "Expand: the dash fills the page, and the button becomes Collapse");
  ok(JSON.parse(text(await call(alpha, "cursor_click", { id: plus }))).id === plus, "tools still work in the expanded dash");
  await page.screenshot({ path: process.env.SCREENSHOT_FULL || "/tmp/sbx-full.png" });
  await page.keyboard.press("Escape");
  ok(!(await page.getAttribute("#dash", "class") || "").includes("full") && (await page.getAttribute("#dashSize", "title")) === "Expand", "Escape collapses it");
  await page.click("#dashSize"); await page.click("#dashSize");
  ok(!(await page.getAttribute("#dash", "class") || "").includes("full"), "the Collapse button collapses it");

  // ---- more components: toggle, radio, progress ----
  const tog = text(await call(alpha, "dashboard_add", { spec: { type: "toggle", label: "Maintenance" } }));
  const rad = text(await call(alpha, "dashboard_add", { spec: { type: "radio", label: "Plan", options: ["Free", "Pro", "Team"], value: "Free", direction: "row" } }));
  const prog = text(await call(alpha, "dashboard_add", { spec: { type: "progress", label: "Deploy", value: 10 } }));
  await page.click('[data-cid="' + tog + '"] .utoggle');
  await page.click('[data-cid="' + rad + '"] .uradio-opt:has-text("Team")');
  let st = JSON.parse(text(await call(beta, "dashboard_list", {})));
  ok(st.find((c) => c.id === tog).checked === true && st.find((c) => c.id === rad).value === "Team", "the drawn toggle and radio respond to clicks");
  ok(JSON.parse(text(await call(beta, "pick", { id: rad, value: "Pro" }))).value === "Pro", "cursor.select picks a radio option");
  await call(alpha, "dashboard_update", { id: prog, props: { value: 80 } });
  ok((await page.getAttribute('[data-cid="' + prog + '"] .uprog-fill', "style")).includes("80%") && (await page.textContent('[data-cid="' + prog + '"] .uprog-text')) === "80%", "progress updates to 80%");
  const natives2 = await page.locator("#dash-area select, #dash-area input[type=checkbox], #dash-area input[type=radio], #dash-area input[type=range]").count();
  ok(natives2 === 0, "still no native controls");

  // ---- drag and drop: a kanban board ----
  const board = JSON.parse(text(await call(alpha, "kanban", { columns: ["To do", "Doing", "Done"], tasks: ["Write docs", "Fix bug", "Ship"] })));
  const [tDocs, tBug, tShip] = board.tasks;
  const src = await page.locator('[data-cid="' + tDocs + '"]').boundingBox();
  const dst = await page.locator('[data-cid="' + board.columns["Done"] + '"] .uc-body').boundingBox();
  await page.mouse.move(src.x + 20, src.y + src.height / 2); await page.mouse.down();
  await page.mouse.move(src.x + 60, src.y + 40, { steps: 4 });
  ok(await page.isVisible(".drop-line"), "while dragging, a drop line shows where it will land");
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 8 }); await page.mouse.up();
  st = JSON.parse(text(await call(beta, "dashboard_list", {})));
  ok(st.find((c) => c.id === tDocs).parent === board.columns["Done"], "the person drags 'Write docs' into Done");
  const dropEv = JSON.parse(text(await call(beta, "dashboard_events", {}))).events.filter((e) => e.event === "drop").pop();
  ok(dropEv && dropEv.id === tDocs && dropEv.by === "user" && dropEv.parent === board.columns["Done"], "a drop event says who moved what where");
  await call(beta, "cursor_drag", { id: tBug, target: board.columns["Doing"] });
  st = JSON.parse(text(await call(beta, "dashboard_list", {})));
  ok(st.find((c) => c.id === tBug).parent === board.columns["Doing"], "an agent's cursor drags 'Fix bug' into Doing");
  await call(alpha, "cursor_drag", { id: tShip, target: tDocs, position: "after" });
  st = JSON.parse(text(await call(beta, "dashboard_list", {})));
  const doneOrder = st.filter((c) => c.parent === board.columns["Done"]).map((c) => c.id);
  ok(JSON.stringify(doneOrder) === JSON.stringify([tDocs, tShip]), "cursor_drag with position 'after' -> Done holds Write docs, Ship (list is in page order)");
  await page.waitForFunction((id) => document.querySelector('[data-cid="' + id + '"] .uprog-text').textContent === "2 / 3", board.progress, { timeout: 10000 }).catch(() => {});
  ok((await page.textContent('[data-cid="' + board.progress + '"] .uprog-text')) === "2 / 3" && (await page.textContent('[data-cid="' + board.status + '"]')).includes("0 to do \u00b7 1 doing \u00b7 2 done"), "the board's progress followed every move by itself: " + (await page.textContent('[data-cid="' + board.progress + '"] .uprog-text')) + ", " + (await page.textContent('[data-cid="' + board.status + '"]')));
  // a person drags 'Fix bug' to Done: progress updates with no tool call running
  const fb = await page.locator('[data-cid="' + tBug + '"]').boundingBox();
  const dn = await page.locator('[data-cid="' + board.columns["Done"] + '"] .uc-body').boundingBox();
  await page.mouse.move(fb.x + 20, fb.y + fb.height / 2); await page.mouse.down();
  await page.mouse.move(fb.x + 60, fb.y + 30, { steps: 4 }); await page.mouse.move(dn.x + dn.width / 2, dn.y + dn.height - 4, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction((id) => document.querySelector('[data-cid="' + id + '"] .uprog-text').textContent === "3 / 3", board.progress, { timeout: 10000 }).catch(() => {});
  ok((await page.textContent('[data-cid="' + board.progress + '"] .uprog-text')) === "3 / 3" && (await page.getAttribute('[data-cid="' + board.progress + '"] .uprog-fill', "style")).includes("100%"), "a person's drag to Done updates the progress bar to 3 / 3 (100%) in the browser");

  // ---- a whole app: modal, drawer, tabs, table, list, accordion, stats, toast ----
  const appIds = JSON.parse(text(await call(alpha, "example_app", {})));
  await sleep(300);
  ok(await page.isVisible(".utoast:has-text('Example app ready')"), "example_app builds, with a toast");
  ok(!(await page.isVisible('[data-cid="' + appIds.about + '"] .umodal-panel')) && !(await page.isVisible('[data-cid="' + appIds.nav + '"] .udrawer-panel')), "the modal and the drawer start closed");
  await page.click("#dash-area .ubtn:has-text('About')");
  await page.waitForSelector('[data-cid="' + appIds.about + '"] .umodal-panel', { state: "visible", timeout: 10000 });
  await sleep(300);
  ok(true, "the About button opens the modal (a dashboard_update handler, in the browser)");
  const modalBox = await page.locator('[data-cid="' + appIds.about + '"] .umodal-panel').boundingBox();
  const dashBox = await page.locator("#dash-area").boundingBox();
  ok(modalBox.x > dashBox.x && modalBox.x + modalBox.width < dashBox.x + dashBox.width && modalBox.y > dashBox.y && modalBox.y + modalBox.height < dashBox.y + dashBox.height, "the modal sits over the dash, centred in its visible area");
  const xBox = await page.locator('[data-cid="' + appIds.about + '"] .dlg-close').boundingBox();
  ok(Math.abs(modalBox.x + modalBox.width - (xBox.x + xBox.width)) < 24, "the modal's close button sits at the right of its header");
  if (process.env.SCREENSHOT_MODAL) await page.screenshot({ path: process.env.SCREENSHOT_MODAL });
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-cid="' + appIds.about + '"] .umodal-panel', { state: "hidden" });
  let appEvs = JSON.parse(text(await call(beta, "dashboard_events", {}))).events;
  ok(appEvs.some((e) => e.id === appIds.about && e.event === "close" && e.by === "user"), "Esc closes it, with a 'close' event");
  await page.click("#dash-area .ubtn:has-text('Menu')");
  await page.waitForSelector('[data-cid="' + appIds.nav + '"] .udrawer-panel', { state: "visible", timeout: 10000 });
  await sleep(400);
  const dashBox2 = await page.locator("#dash-area").boundingBox();
  const drawerBox = await page.locator('[data-cid="' + appIds.nav + '"] .udrawer-panel').boundingBox();
  ok(Math.abs(drawerBox.x - dashBox2.x - 1) < 3, "Menu opens the drawer on the left edge of the dash " + JSON.stringify({ drawer: drawerBox, dash: dashBox2 }));
  if (process.env.SCREENSHOT_DRAWER) await page.screenshot({ path: process.env.SCREENSHOT_DRAWER });
  await page.click('[data-cid="' + appIds.navList + '"] .ulist-item:has-text("Deploys")');
  appEvs = JSON.parse(text(await call(beta, "dashboard_events", {}))).events;
  ok(appEvs.some((e) => e.id === appIds.navList && e.event === "click" && e.value === "deploys"), "clicking a list item: a 'click' event with its value");
  await page.mouse.click(dashBox2.x + dashBox2.width - 30, dashBox2.y + 200);
  await page.waitForSelector('[data-cid="' + appIds.nav + '"] .udrawer-panel', { state: "hidden" });
  ok(true, "a click outside the drawer closes it");
  ok(await page.isVisible('[data-cid="' + appIds.table + '"]') && !(await page.isVisible('[data-cid="' + appIds.tabs + '"] .uc-code')), "tabs: Deploys shows the table, Logs is hidden");
  await page.click('[data-cid="' + appIds.tabs + '"] .utab:has-text("Logs")');
  ok(await page.isVisible('[data-cid="' + appIds.tabs + '"] .uc-code') && !(await page.isVisible('[data-cid="' + appIds.table + '"]')), "clicking Logs switches the tab");
  await call(beta, "pick", { id: appIds.tabs, value: "Deploys" });
  ok(await page.isVisible('[data-cid="' + appIds.table + '"]'), "cursor.select switches tabs back (agent-beta)");
  const firstCol = async () => page.$$eval('[data-cid="' + appIds.table + '"] tbody tr td:first-child', (els) => els.map((e) => e.textContent).join(","));
  ok((await firstCol()) === "104,103,102", "the table renders its rows");
  await page.click('[data-cid="' + appIds.table + '"] th:has-text("Duration")');
  ok((await firstCol()) === "102,104,103", "clicking a header sorts by it, numerically");
  await page.click('[data-cid="' + appIds.table + '"] th:has-text("Duration")');
  ok((await firstCol()) === "103,104,102", "clicking again sorts descending");
  await page.click('[data-cid="' + appIds.table + '"] tbody tr:has-text("web")');
  appEvs = JSON.parse(text(await call(beta, "dashboard_events", {}))).events;
  const selEv = appEvs.filter((e) => e.id === appIds.table && e.event === "select").pop();
  ok(selEv && selEv.index === 1 && selEv.row.service === "web" && selEv.by === "user", "clicking a row: a 'select' event with its index and row");
  const picked2 = JSON.parse(text(await call(alpha, "pick", { id: appIds.table, value: "2" })));
  ok(picked2.value === 2 && picked2.selected.service === "jobs", "cursor.select picks a table row (agent-alpha)");
  await call(alpha, "dashboard_update", { id: appIds.table, props: { rows: [{ id: 105, service: "api", status: "ok", ms: 9 }] } });
  ok((await firstCol()) === "105", "ui.update replaces the rows");
  ok(!(await page.isVisible('[data-cid="' + appIds.more + '"] .utoggle')), "the accordion starts closed");
  await page.click('[data-cid="' + appIds.more + '"] .uacc-head');
  ok(await page.isVisible('[data-cid="' + appIds.more + '"] .utoggle'), "clicking its header opens it (a 'toggle' event)");
  await call(alpha, "dashboard_update", { id: appIds.stats, props: { hidden: true } });
  ok(!(await page.isVisible('[data-cid="' + appIds.stats + '"]')), "hidden: true hides any component");
  await call(alpha, "dashboard_update", { id: appIds.stats, props: { hidden: false, columns: 2 } });
  ok(await page.isVisible('[data-cid="' + appIds.stats + '"]') && (await page.getAttribute('[data-cid="' + appIds.stats + '"]', "style")).includes("repeat(2"), "and back; grid columns change in place");
  const natives3 = await page.locator("#dash-area select, #dash-area input[type=checkbox], #dash-area input[type=radio], #dash-area input[type=range], #dash-area dialog").count();
  ok(natives3 === 0, "the app uses no native controls");

  // ---- double click and key presses ----
  const dcount = text(await call(alpha, "dashboard_add", { spec: { type: "heading", text: "0" } }));
  await call(alpha, "dashboard_add", { spec: { type: "text", text: "double-click me", on: { dblclick: { tool: "increment", args: { id: dcount } } } } });
  await page.dblclick("#dash-area .uc-text:has-text('double-click me')");
  await page.waitForFunction((id) => document.querySelector('[data-cid="' + id + '"]').textContent === "1", dcount, { timeout: 10000 });
  ok(true, "a dblclick handler runs on a double-click");
  const field = text(await call(alpha, "dashboard_add", { spec: { type: "input", label: "Search" } }));
  await call(alpha, "cursor_type", { id: field, text: "abc" });
  const sinceKey = JSON.parse(text(await call(beta, "dashboard_events", {}))).latest;
  await call(alpha, "press", { id: field, key: "Backspace" });
  await call(alpha, "press", { id: field, key: "Enter" });
  const keyEvs = JSON.parse(text(await call(beta, "dashboard_events", { since: sinceKey }))).events;
  ok((await page.inputValue('[data-cid="' + field + '"] input')) === "ab" && keyEvs.some((e) => e.id === field && e.event === "change" && e.value === "ab" && e.by === "agent-alpha"), "cursor.press: Backspace edits, Enter submits (a change by agent-alpha)");
  await call(alpha, "press", { id: sld, key: "ArrowRight" });
  ok((await page.textContent('[data-cid="' + sld + '"] .uslide-value')) === "4", "cursor.press ArrowRight steps the slider");

  // ---- the person at the browser answers ----
  const asking = call(alpha, "ask_user", { question: "Which region?", placeholder: "e.g. sgp" });
  await page.waitForSelector(".uc-card .uinput[placeholder='e.g. sgp']");
  await page.fill(".uc-card .uinput[placeholder='e.g. sgp']", "sgp-1");
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
  await page.click(".uc-card .ubtn:has-text('Send')");
  const asked = JSON.parse(text(await asking));
  ok(asked.answered && asked.answer === "sgp-1", "ask_user returns what the person typed: " + JSON.stringify(asked));
  const confirming = call(beta, "confirm", { message: "Ship v2.0?" });
  await page.waitForSelector(".uc-card .ubtn:has-text('Yes')");
  await page.click(".uc-card .ubtn:has-text('Yes')");
  ok(JSON.parse(text(await confirming)).confirmed === true, "confirm returns true when Yes is clicked");
  const removed = JSON.parse(text(await call(alpha, "dashboard_remove", {})));
  ok(removed.removed >= 2 && (await page.textContent("#dash-area")).includes("Builds"), "dashboard_remove with no id clears only this client's components (" + removed.removed + ")");

  // ---- kv and db: the page keeps data for tools, across calls and reloads ----
  ok(JSON.parse(text(await call(alpha, "storage", { action: "set", key: "settings/theme", value: { dark: true, size: 14 } }))) === true, "storage set (kv.set) a JSON value");
  await call(beta, "storage", { action: "set", key: "settings/lang", value: "vi" });
  ok(JSON.stringify(JSON.parse(text(await call(beta, "storage", { action: "get", key: "settings/theme" })))) === JSON.stringify({ dark: true, size: 14 }), "another client reads it back (kv.get)");
  ok(JSON.stringify(JSON.parse(text(await call(alpha, "storage", { action: "list", key: "settings/" }))).sort()) === JSON.stringify(["settings/lang", "settings/theme"]), "kv.list by prefix");
  const tooBig = await call(alpha, "big", {});
  ok(tooBig.isError && text(tooBig).includes("1 MB"), "a value over 1 MB is refused");
  const created = JSON.parse(text(await call(alpha, "sql", { statement: "CREATE TABLE todo (id INTEGER PRIMARY KEY, text TEXT NOT NULL, done INTEGER DEFAULT 0); INSERT INTO todo (text) VALUES ('first');" })));
  ok(created.changes === 1 && created.lastInsertRowid === 1, "sql: several statements run, with changes and lastInsertRowid");
  const ins = JSON.parse(text(await call(beta, "sql", { statement: "INSERT INTO todo (text, done) VALUES (?, ?)", params: ["Ship v2 — 'quoted'", 1] })));
  ok(ins.lastInsertRowid === 2, "sql: ? params bind safely");
  const rows = JSON.parse(text(await call(alpha, "sql", { statement: "SELECT id, text, done FROM todo ORDER BY id" })));
  ok(JSON.stringify(rows) === JSON.stringify([{ id: 1, text: "first", done: 0 }, { id: 2, text: "Ship v2 — 'quoted'", done: 1 }]), "sql: SELECT returns rows as objects");
  const ret = JSON.parse(text(await call(alpha, "sql", { statement: "UPDATE todo SET done = 1 WHERE id = ? RETURNING id, done", params: [1] })));
  ok(ret.length === 1 && ret[0].done === 1, "sql: RETURNING gives the changed rows");
  const badSql = await call(alpha, "sql", { statement: "SELEC nope" });
  ok(badSql.isError && /syntax error/i.test(text(badSql)), "an SQL error comes back as the tool's error: " + text(badSql).slice(0, 60));
  const idbTry = await call(alpha, "call" === "x" ? "x" : "idb", {});
  ok(idbTry.isError, "a tool cannot open IndexedDB itself (opaque origin): " + text(idbTry).slice(0, 70));
  const dataLine = await page.waitForFunction(() => { const t = document.getElementById("data").textContent; return /Data: 2 keys/.test(t) && /SQLite 1 table/.test(t) ? t : null; }, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => page.textContent("#data"));
  ok(/Data: 2 keys/.test(dataLine) && /SQLite 1 table/.test(dataLine), "the Data line shows the keys and tables: " + dataLine.slice(0, 70));
  // reload the page (the tab restarts), reconnect: the data is still there
  await page.reload({ waitUntil: "networkidle" });
  await page.click("#connect");
  await page.waitForFunction(() => window.__sandbox.state() === "connected", null, { timeout: 20000 });
  const rows2 = JSON.parse(text(await call(beta, "sql", { statement: "SELECT count(*) AS n, sum(done) AS done FROM todo" })));
  ok(rows2[0].n === 2 && rows2[0].done === 2, "after a reload the SQLite database is still there");
  ok(text(await call(beta, "storage", { action: "get", key: "settings/lang" })) === "vi", "and so is kv (a string comes back as plain text)");

  // ---- a dash to carry across Disconnect / reload / reconnect ----
  const pCounter = text(await call(beta, "dashboard_add", { spec: { type: "heading", text: "10" } }));
  const pPlus = text(await call(beta, "dashboard_add", { spec: { type: "button", label: "+1", on: { click: { tool: "increment", args: { id: pCounter } } } } }));
  const pField = text(await call(beta, "dashboard_add", { spec: { type: "input", label: "Note" } }));
  const pSel = text(await call(beta, "dashboard_add", { spec: { type: "select", options: ["a", "b", "c"], value: "a" } }));
  await call(beta, "pick", { id: pSel, value: "c" });
  const pBoard = JSON.parse(text(await call(beta, "kanban", { columns: ["Todo", "Done"], tasks: ["one", "two"] })));
  await call(beta, "cursor_drag", { id: pBoard.tasks[1], target: pBoard.columns["Done"] });

  // ---- disconnect ----
  await page.click("#connect");
  await page.waitForFunction(() => window.__sandbox.state() === "idle");
  ok(!(await page.isDisabled("#addBtn")), "Disconnect: editing unlocked");
  // ---- the dash persists across Disconnect and reloads ----
  const snapshot = async () => page.evaluate(() => [...document.querySelectorAll("#dash-area [data-cid]")].map((el) => {
    const v = el.querySelector("input, textarea"), sel = el.querySelector(".usel-value"), chk = el.querySelector(".ucheck, .utoggle"), sl = el.querySelector(".uslide-value");
    return [el.dataset.cid, (el.parentElement.closest("[data-cid]") || {}).dataset?.cid || "", v ? v.value : sel ? sel.textContent : chk ? chk.getAttribute("aria-checked") : sl ? sl.textContent : el.firstChild && el.firstChild.nodeType === 3 ? el.textContent : ""].join("|");
  }));
  const beforeDisc = await snapshot();
  ok(await page.isVisible("#dash") && beforeDisc.length >= 9 && (await page.locator(".cur:not(.me)").count()) === 0, "after Disconnect the dash stays (" + beforeDisc.length + " components); only the clients' cursors go");
  await page.click('[data-cid="' + pPlus + '"] .ubtn');
  await page.waitForFunction((id) => document.querySelector('[data-cid="' + id + '"]').textContent === "11", pCounter, { timeout: 10000 }).catch(() => {});
  ok((await page.textContent('[data-cid="' + pCounter + '"]')) === "11", "handlers still run while disconnected (they are local): 10 -> 11");
  await page.fill('[data-cid="' + pField + '"] input', "typed while offline");
  await sleep(600);
  const beforeReload = await snapshot();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((n) => document.querySelectorAll("#dash-area [data-cid]").length >= n, beforeReload.length, { timeout: 10000 });
  const afterReload = await snapshot();
  ok(JSON.stringify(afterReload) === JSON.stringify(beforeReload), "after a reload the dash is rebuilt exactly: ids, nesting, order (incl. the kanban drags) and values");
  if (JSON.stringify(afterReload) !== JSON.stringify(beforeReload)) console.log("  diff:", afterReload.filter((x, i) => x !== beforeReload[i]).slice(0, 5), beforeReload.filter((x, i) => x !== afterReload[i]).slice(0, 5));
  ok((await page.textContent('[data-cid="' + pSel + '"] .usel-value')) === "c" && (await page.inputValue('[data-cid="' + pField + '"] input')) === "typed while offline", "restored values: the select's pick and the typed note");
  await page.click('[data-cid="' + pPlus + '"] .ubtn');
  await page.waitForFunction((id) => document.querySelector('[data-cid="' + id + '"]').textContent === "12", pCounter, { timeout: 10000 }).catch(() => {});
  ok((await page.textContent('[data-cid="' + pCounter + '"]')) === "12", "restored handlers work: 11 -> 12");
  await page.click("#connect");
  await page.waitForFunction(() => window.__sandbox.state() === "connected", null, { timeout: 20000 });
  const relisted = JSON.parse(text(await call(beta, "dashboard_list", {})));
  ok(relisted.length === afterReload.length && relisted.find((c) => c.id === pField).value === "typed while offline" && relisted.find((c) => c.id === pBoard.tasks[1]).parent === pBoard.columns["Done"] && relisted.find((c) => c.id === pCounter).text === "12", "reconnected, clients see the same dash with the same ids and values");
  const kept = JSON.parse(text(await call(beta, "sql", { statement: "SELECT count(*) AS n FROM todo" })));
  ok(kept[0].n === 2 && text(await call(beta, "storage", { action: "get", key: "settings/lang" })) === "vi", "kv and SQLite data are still there after Disconnect + reload + reconnect");
  const fresh = text(await call(alpha, "dashboard_add", { spec: { type: "text", text: "after restore" } }));
  ok(!relisted.some((c) => c.id === fresh), "new components get fresh ids (" + fresh + "), no clash with restored ones");
  ok((await page.locator("#dashClear").count()) === 0, "there is no clear-dash button (tools remove components)");
  await call(alpha, "dashboard_remove", {}); await call(beta, "dashboard_remove", {});
  for (const c of JSON.parse(text(await call(beta, "dashboard_list", {})))) { try { await call(beta, "dashboard_remove", { id: c.id }); } catch {} }
  await page.click("#connect");
  await page.waitForFunction(() => window.__sandbox.state() === "idle");
  await sleep(600);
  ok((await page.locator("#dash-area [data-cid]").count()) === 0 && !(await page.isVisible("#dash")), "emptied by tools; disconnected and empty, the dash hides");
  await page.reload({ waitUntil: "networkidle" }); await sleep(500);
  ok((await page.locator("#dash-area [data-cid]").count()) === 0, "and it stays empty after a reload");
  await page.click("#data .linkbtn"); await page.click(".dlg-confirm .btn.danger");
  await page.waitForFunction(() => document.getElementById("data").textContent === "", null, { timeout: 5000 });
  ok(true, "Clear data (after confirming) empties kv and the database");

  await sleep(1500);
  let offline = "";
  try { await alpha.callTool({ name: "call", arguments: { name: "add", arguments: { a: 1 } } }); offline = "answered"; } catch (e) { offline = String(e.message); }
  ok(/503|offline/i.test(offline), "after Disconnect the gateway reports the device offline: " + offline.slice(0, 80));

  // ---- someone else already connected as demo ----
  const squatter = await openWs(B.replace(/^http/, "ws") + "/ws/" + ID, { "x-device-token": TOKEN });
  ok(squatter.ok, "(another device connects as " + ID + ")");
  await sleep(500);
  await page.click("#connect");
  await page.waitForFunction(() => window.__sandbox.state() === "idle" && /already connected/.test(document.getElementById("status").textContent), null, { timeout: 15000 });
  ok(true, "Connect while " + ID + " is online elsewhere: refused with a clear message");
  squatter.ws.close();
  ok(!(await page.getAttribute("#favicon", "href")).includes("%2316a34a"), "disconnected: the tab icon is back to black");
  // a browser seeded with the first starter set is offered the new ones
  await page.evaluate(() => {
    localStorage.setItem("code-mcp.sandbox.seeded.demo", "2026-10-18T00:00:00.000Z");
    const t = JSON.parse(localStorage.getItem("code-mcp.sandbox.tools.demo")).filter((x) => ["kanban", "cursor_drag", "dashboard_events", "increment"].indexOf(x.name) < 0);
    localStorage.setItem("code-mcp.sandbox.tools.demo", JSON.stringify(t));
  });
  await page.reload({ waitUntil: "networkidle" }); await sleep(500);
  const offer = await page.textContent("#starters");
  ok(/4 new starter tools/.test(offer) && offer.includes("kanban") && offer.includes("cursor_drag"), "an older browser is offered the new starters: " + offer.slice(0, 90));
  await page.click("#starters .linkbtn:has-text('Add')"); await sleep(1500);
  const names3 = await page.evaluate(() => window.__sandbox.tools().map((t) => t.name));
  ok(["kanban", "cursor_drag", "dashboard_events", "increment"].every((n) => names3.includes(n)) && (await page.textContent("#starters")) === "", "Add installs them and the offer goes away");
  await page.reload({ waitUntil: "networkidle" }); await sleep(500);
  ok((await page.textContent("#starters")) === "", "and it does not come back");
  ok(errors.length === 0, "no page errors " + errors.join(" | "));
  ok(nativeDialogs === 0, "no native browser dialogs (" + nativeDialogs + ")");
  await alpha.close(); await beta.close();
  await browser.close();
} catch (e) { fails++; console.log("FAIL harness " + (e.stack || e)); }
finally { if (w) { w.kill(); rmSync(R + "/.wrangler/state-" + PORT, { recursive: true, force: true }); } rmSync(TMP, { recursive: true, force: true }); }
console.log(fails ? fails + " FAILED" : "ALL PASSED");
process.exit(fails ? 1 : 0);
