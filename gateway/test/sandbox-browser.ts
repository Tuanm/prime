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
  w = spawn("node", [R + "/node_modules/wrangler/bin/wrangler.js", "dev", "--local", "-c", R + "/wrangler.dev.toml", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", R + "/.wrangler/state-" + PORT], { cwd: R, stdio: "ignore" });
}
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };
const auth = "Basic " + btoa(ID + ":" + TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mcpClient(name) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(B + "/mcp/" + ID), { requestInit: { headers: { "x-device-token": TOKEN } } }));
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
  page.on("dialog", (d) => d.accept());
  await page.goto(B + "/mcp", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__sandbox.tools().length >= 10, null, { timeout: 15000 });
  const starterNames = await page.evaluate(() => window.__sandbox.tools().map((t) => t.name));
  ok(starterNames.includes("bar_chart") && starterNames.includes("ask_user") && starterNames.includes("dashboard_add"), "first visit: starter tools added (" + starterNames.length + ")");
  // the user can delete starters, and they do not come back
  const firstRow = page.locator("#list li.row").first();
  await firstRow.locator(".menu-btn").click(); await firstRow.locator(".menu button", { hasText: "Delete" }).click();
  await page.reload({ waitUntil: "networkidle" }); await sleep(800);
  ok((await page.evaluate(() => window.__sandbox.tools().length)) === starterNames.length - 1, "a deleted starter stays deleted after reload");
  await page.evaluate(() => { localStorage.removeItem("code-mcp.sandbox.tools.demo"); });
  await page.reload({ waitUntil: "networkidle" }); await sleep(800);
  ok((await page.evaluate(() => window.__sandbox.tools().length)) === 0, "deleting every tool does not bring the starters back");
  await page.evaluate(() => { localStorage.removeItem("code-mcp.sandbox.seeded.demo"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__sandbox.tools().length >= 10);

  const custom = {
    "add.js": "/**\n * Add two numbers.\n * @param {number} a First\n * @param {number} [b=1] Second\n */\nexport default async function add(a, b = 1) {\n  console.log('adding', a, b);\n  return a + b;\n}\n",
    "boom.js": "/**\n * Always fails.\n */\nexport default async function boom() {\n  throw new Error('kaboom');\n}\n",
    "exfil.js": "/**\n * Tries the network.\n */\nexport default async function exfil() {\n  const r = await fetch('https://example.com/');\n  return r.status;\n}\n",
    "peek.js": "/**\n * Tries the page's storage.\n */\nexport default async function peek() {\n  return localStorage.getItem('code-mcp.sandbox.tools.demo');\n}\n",
  };
  for (const [n, s] of Object.entries(custom)) {
    writeFileSync(join(TMP, n), s);
    await page.click("#addBtn"); await page.setInputFiles("#picker", join(TMP, n));
    await page.waitForFunction((n) => document.getElementById("list").textContent.includes(n), n);
    const last = page.locator("#list li.row").last();
    await last.locator(".menu-btn").click(); await last.locator(".menu button", { hasText: "Save" }).click();
    await sleep(300);
  }
  ok((await page.evaluate(() => window.__sandbox.tools().length)) === 14, "custom tools saved (14 in total)");

  // ---- connect ----
  await page.click("#connect");
  await page.waitForFunction(() => window.__sandbox.state() === "connected", null, { timeout: 20000 });
  ok(await page.isVisible("#dash") && (await page.textContent("#connect")) === "Disconnect", "Connect: connected, dash shown, button says Disconnect");
  ok(await page.isDisabled("#addBtn"), "while connected, + is disabled");
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
  ok(all.total === 14, "search with no query lists all 14 active tools");
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
  const names = await page.$$eval(".cur-name", (els) => els.map((e) => e.textContent));
  ok(names.includes("agent-alpha"), "a cursor labelled agent-alpha is in the dash");
  // beta waits for a click on the button, alpha clicks it
  const waitClick = beta.callTool({ name: "call", arguments: { name: "dashboard_list", arguments: {} } });
  ok(JSON.parse(text(await waitClick)).some((c) => c.id === box && c.value === "v2.0 rocket"), "another client sees the same dash and the typed value");
  await call(beta, "cursor_click", { id: go });
  const names2 = await page.$$eval(".cur-name", (els) => els.map((e) => e.textContent));
  ok(names2.includes("agent-alpha") && names2.includes("agent-beta") && names2.length === 2, "two clients, two named cursors: " + names2.join(", "));
  const colors = await page.$$eval(".cur-name", (els) => els.map((e) => e.style.background));
  ok(new Set(colors).size === 2, "each cursor has its own colour");
  const chart = text(await call(alpha, "bar_chart", { title: "Requests / day", labels: ["Mon", "Tue", "Wed", "Thu", "Fri"], values: [12, 30, 22, 41, 18] }));
  ok(/^c\d+$/.test(chart) && (await page.locator('[data-cid="' + chart + '"] img').count()) === 1, "bar_chart draws an image");
  ok(text(await call(alpha, "bar_chart", { title: "Requests / day", labels: ["Mon"], values: [5], id: chart })) === chart, "bar_chart redraws in place by id");
  await call(beta, "table", { title: "Builds", columns: ["id", "status", "time"], rows: [[101, "ok", "2m"], [102, "failed", "5m"]] });
  ok((await page.textContent("#dash-area")).includes("failed"), "table renders");

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

  // ---- disconnect ----
  await page.click("#connect");
  await page.waitForFunction(() => window.__sandbox.state() === "idle");
  ok(!(await page.isVisible("#dash")) && !(await page.isDisabled("#addBtn")), "Disconnect: dash hidden, editing unlocked");
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
  ok(errors.length === 0, "no page errors " + errors.join(" | "));
  await alpha.close(); await beta.close();
  await browser.close();
} catch (e) { fails++; console.log("FAIL harness " + (e.stack || e)); }
finally { if (w) { w.kill(); rmSync(R + "/.wrangler/state-" + PORT, { recursive: true, force: true }); } rmSync(TMP, { recursive: true, force: true }); }
console.log(fails ? fails + " FAILED" : "ALL PASSED");
process.exit(fails ? 1 : 0);
