// Smoke test for the Cloudflare Worker gateway.
// Starts TWO local wrangler instances (plain + auth) ONCE, runs all scenarios
// against the appropriate one, then tears both down. Requires node + wrangler
// in the worker/node_modules.
//
//   instance A (plain):  no tokens            -> protocol scenarios
//   instance B (auth):   GATEWAY/DEVICE/ADMIN -> auth scenarios
//
// Run: node --experimental-strip-types test/smoke.ts  (or bun test/smoke.ts)


let pass = 0,
  fail = 0;
const failures: string[] = [];

function ok(name: string): void {
  pass++;
  console.log("PASS " + name);
}
function bad(name: string, why: string): void {
  fail++;
  failures.push(name + ": " + why);
  console.log("FAIL " + name + ": " + why);
}

async function connectWs(url: string, headers: Record<string, string> = {}, attempts = 2): Promise<WebSocket> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const ws = new WebSocket(url, { headers });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws open timeout")), 30000);
        ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
        ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error("ws error: " + ((e as any).message || e))); }, { once: true });
      });
      return ws;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(1000);
    }
  }
  throw lastErr;
}

function recvJson<T = any>(ws: WebSocket, predicate: (m: any) => boolean, timeoutMs = 2500): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.removeEventListener("message", listener); reject(new Error("recv timeout")); }, timeoutMs);
    const listener = (e: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
      if (predicate(msg)) { clearTimeout(t); ws.removeEventListener("message", listener); resolve(msg); }
    };
    ws.addEventListener("message", listener);
  });
}

// ---------- wrangler lifecycle (two persistent instances, started externally) ----------
// Expected running instances (see package.json scripts / README):
//   wrangler dev --local --port 8801 (no tokens)
//   wrangler dev --local --port 8802 --var GATEWAY_TOKEN:... --var DEVICE_TOKEN:... --var ADMIN_TOKEN:...
const RUN_SUFFIX = String(Date.now()).slice(-6);
const PLAIN_PORT = Number(process.env.GW_PLAIN_PORT || 8801);
const AUTH_PORT = Number(process.env.GW_AUTH_PORT || 8802);
const plainBase = "http://127.0.0.1:" + PLAIN_PORT;
const authBase = "http://127.0.0.1:" + AUTH_PORT;

async function waitReady(base: string, timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(base + "/devices");
      if (r.status === 200 || r.status === 401 || r.status === 404) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("instance not ready at " + base);
}

// ---------- scenarios (plain instance, no tokens) ----------

async function s1_devices_plain(): Promise<void> {
  // Plain instance has no admin token -> /devices must be hidden (404), never leak.
  const r = await fetch(plainBase + "/devices");
  if (r.status !== 404) return bad("s1_devices_plain_404", "status=" + r.status);
  ok("s1_devices_plain_404");
}

async function s4_duplicate_register_rejected(): Promise<void> {
  const a = await connectWs(plainBase + "/ws/dup-id");
  await recvJson(a, (m) => m.type === "registered");
  let httpStatus = 0;
  try {
    const resp = await fetch(plainBase + "/ws/dup-id", {
      headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAA==", "sec-websocket-version": "13" },
    });
    httpStatus = resp.status;
  } catch {}
  if (httpStatus !== 409) return bad("s4_dup_id_409", "status=" + httpStatus);
  a.close();
  await Bun.sleep(200);
  ok("s4_duplicate_register_rejected");
}

async function s5_register_message_takeover_blocked(): Promise<void> {
  const victim = await connectWs(plainBase + "/ws/victim");
  await recvJson(victim, (m) => m.type === "registered");
  const attacker = await connectWs(plainBase + "/ws/attacker");
  await recvJson(attacker, (m) => m.type === "registered");
  attacker.send(JSON.stringify({ type: "register", deviceId: "victim" }));
  const errMsg = await recvJson<any>(attacker, (m) => m.type === "error");
  if (!errMsg.error?.includes("mismatch") && !errMsg.error?.includes("already"))
    return bad("s5_hijack_blocked", "unexpected: " + JSON.stringify(errMsg));
  victim.close();
  attacker.close();
  await Bun.sleep(200);
  ok("s5_register_message_takeover_blocked");
}

async function s6_e2e_rpc(): Promise<void> {
  const dev = await connectWs(plainBase + "/ws/s6-dev");
  await recvJson(dev, (m) => m.type === "registered");
  dev.addEventListener("message", (e) => {
    let env: any;
    try { env = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
    if (env?.id && env?.request) {
      dev.send(JSON.stringify({ id: env.id, response: { jsonrpc: "2.0", id: env.request.id, result: { echoed: env.request.params } } }));
    }
  });
  const r = await fetch(plainBase + "/mcp/s6-dev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "echo", params: { hello: "world" } }),
  });
  if (r.status !== 200) return bad("s6_e2e_rpc_status", "status=" + r.status);
  const body = (await r.json()) as any;
  if (body.id !== 7 || body.result?.echoed?.hello !== "world") return bad("s6_e2e_rpc_body", "body=" + JSON.stringify(body));
  dev.close();
  await Bun.sleep(200);
  ok("s6_e2e_rpc");
}

async function s7_cross_device_response_blocked(): Promise<void> {
  const dev1 = await connectWs(plainBase + "/ws/s7a");
  await recvJson(dev1, (m) => m.type === "registered");
  const dev2 = await connectWs(plainBase + "/ws/s7b");
  await recvJson(dev2, (m) => m.type === "registered");
  let leakedId: string | null = null;
  dev1.addEventListener("message", (e) => {
    let env: any;
    try { env = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
    if (env?.id) leakedId = env.id;
  });
  const reqPromise = fetch(plainBase + "/mcp/s7a", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m" }),
  });
  await Bun.sleep(300);
  if (!leakedId) return bad("s7_cross_device_blocked", "dev1 did not receive request");
  dev2.send(JSON.stringify({ id: leakedId, response: { jsonrpc: "2.0", id: 1, result: { malicious: true } } }));
  const r = await reqPromise;
  const body = (await r.json()) as any;
  if (r.status !== 504 || body.error !== "timeout")
    return bad("s7_cross_device_blocked", "expected 504 timeout, got " + r.status + " " + JSON.stringify(body));
  dev1.close();
  dev2.close();
  await Bun.sleep(200);
  ok("s7_cross_device_response_blocked");
}

async function s8_timeout(): Promise<void> {
  const dev = await connectWs(plainBase + "/ws/s8-dev");
  await recvJson(dev, (m) => m.type === "registered");
  const t0 = Date.now();
  const r = await fetch(plainBase + "/mcp/s8-dev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m" }),
  });
  const dt = Date.now() - t0;
  if (r.status !== 504) return bad("s8_timeout", "status=" + r.status);
  if (dt < 2000 || dt > 8000) return bad("s8_timeout", "unexpected dt=" + dt + "ms (TIMEOUT_MS=3000)");
  dev.close();
  await Bun.sleep(200);
  ok("s8_timeout");
}

async function s9_body_too_large(): Promise<void> {
  const dev = await connectWs(plainBase + "/ws/s9-dev");
  await recvJson(dev, (m) => m.type === "registered");
  const big = "x".repeat(2048);
  const r = await fetch(plainBase + "/mcp/s9-dev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m", params: big }),
  });
  if (r.status !== 413) return bad("s9_body_too_large", "status=" + r.status);
  dev.close();
  await Bun.sleep(200);
  ok("s9_body_too_large");
}

async function s10_pending_budget(): Promise<void> {
  // Dedicated instance with generous timeouts so miniflare DO cold-start and
  // keepalive-alarm quirks cannot interfere with the budget assertion.
  const g = await startWrangler(8806, ["TIMEOUT_MS=8000", "MAX_PENDING_PER_DEVICE=2", "KEEPALIVE_TIMEOUT_MS=60000"]);
  try {
    const dev = await connectWs(g.base + "/ws/s10-dev-" + RUN_SUFFIX);
    await recvJson(dev, (m) => m.type === "registered");
    const a = fetch(g.base + "/mcp/s10-dev-" + RUN_SUFFIX, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"m"}' });
    const b = fetch(g.base + "/mcp/s10-dev-" + RUN_SUFFIX, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":2,"method":"m"}' });
    await Bun.sleep(300);
    const c = await fetch(g.base + "/mcp/s10-dev-" + RUN_SUFFIX, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":3,"method":"m"}' });
    if (c.status !== 503) return bad("s10_pending_budget", "3rd status=" + c.status);
    const cb = (await c.json()) as any;
    if (cb.error !== "device busy") return bad("s10_pending_budget", "3rd body=" + JSON.stringify(cb));
    dev.close();
    a.catch(() => {});
    b.catch(() => {});
    await Bun.sleep(200);
    ok("s10_pending_budget");
  } finally {
    await stopWrangler(g.proc);
  }
}

async function s11_origin_whitelist(): Promise<void> {
  const r = await fetch(plainBase + "/ws/x", {
    headers: { upgrade: "websocket", connection: "upgrade", origin: "https://evil.example", "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAA==", "sec-websocket-version": "13" },
  });
  if (r.status !== 403) return bad("s11_origin_blocked", "status=" + r.status);
  const ws = await connectWs(plainBase + "/ws/s11-dev");
  await recvJson(ws, (m) => m.type === "registered");
  ws.close();
  await Bun.sleep(200);
  ok("s11_origin_whitelist");
}

async function s14_keepalive_ack(): Promise<void> {
  const ws = await connectWs(plainBase + "/ws/s14-dev");
  await recvJson(ws, (m) => m.type === "registered");
  ws.send(JSON.stringify({ type: "keepalive" }));
  const ack = await recvJson<any>(ws, (m) => m.type === "keepalive-ack");
  if (ack.type !== "keepalive-ack") return bad("s14_keepalive_ack", "ack=" + JSON.stringify(ack));
  ws.close();
  await Bun.sleep(200);
  ok("s14_keepalive_ack");
}

async function s16_invalid_device_id_rejected(): Promise<void> {
  const badIds = ["foo/bar", "a b", "a$b", "a".repeat(129), ""];
  for (const id of badIds) {
    const r = await fetch(plainBase + "/mcp/" + encodeURIComponent(id), { method: "POST", body: "{}" });
    if (r.status !== 400) return bad("s16_post_mcp_bad_id[" + JSON.stringify(id) + "]", "status=" + r.status);
  }
  let failed = false;
  try { await connectWs(plainBase + "/ws/" + encodeURIComponent("a b")); } catch { failed = true; }
  if (!failed) return bad("s16_ws_bad_id_rejected", "connect succeeded");
  ok("s16_invalid_device_id_rejected");
}

async function s17_devices_lists_online(): Promise<void> {
  const ws = await connectWs(authBase + "/ws/s17-dev-" + RUN_SUFFIX + "?token=" + DEV);
  await recvJson(ws, (m) => m.type === "registered");
  await Bun.sleep(600); // let the registry register propagate
  const r = await fetch(authBase + "/devices?auth=" + ADM);
  const body = (await r.json()) as any;
  if (!body.devices.includes("s17-dev-" + RUN_SUFFIX)) return bad("s17_devices_lists_online", "devices=" + JSON.stringify(body.devices));
  ws.close();
  await Bun.sleep(200);
  ok("s17_devices_lists_online");
}

async function s18_relay_token_forwarded(): Promise<void> {
  const dev = await connectWs(plainBase + "/ws/s18-dev");
  await recvJson(dev, (m) => m.type === "registered");
  let gotToken: string | null = null;
  dev.addEventListener("message", (e) => {
    let env: any;
    try { env = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
    if (env?.id && env?.request) {
      gotToken = env.token || null;
      dev.send(JSON.stringify({ id: env.id, response: { jsonrpc: "2.0", id: env.request.id, result: { token: gotToken } } }));
    }
  });
  const r = await fetch(plainBase + "/mcp/s18-dev?token=relay-secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "m" }),
  });
  const body = (await r.json()) as any;
  if (body.result?.token !== "relay-secret")
    return bad("s18_relay_token_forwarded", "device saw token=" + JSON.stringify(gotToken) + " body=" + JSON.stringify(body));
  dev.close();
  await Bun.sleep(200);
  ok("s18_relay_token_forwarded");
}

// ---------- scenarios (auth instance) ----------

const GW = "gw-secret-abc";
const DEV = "dev-secret-xyz";
const ADM = "admin-secret-xyz";

async function a1_devices_token_gated(): Promise<void> {
  let r = await fetch(authBase + "/devices");
  if (r.status !== 401) return bad("a1_no_token_401", "status=" + r.status);
  r = await fetch(authBase + "/devices?auth=" + ADM);
  if (r.status !== 200) return bad("a1_with_token_200", "status=" + r.status);
  const body = (await r.json()) as any;
  if (!Array.isArray(body.devices)) return bad("a1_with_token_200", "no devices array");
  ok("a1_devices_token_gated");
}

async function a2_gateway_auth(): Promise<void> {
  // No auth -> 401
  let r = await fetch(authBase + "/mcp/somedev", { method: "POST", body: "{}" });
  if (r.status !== 401) return bad("a2_no_auth_401", "status=" + r.status);
  // Wrong gateway token -> 401
  r = await fetch(authBase + "/mcp/somedev", { method: "POST", body: "{}", headers: { authorization: "Bearer wrong" } });
  if (r.status !== 401) return bad("a2_wrong_auth_401", "status=" + r.status);
  // Correct gateway token but missing device token -> 401 (device auth required)
  r = await fetch(authBase + "/mcp/somedev", { method: "POST", body: "{}", headers: { authorization: "Bearer " + GW } });
  if (r.status !== 401) return bad("a2_gw_only_401", "status=" + r.status);
  // Correct gateway + device tokens -> 503 (no device online) - auth passed
  r = await fetch(authBase + "/mcp/somedev?token=" + DEV, { method: "POST", body: "{}", headers: { authorization: "Bearer " + GW } });
  if (r.status !== 503) return bad("a2_full_auth_503", "status=" + r.status);
  // Device token via query, gateway via query -> 503
  r = await fetch(authBase + "/mcp/somedev?auth=" + GW + "&token=" + DEV, { method: "POST", body: "{}" });
  if (r.status !== 503) return bad("a2_query_full_auth_503", "status=" + r.status);
  ok("a2_gateway_auth");
}

async function a3_device_auth(): Promise<void> {
  let failed = false;
  try { await connectWs(authBase + "/ws/abc"); } catch { failed = true; }
  if (!failed) return bad("a3_no_token_ws_rejected", "connect succeeded without token");
  const ws = await connectWs(authBase + "/ws/a3-dev?auth=" + DEV);
  const reg = await recvJson<any>(ws, (m) => m.type === "registered");
  if (reg.deviceId !== "a3-dev") return bad("a3_query_token_ws_ok", "reg=" + JSON.stringify(reg));
  ws.close();
  await Bun.sleep(200);
  ok("a3_device_auth");
}


// ---------- security hardening scenarios ----------

async function s19_devices_hidden_without_admin(): Promise<void> {
  // plain instance has NO admin token -> /devices must be hidden (404), not leak the roster.
  const r = await fetch(plainBase + "/devices");
  if (r.status !== 404) return bad("s19_devices_hidden_404", "status=" + r.status);
  ok("s19_devices_hidden_without_admin");
}

async function s20_per_device_unknown_id_401(): Promise<void> {
  // auth instance runs in PER-DEVICE mode? No - it uses shared DEVICE_TOKEN.
  // For the per-device oracle test we use a dedicated per-device instance.
  const g = await startWrangler(8804, ["DEVICE_TOKENS=" + JSON.stringify({ "known-dev": "tok-a", "other-dev": "tok-b" }), "GATEWAY_TOKEN=" + GW, "ADMIN_TOKEN=" + ADM]);
  try {
    // Unknown deviceId -> 401 (no existence oracle; no DO created)
    let r = await fetch(g.base + "/mcp/ghost-dev", { method: "POST", body: "{}", headers: { authorization: "Bearer " + GW } });
    if (r.status !== 401) return bad("s20_unknown_id_401", "status=" + r.status + " body=" + (await r.text()));
    // Wrong token for a known device -> 401
    r = await fetch(g.base + "/mcp/known-dev?token=wrong", { method: "POST", body: "{}", headers: { authorization: "Bearer " + GW } });
    if (r.status !== 401) return bad("s20_wrong_token_401", "status=" + r.status);
    // Correct token, device offline -> 503 (auth passed)
    r = await fetch(g.base + "/mcp/known-dev?token=tok-a", { method: "POST", body: "{}", headers: { authorization: "Bearer " + GW } });
    if (r.status !== 503) return bad("s20_correct_token_503", "status=" + r.status + " body=" + (await r.text()));
    // WS with unknown id -> 401
    let failed = false;
    try { await connectWs(g.base + "/ws/ghost-dev?token=tok-a"); } catch { failed = true; }
    if (!failed) return bad("s20_ws_unknown_id_rejected", "connect succeeded");
    // WS with wrong token -> 401
    failed = false;
    try { await connectWs(g.base + "/ws/known-dev?token=wrong"); } catch { failed = true; }
    if (!failed) return bad("s20_ws_wrong_token_rejected", "connect succeeded");
    ok("s20_per_device_unknown_id_401");
  } finally {
    await stopWrangler(g.proc);
  }
}

async function s21_long_call(): Promise<void> {
  // Long tool calls: TIMEOUT_MS=8000 on a fresh instance; device sleeps 4s then replies.
  const g = await startWrangler(8805, ["TIMEOUT_MS=8000"]);
  try {
    const dev = await connectWs(g.base + "/ws/long-dev");
    await recvJson(dev, (m) => m.type === "registered");
    dev.addEventListener("message", (e) => {
      let env: any;
      try { env = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
      if (env?.id && env?.request) {
        // Simulate a long tool call: reply after 4s.
        setTimeout(() => {
          dev.send(JSON.stringify({ id: env.id, response: { jsonrpc: "2.0", id: env.request.id, result: { slow: true, waitedMs: 4000 } } }));
        }, 4000);
      }
    });
    const t0 = Date.now();
    const r = await fetch(g.base + "/mcp/long-dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slow" }),
    });
    const dt = Date.now() - t0;
    if (r.status !== 200) return bad("s21_long_call_200", "status=" + r.status + " body=" + (await r.text()));
    const body = (await r.json()) as any;
    if (body.result?.waitedMs !== 4000) return bad("s21_long_call_result", "body=" + JSON.stringify(body));
    if (dt < 3500) return bad("s21_long_call_timing", "returned too fast: " + dt + "ms");
    dev.close();
    ok("s21_long_call");
  } finally {
    await stopWrangler(g.proc);
  }
}


// ---------- local wrangler spawn (for custom-config scenarios) ----------

async function startWrangler(port: number, vars: string[]): Promise<any> {
  const ROOT = import.meta.dir + "/..";
  const WRANGLER = ROOT + "/node_modules/.bin/wrangler";
  const { spawn } = await import("node:child_process");
  const args = [
    WRANGLER, "dev", "--local", "--port", String(port), "--ip", "127.0.0.1",
    ...vars.flatMap((v) => ["--var", v.replace("=", ":")]),
  ];
  const proc = spawn("node", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(base + "/devices");
      if ([200, 401, 404].includes(r.status)) return { proc, base };
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error("wrangler did not start on port " + port);
}

async function stopWrangler(proc: any): Promise<void> {
  if (proc) { proc.kill(); await new Promise((r) => setTimeout(r, 400)); }
}

// ---------- run all ----------

async function main(): Promise<void> {
  console.log("Waiting for plain wrangler at", plainBase, "...");
  await waitReady(plainBase);
  console.log("Waiting for auth wrangler at", authBase, "...");
  await waitReady(authBase);
  console.log("Plain at", plainBase, "| Auth at", authBase);

  const plainScenarios: Array<[string, () => Promise<void>]> = [
    ["s1", s1_devices_plain],
    ["s4", s4_duplicate_register_rejected],
    ["s5", s5_register_message_takeover_blocked],
    ["s6", s6_e2e_rpc],
    ["s7", s7_cross_device_response_blocked],
    ["s8", s8_timeout],
    ["s9", s9_body_too_large],
    ["s10", s10_pending_budget],
    ["s11", s11_origin_whitelist],
    ["s14", s14_keepalive_ack],
    ["s16", s16_invalid_device_id_rejected],
    ["s17", s17_devices_lists_online],
    ["s18", s18_relay_token_forwarded],
    ["s20", s20_per_device_unknown_id_401],
  ];
  const authScenarios: Array<[string, () => Promise<void>]> = [
    ["a1", a1_devices_token_gated],
    ["a2", a2_gateway_auth],
    ["a3", a3_device_auth],
  ];
  for (const [, fn] of plainScenarios) {
    try { await fn(); } catch (e: any) { bad(fn.name, e?.message || String(e)); }
  }
  for (const [, fn] of authScenarios) {
    try { await fn(); } catch (e: any) { bad(fn.name, e?.message || String(e)); }
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log("  - " + f);
  }
  process.exit(fail === 0 ? 0 : 1);
}

await main();
