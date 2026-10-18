// Anonymous devices: POST /api/devices/anonymous, their auth, limits, lifecycle
// and the admin API that manages them by opaque ref.
//
// Two local wrangler instances:
//   main  (8840) - a registered device + tight limits: device cap 6, 3 creations
//                  per IP, 5 relay requests per IP per anonymous device, lock
//                  after 4 wrong codes
//   open  (8841) - no registered devices (open mode) and short lifetimes, for
//                  the garbage collector and the "does not flip open mode" check
//
// Run: bun test/anonymous.ts
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const ROOT = import.meta.dir + "/..";
const WRANGLER = ROOT + "/node_modules/.bin/wrangler";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: unknown, detail = ""): void {
  if (cond) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    failures.push(name + (detail ? ": " + detail : ""));
    console.log("FAIL " + name + (detail ? ": " + detail : ""));
  }
}

async function startWorker(port: number, vars: string[]): Promise<{ base: string; stop: () => void }> {
  rmSync(ROOT + "/.wrangler/state-" + port, { recursive: true, force: true });
  const proc = spawn(
    "node",
    [WRANGLER, "dev", "--local", "-c", ROOT + "/wrangler.dev.toml", "--port", String(port), "--ip", "127.0.0.1",
      "--persist-to", ROOT + "/.wrangler/state-" + port, ...vars.flatMap((v) => ["--var", v])],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log: string[] = [];
  const keep = (c: Buffer) => {
    log.push(c.toString());
    while (log.length > 60) log.shift();
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 1200; i++) {
    try {
      const r = await fetch(base + "/admin/api/devices");
      if (r.status < 500) return { base, stop: () => proc.kill() };
    } catch {}
    await Bun.sleep(250);
  }
  proc.kill();
  throw new Error("wrangler did not become ready on " + port + "\n" + log.join("").slice(-1200));
}

const ANON_ID = /^anon-[a-f0-9]{16}$/;
const CODE = /^[0-9A-Z]{6}$/;

async function create(base: string, ip: string): Promise<{ status: number; body: any; headers: Headers }> {
  const r = await fetch(base + "/api/devices/anonymous", { method: "POST", headers: { "cf-connecting-ip": ip } });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
}

async function connectWs(url: string, headers: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), 30000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("ws error")); }, { once: true });
  });
  return ws;
}

async function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  const r = await fetch(url.replace(/^ws/, "http"), {
    headers: { ...headers, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAA==", "sec-websocket-version": "13" },
  });
  return r.status;
}

/** A device that answers tools/list with one tool and echoes tools/call. */
async function device(base: string, id: string, token: string): Promise<WebSocket> {
  const ws = await connectWs(base.replace(/^http/, "ws") + "/ws/" + id, { "x-device-token": token });
  ws.send(JSON.stringify({ type: "register", deviceId: id }));
  ws.addEventListener("message", (e) => {
    const env = JSON.parse(String(e.data));
    if (!env?.id || !env?.request) return;
    const req = env.request;
    const result = req.method === "tools/list"
      ? { tools: [{ name: "probe", description: "anonymous probe tool", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "called " + (req.params?.name || "?") }] };
    ws.send(JSON.stringify({ id: env.id, response: { jsonrpc: "2.0", id: req.id, result } }));
  });
  await Bun.sleep(300);
  return ws;
}

function rpc(method: string, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
}

async function mcp(base: string, id: string, opts: { token?: string; header?: string; ip?: string } = {}) {
  const q = opts.token !== undefined ? "?token=" + encodeURIComponent(opts.token) : "";
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": opts.ip || "10.0.0.1" };
  if (opts.header) headers["x-device-token"] = opts.header;
  const r = await fetch(base + "/mcp/" + id + q, { method: "POST", headers, body: rpc("tools/list") });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const ADMIN_JSON = { "content-type": "application/json" };
const main = startWorker(8840, [
  "MAX_DEVICES:6",
  "ANON_CREATE_MAX:3",
  "ANON_RATE_LIMIT_MAX:5",
  "RATE_LIMIT_MAX:1000",
  "ANON_AUTH_MAX_FAILURES:4",
  "ANON_AUTH_LOCK_MS:4000",
]);
const open = startWorker(8841, [
  "ANON_UNUSED_TTL_MS:2000",
  "ANON_IDLE_TTL_MS:2000",
  "ONLINE_TTL_MS:150000",
  "RATE_LIMIT_MAX:1000",
]);

const sockets: WebSocket[] = [];
let mainW: { base: string; stop: () => void } | null = null;
let openW: { base: string; stop: () => void } | null = null;
try {
  mainW = await main;
  const B = mainW.base;
  console.log("== main instance ==");

  // A registered device, so the gateway is in per-device mode like production.
  const reg = await fetch(B + "/admin/api/devices", { method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ deviceId: "reg1", token: "reg1-secret" }) });
  check("register a normal device", reg.ok, String(reg.status));

  // ---- registration ----
  const a1 = await create(B, "10.1.1.1");
  check("anonymous registration -> 201", a1.status === 201, JSON.stringify(a1.body));
  const id1: string = a1.body.deviceId;
  const tok1: string = a1.body.token;
  check("the id is generated in the anon- namespace", ANON_ID.test(id1), id1);
  check("the code is 6 digits/upper-case letters", CODE.test(tok1), tok1);
  check("connect_url is {gateway}/mcp/{id}?token={code}", a1.body.connect_url === B + "/mcp/" + id1 + "?token=" + tok1, a1.body.connect_url);
  check("ws_url points at the device tunnel", a1.body.ws_url === "ws://127.0.0.1:8840/ws/" + id1, a1.body.ws_url);
  check("it reports its lower rate limit", a1.body.rate_limit?.max === 5 && a1.body.rate_limit?.window_ms === 60000, JSON.stringify(a1.body.rate_limit));
  check("the response is not cacheable", a1.headers.get("cache-control") === "no-store");
  check("GET on the registration path -> 405", (await fetch(B + "/api/devices/anonymous")).status === 405);

  const a2 = await create(B, "10.1.1.1");
  const id2: string = a2.body.deviceId;
  const tok2: string = a2.body.token;
  check("a second registration gets a different id", a2.status === 201 && id2 !== id1, id2);
  const a3 = await create(B, "10.1.1.1");
  const id3: string = a3.body.deviceId;
  check("third from the same IP -> 201", a3.status === 201, String(a3.status));
  const limited = await create(B, "10.1.1.1");
  check("a fourth from the same IP is rate limited", limited.status === 429, String(limited.status));
  check("...with Retry-After", Number(limited.headers.get("retry-after")) > 0, String(limited.headers.get("retry-after")));
  const otherIp = await create(B, "10.2.2.2");
  check("another IP may still register (per-IP limit)", otherIp.status === 201, String(otherIp.status));
  const id4: string = otherIp.body.deviceId;

  // ---- the admin never sees ids or codes ----
  const full = await (await fetch(B + "/admin/api/devices")).json() as any;
  const fullText = JSON.stringify(full);
  const listedIds = full.devices.filter((d: any) => !d.virtual).map((d: any) => d.deviceId);
  check("Devices lists only registered devices (no anonymous)", listedIds.length === 1 && listedIds[0] === "reg1", JSON.stringify(listedIds));
  check("...and reports the total count across both kinds", full.count === 5 && full.max_devices === 6, JSON.stringify({ count: full.count, max: full.max_devices }));
  const anonList = await (await fetch(B + "/admin/api/anonymous")).json() as any;
  const anonText = JSON.stringify(anonList);
  check("Anonymous Devices lists all four", anonList.devices.length === 4, anonText.slice(0, 200));
  check("...by 24-hex ref", anonList.devices.every((d: any) => /^[a-f0-9]{24}$/.test(d.ref)));
  const secrets = [id1, id2, id3, id4, tok1, tok2, a3.body.token, otherIp.body.token];
  check("no anonymous id or code appears in either admin listing", secrets.every((s) => !anonText.includes(s) && !fullText.includes(s)));
  const refs = anonList.devices.map((d: any) => d.ref);

  // ---- the device connects and is reachable with its code ----
  check("the tunnel refuses a wrong code", (await upgradeStatus(B + "/ws/" + id1, { "x-device-token": "WRONG1" })) === 401);
  const dev1 = await device(B, id1, tok1);
  sockets.push(dev1);
  const viaQuery = await mcp(B, id1, { token: tok1 });
  check("the connect URL works (?token=)", viaQuery.status === 200 && viaQuery.body.result?.tools?.[0]?.name === "probe", JSON.stringify(viaQuery));
  check("X-Device-Token works too", (await mcp(B, id1, { header: tok1, ip: "10.0.0.2" })).status === 200);
  check("no code -> 401", (await mcp(B, id1, { ip: "10.0.0.3" })).status === 401);
  check("another device's code -> 401", (await mcp(B, id1, { token: tok2, ip: "10.0.0.3" })).status === 401);

  // ---- lower rate limit than a registered device ----
  const burst: number[] = [];
  for (let i = 0; i < 7; i++) burst.push((await mcp(B, id1, { token: tok1, ip: "10.9.9.9" })).status);
  check("an anonymous device gets 5 requests per IP per window", burst.slice(0, 5).every((s) => s === 200) && burst.slice(5).every((s) => s === 429), burst.join(","));
  const hint = await fetch(B + "/mcp/" + id1 + "?token=" + tok1, { method: "POST", headers: { "cf-connecting-ip": "10.9.9.9", "content-type": "application/json" }, body: rpc("ping") });
  check("...and the 429 says why", /anonymous devices allow 5/.test(JSON.stringify(await hint.json())));
  check("another client IP is unaffected", (await mcp(B, id1, { token: tok1, ip: "10.9.9.8" })).status === 200);
  const regBurst: number[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await fetch(B + "/mcp/reg1?token=reg1-secret", { method: "POST", headers: { "cf-connecting-ip": "10.9.9.9", "content-type": "application/json" }, body: rpc("ping") });
    regBurst.push(r.status);
  }
  check("a registered device is not held to the anonymous limit", !regBurst.includes(429), regBurst.join(","));

  // ---- brute-force lock on the 6-character code ----
  const misses: number[] = [];
  for (let i = 0; i < 4; i++) misses.push((await mcp(B, id2, { token: "AAAAA" + i, ip: "10.5.5." + i })).status);
  check("wrong codes are refused", misses.every((s) => s === 401), misses.join(","));
  await Bun.sleep(2200); // past the entry's 2s registry cache
  const lockedRight = await mcp(B, id2, { token: tok2, ip: "10.5.5.9" });
  check("after 4 misses even the right code is refused (locked)", lockedRight.status === 429, String(lockedRight.status));
  check("the lock also holds the tunnel", (await upgradeStatus(B + "/ws/" + id2, { "x-device-token": tok2 })) === 429);
  const lockedRow = ((await (await fetch(B + "/admin/api/anonymous")).json()) as any).devices.find((d: any) => d.locked);
  check("the admin sees it as locked", Boolean(lockedRow));
  await Bun.sleep(4500);
  const unlocked = await mcp(B, id2, { token: tok2, ip: "10.5.5.10" });
  check("the lock expires", unlocked.status === 503, String(unlocked.status) + " (503 = offline, i.e. authenticated)");
  check("a registered device is never locked", (await Promise.all([1, 2, 3, 4, 5].map((i) => mcp(B, "reg1", { token: "nope" + i, ip: "10.6.6." + i })))).every((r) => r.status === 401) &&
    (await mcp(B, "reg1", { token: "reg1-secret", ip: "10.6.6.9" })).status === 503);

  // ---- admin actions by ref ----
  const ref1 = (((await (await fetch(B + "/admin/api/anonymous")).json()) as any).devices.find((d: any) => d.online) || {}).ref;
  check("the connected device shows online", typeof ref1 === "string");
  const tools = await fetch(B + "/admin/api/anonymous/" + ref1 + "/tools", { method: "POST" });
  const toolsBody: any = await tools.json();
  check("admin Tools works without the code", tools.status === 200 && toolsBody.result?.tools?.[0]?.name === "probe", JSON.stringify(toolsBody).slice(0, 160));
  const clients: any = await (await fetch(B + "/admin/api/anonymous/" + ref1 + "/clients")).json();
  check("admin Clients lists the relaying clients", Array.isArray(clients.clients) && clients.clients.length > 0, JSON.stringify(clients).slice(0, 160));
  check("an unknown ref -> 404", (await fetch(B + "/admin/api/anonymous/" + "0".repeat(24) + "/tools", { method: "POST" })).status === 404);
  const badRef = await fetch(B + "/admin/api/anonymous/not-a-ref/state", { method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ disabled: true }) });
  check("a malformed ref is not routed anywhere", badRef.status === 404, String(badRef.status));
  check("...and did not disable anything", (await mcp(B, id1, { token: tok1, ip: "10.7.7.0" })).status === 200);

  const off = await fetch(B + "/admin/api/anonymous/" + ref1 + "/state", { method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ disabled: true }) });
  check("Deactivate by ref", off.ok);
  await Bun.sleep(2200);
  check("a deactivated device -> 403 on /mcp", (await mcp(B, id1, { token: tok1, ip: "10.7.7.1" })).status === 403);
  check("...and on its tunnel", (await upgradeStatus(B + "/ws/" + id1, { "x-device-token": tok1 })) === 403);
  check("...admin Tools too", (await fetch(B + "/admin/api/anonymous/" + ref1 + "/tools", { method: "POST" })).status === 403);
  await fetch(B + "/admin/api/anonymous/" + ref1 + "/state", { method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ disabled: false }) });
  await Bun.sleep(2200);
  check("Activate restores it", (await mcp(B, id1, { token: tok1, ip: "10.7.7.2" })).status === 200);

  // ---- file storage is for registered devices only ----
  const files = await fetch(B + "/api/files", { headers: { authorization: "Basic " + btoa(id1 + ":" + tok1) } });
  check("an anonymous device cannot use file storage", files.status === 401, String(files.status));

  // ---- the 6-device cap (1 registered + 5 anonymous) ----
  const fifth = await create(B, "10.3.3.3");
  check("fill the cap", fifth.status === 201 && ((await (await fetch(B + "/admin/api/devices")).json()) as any).count === 6);
  const over = await create(B, "10.3.3.4");
  check("an anonymous device past the cap -> 503", over.status === 503 && over.body.max_devices === 6, JSON.stringify(over.body));
  const regOver = await fetch(B + "/admin/api/devices", { method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ deviceId: "reg2", token: "t" }) });
  check("a registered device past the cap -> 409", regOver.status === 409, String(regOver.status));
  const regUpdate = await fetch(B + "/admin/api/devices", { method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ deviceId: "reg1", token: "reg1-secret" }) });
  check("updating an existing device at the cap still works", regUpdate.ok, String(regUpdate.status));
  const rename = await fetch(B + "/admin/api/devices", { method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ deviceId: "reg1b", token: "reg1-secret", replaces: "reg1" }) });
  const afterRename: any = await (await fetch(B + "/admin/api/devices")).json();
  check("renaming at the cap works and keeps the count", rename.ok && afterRename.count === 6 && afterRename.devices.some((d: any) => d.deviceId === "reg1b") && !afterRename.devices.some((d: any) => d.deviceId === "reg1"), JSON.stringify(afterRename).slice(0, 200));
  const reserved = await fetch(B + "/admin/api/devices", { method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ deviceId: "anon-0123456789abcdef", token: "x" }) });
  check("the admin cannot create an anon- id", reserved.status === 400, String(reserved.status));
  const hijack = await fetch(B + "/admin/api/devices", { method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ deviceId: "reg1b", token: "new", replaces: id1 }) });
  check("replaces cannot remove an anonymous device", hijack.ok && (await mcp(B, id1, { token: tok1, ip: "10.7.7.3" })).status === 200);

  // ---- delete by ref ----
  const del = await fetch(B + "/admin/api/anonymous/" + ref1, { method: "DELETE" });
  check("Delete by ref", del.ok);
  await Bun.sleep(2200);
  check("a deleted device -> 401 on /mcp", (await mcp(B, id1, { token: tok1, ip: "10.7.7.4" })).status === 401);
  check("...and on its tunnel", (await upgradeStatus(B + "/ws/" + id1, { "x-device-token": tok1 })) === 401);
  check("its ref is gone", (await fetch(B + "/admin/api/anonymous/" + ref1 + "/tools", { method: "POST" })).status === 404);
  const freed = await create(B, "10.3.3.5");
  check("deleting frees a slot under the cap", freed.status === 201, String(freed.status));
  void refs;

  // ---- open mode + garbage collection ----
  openW = await open;
  const O = openW.base;
  console.log("== open instance ==");
  check("open mode: an unregistered device connects without a code", (await upgradeStatus(O + "/ws/free-host", {})) === 101);
  const g1 = await create(O, "10.4.4.1");
  check("open mode: anonymous registration works", g1.status === 201);
  // Checked straight away: this instance collects unconnected devices after 2s.
  check("creating one does not flip the gateway into per-device mode", (await upgradeStatus(O + "/ws/free-host-2", {})) === 101);
  check("...but the anonymous device still needs its code", (await upgradeStatus(O + "/ws/" + g1.body.deviceId, { "x-device-token": "WRONG1" })) === 401);
  const g2 = await create(O, "10.4.4.1");
  const live = await device(O, g2.body.deviceId, g2.body.token);
  sockets.push(live);
  await Bun.sleep(3000);
  const listed: any = await (await fetch(O + "/admin/api/anonymous")).json();
  check("a never-connected anonymous device is collected", listed.devices.length === 1 && listed.devices[0].online === true, JSON.stringify(listed));
  live.close();
  await Bun.sleep(3500);
  const afterIdle: any = await (await fetch(O + "/admin/api/anonymous")).json();
  check("an idle (disconnected) one is collected too", afterIdle.devices.length === 0, JSON.stringify(afterIdle));
  check("...after which its id is no longer anonymous (open mode treats it as any unknown id)",
    !(JSON.stringify(await (await fetch(O + "/admin/api/anonymous")).json())).includes(g2.body.deviceId));
} catch (err) {
  fail++;
  failures.push("harness: " + ((err as Error).stack || err));
  console.log("FAIL harness: " + ((err as Error).stack || err));
} finally {
  for (const s of sockets) try { s.close(); } catch {}
  mainW?.stop();
  openW?.stop();
  if (!openW) (await open.catch(() => null))?.stop();
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (failures.length) console.log("Failures:\n  - " + failures.join("\n  - "));
process.exit(fail === 0 ? 0 : 1);
