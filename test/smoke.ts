// End-to-end smoke test for the gateway.
// Spawns the gateway as a subprocess per scenario, exercises HTTP + WS, kills it.

import { spawn, type Subprocess } from 'bun';

let pass = 0,
  fail = 0;
const failures: string[] = [];

function ok(name: string): void {
  pass++;
  console.log(`PASS ${name}`);
}
function bad(name: string, why: string): void {
  fail++;
  failures.push(`${name}: ${why}`);
  console.log(`FAIL ${name}: ${why}`);
}

async function startGateway(
  flags: string[],
): Promise<{ proc: Subprocess; port: number; baseHttp: string; baseWs: string }> {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const args = ['bun', 'gateway/server.ts', '--port', String(port), ...flags];
  const proc = spawn({ cmd: args, stdout: 'pipe', stderr: 'pipe', cwd: process.cwd() });
  // Wait for listen
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/devices`);
      // 200 (loopback unauth) or 401 are both proof of life
      if (r.status === 200 || r.status === 401 || r.status === 404) {
        return { proc, port, baseHttp: `http://127.0.0.1:${port}`, baseWs: `ws://127.0.0.1:${port}` };
      }
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`Gateway did not start on port ${port}`);
}

async function stopGateway(p: Subprocess): Promise<void> {
  p.kill('SIGTERM');
  try {
    await p.exited;
  } catch {}
}

async function connectWs(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  // Bun WebSocket supports custom headers via options
  // @ts-ignore - Bun extension
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 3000);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      (e) => {
        clearTimeout(t);
        reject(new Error(`ws error: ${(e as any).message || e}`));
      },
      { once: true },
    );
  });
  return ws;
}

function recvJson<T = any>(ws: WebSocket, predicate: (m: any) => boolean, timeoutMs = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.removeEventListener('message', listener);
      reject(new Error('recv timeout'));
    }, timeoutMs);
    const listener = (e: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(t);
        ws.removeEventListener('message', listener);
        resolve(msg);
      }
    };
    ws.addEventListener('message', listener);
  });
}

// ---------- scenarios ----------

async function s1_loopback_devices(): Promise<void> {
  const g = await startGateway([]);
  try {
    const r = await fetch(`${g.baseHttp}/devices`);
    if (r.status !== 200) return bad('s1_devices_loopback_200', `status=${r.status}`);
    const body = (await r.json()) as any;
    if (!Array.isArray(body.devices)) return bad('s1_devices_loopback_200', 'no devices array');
    ok('s1_devices_loopback_200');
  } finally {
    await stopGateway(g.proc);
  }
}

async function s2_gateway_auth(): Promise<void> {
  const TOKEN = 'gw-secret-abc';
  const g = await startGateway(['--token', TOKEN]);
  try {
    // No auth -> 401
    let r = await fetch(`${g.baseHttp}/mcp/somedev`, { method: 'POST', body: '{}' });
    if (r.status !== 401) return bad('s2_no_auth_401', `status=${r.status}`);

    // Wrong header -> 401
    r = await fetch(`${g.baseHttp}/mcp/somedev`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer wrong' },
    });
    if (r.status !== 401) return bad('s2_wrong_auth_401', `status=${r.status}`);

    // Correct header -> 503 (no device) but auth passes
    r = await fetch(`${g.baseHttp}/mcp/somedev`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (r.status !== 503) return bad('s2_header_auth_503', `status=${r.status}`);

    // Correct query -> 503 (auth passed)
    r = await fetch(`${g.baseHttp}/mcp/somedev?auth=${TOKEN}`, { method: 'POST', body: '{}' });
    if (r.status !== 503) return bad('s2_query_auth_503', `status=${r.status}`);

    ok('s2_gateway_auth');
  } finally {
    await stopGateway(g.proc);
  }
}

async function s3_device_auth(): Promise<void> {
  const T = 'dev-secret-xyz';
  const g = await startGateway(['--device-token', T]);
  try {
    // No token via query -> upgrade fails (401 on plain GET; ws fails)
    let failed = false;
    try {
      await connectWs(`${g.baseWs}/ws/abc`);
    } catch {
      failed = true;
    }
    if (!failed) return bad('s3_no_token_ws_rejected', 'connect succeeded without token');

    // Correct token via query -> connects
    const ws = await connectWs(`${g.baseWs}/ws/abc?auth=${T}`);
    const reg = await recvJson<any>(ws, (m) => m.type === 'registered');
    if (reg.deviceId !== 'abc') return bad('s3_query_token_ws_ok', `reg=${JSON.stringify(reg)}`);
    ws.close();

    ok('s3_device_auth');
  } finally {
    await stopGateway(g.proc);
  }
}

async function s4_duplicate_register_rejected(): Promise<void> {
  const g = await startGateway([]);
  try {
    const a = await connectWs(`${g.baseWs}/ws/dup-id`);
    await recvJson(a, (m) => m.type === 'registered');

    // Second connect with same id should be rejected at HTTP layer (409) before upgrade
    let httpStatus = 0;
    try {
      await connectWs(`${g.baseWs}/ws/dup-id`);
    } catch {
      /* expected */
    }
    const probe = await fetch(`${g.baseHttp}/ws/dup-id`, {
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
        'sec-websocket-version': '13',
      },
    });
    httpStatus = probe.status;
    if (httpStatus !== 409) return bad('s4_dup_id_409', `status=${httpStatus}`);

    a.close();
    ok('s4_duplicate_register_rejected');
  } finally {
    await stopGateway(g.proc);
  }
}

async function s5_register_message_takeover_blocked(): Promise<void> {
  const g = await startGateway([]);
  try {
    const victim = await connectWs(`${g.baseWs}/ws/victim`);
    await recvJson(victim, (m) => m.type === 'registered');

    const attacker = await connectWs(`${g.baseWs}/ws/attacker`);
    await recvJson(attacker, (m) => m.type === 'registered');
    attacker.send(JSON.stringify({ type: 'register', deviceId: 'victim' }));
    const errMsg = await recvJson<any>(attacker, (m) => m.type === 'error');
    if (!errMsg.error?.includes('already in use'))
      return bad('s5_hijack_blocked', `unexpected: ${JSON.stringify(errMsg)}`);

    // Devices list should still have both, victim and attacker, unchanged
    const r = await fetch(`${g.baseHttp}/devices`);
    const body = (await r.json()) as any;
    if (!body.devices.includes('victim') || !body.devices.includes('attacker')) {
      return bad('s5_hijack_blocked', `devices=${JSON.stringify(body.devices)}`);
    }
    victim.close();
    attacker.close();
    ok('s5_register_message_takeover_blocked');
  } finally {
    await stopGateway(g.proc);
  }
}

async function s6_e2e_rpc(): Promise<void> {
  const g = await startGateway([]);
  try {
    const dev = await connectWs(`${g.baseWs}/ws/dev1`);
    await recvJson(dev, (m) => m.type === 'registered');

    // Device echoes back any request
    dev.addEventListener('message', (e) => {
      let env: any;
      try {
        env = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (env?.id && env?.request) {
        dev.send(
          JSON.stringify({
            id: env.id,
            response: { jsonrpc: '2.0', id: env.request.id, result: { echoed: env.request.params } },
          }),
        );
      }
    });

    const r = await fetch(`${g.baseHttp}/mcp/dev1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'echo', params: { hello: 'world' } }),
    });
    if (r.status !== 200) return bad('s6_e2e_rpc_status', `status=${r.status}`);
    const body = (await r.json()) as any;
    if (body.id !== 7 || body.result?.echoed?.hello !== 'world') {
      return bad('s6_e2e_rpc_status', `body=${JSON.stringify(body)}`);
    }
    dev.close();
    ok('s6_e2e_rpc');
  } finally {
    await stopGateway(g.proc);
  }
}

async function s7_cross_device_response_blocked(): Promise<void> {
  const g = await startGateway(['--timeout', '1500']);
  try {
    const dev1 = await connectWs(`${g.baseWs}/ws/dev1`);
    await recvJson(dev1, (m) => m.type === 'registered');
    const dev2 = await connectWs(`${g.baseWs}/ws/dev2`);
    await recvJson(dev2, (m) => m.type === 'registered');

    // dev2 captures dev1's pending id and tries to respond
    let leakedId: string | null = null;
    dev1.addEventListener('message', (e) => {
      let env: any;
      try {
        env = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (env?.id) leakedId = env.id;
      // intentionally don't reply to force timeout
    });

    const reqPromise = fetch(`${g.baseHttp}/mcp/dev1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'm' }),
    });
    // Wait briefly so dev1 receives it
    await Bun.sleep(150);
    if (!leakedId) return bad('s7_cross_device_blocked', 'dev1 did not receive request');

    // dev2 tries to respond with the captured id
    dev2.send(
      JSON.stringify({
        id: leakedId,
        response: { jsonrpc: '2.0', id: 1, result: { malicious: true } },
      }),
    );

    const r = await reqPromise;
    const body = (await r.json()) as any;
    // dev2's response must be ignored => caller should get timeout (504)
    if (r.status !== 504 || body.error !== 'timeout') {
      return bad(
        's7_cross_device_blocked',
        `expected 504 timeout, got status=${r.status} body=${JSON.stringify(body)}`,
      );
    }
    dev1.close();
    dev2.close();
    ok('s7_cross_device_response_blocked');
  } finally {
    await stopGateway(g.proc);
  }
}

async function s8_timeout(): Promise<void> {
  const g = await startGateway(['--timeout', '600']);
  try {
    const dev = await connectWs(`${g.baseWs}/ws/dev`);
    await recvJson(dev, (m) => m.type === 'registered');
    // dev never replies
    const t0 = Date.now();
    const r = await fetch(`${g.baseHttp}/mcp/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'm' }),
    });
    const dt = Date.now() - t0;
    if (r.status !== 504) return bad('s8_timeout', `status=${r.status}`);
    if (dt < 500 || dt > 3000) return bad('s8_timeout', `unexpected dt=${dt}ms`);
    dev.close();
    ok('s8_timeout');
  } finally {
    await stopGateway(g.proc);
  }
}

async function s9_body_too_large(): Promise<void> {
  const g = await startGateway(['--max-body', '256']);
  try {
    const dev = await connectWs(`${g.baseWs}/ws/dev`);
    await recvJson(dev, (m) => m.type === 'registered');
    const big = 'x'.repeat(2048);
    const r = await fetch(`${g.baseHttp}/mcp/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'm', params: big }),
    });
    if (r.status !== 413) return bad('s9_body_too_large', `status=${r.status}`);
    dev.close();
    ok('s9_body_too_large');
  } finally {
    await stopGateway(g.proc);
  }
}

async function s10_pending_budget(): Promise<void> {
  // Per-device max-pending = 2; device never responds.
  const g = await startGateway(['--max-pending', '2', '--timeout', '5000']);
  try {
    const dev = await connectWs(`${g.baseWs}/ws/dev`);
    await recvJson(dev, (m) => m.type === 'registered');
    // Fire 2 requests that will hang
    const a = fetch(`${g.baseHttp}/mcp/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"m"}',
    });
    const b = fetch(`${g.baseHttp}/mcp/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":2,"method":"m"}',
    });
    // Give Bun a tick to register both pendings
    await Bun.sleep(100);
    // 3rd should fail fast with 503
    const c = await fetch(`${g.baseHttp}/mcp/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":3,"method":"m"}',
    });
    if (c.status !== 503) return bad('s10_pending_budget', `3rd status=${c.status}`);
    const cb = (await c.json()) as any;
    if (cb.error !== 'device busy') return bad('s10_pending_budget', `3rd body=${JSON.stringify(cb)}`);
    // Cleanup: kill server to release a,b promises
    dev.close();
    ok('s10_pending_budget');
    // a, b will reject due to server shutdown - swallow
    a.catch(() => {});
    b.catch(() => {});
  } finally {
    await stopGateway(g.proc);
  }
}

async function s11_origin_whitelist(): Promise<void> {
  const g = await startGateway(['--allowed-origin', 'https://good.example']);
  try {
    // Browser-style upgrade with bad origin -> 403
    const r = await fetch(`${g.baseHttp}/ws/x`, {
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        origin: 'https://evil.example',
        'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
        'sec-websocket-version': '13',
      },
    });
    if (r.status !== 403) return bad('s11_origin_blocked', `status=${r.status}`);

    // No origin -> allowed (non-browser); just confirm 101 status path by upgrading
    const ws = await connectWs(`${g.baseWs}/ws/y`);
    await recvJson(ws, (m) => m.type === 'registered');
    ws.close();
    ok('s11_origin_whitelist');
  } finally {
    await stopGateway(g.proc);
  }
}

async function s12_invalid_args(): Promise<void> {
  const p = spawn({
    cmd: ['bun', 'gateway/server.ts', '--port', 'abc'],
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
  });
  const code = await p.exited;
  if (code === 0) return bad('s12_invalid_args', `expected non-zero exit, got ${code}`);
  ok('s12_invalid_args');
}

async function s13_devices_loopback_only(): Promise<void> {
  // Bind to all interfaces but probe via 127.0.0.1 only; verify behavior with a spoofed X-Forwarded-For — that must NOT bypass the loopback check (we check peer IP, not headers).
  const g = await startGateway([]);
  try {
    const r = await fetch(`${g.baseHttp}/devices`, { headers: { 'x-forwarded-for': '1.2.3.4' } });
    if (r.status !== 200)
      return bad('s13_devices_loopback_only', `loopback fetch should pass: status=${r.status}`);
    ok('s13_devices_loopback_only');
  } finally {
    await stopGateway(g.proc);
  }
}

// ---------- run all ----------

async function main(): Promise<void> {
  const scenarios: Array<[string, () => Promise<void>]> = [
    ['s1', s1_loopback_devices],
    ['s2', s2_gateway_auth],
    ['s3', s3_device_auth],
    ['s4', s4_duplicate_register_rejected],
    ['s5', s5_register_message_takeover_blocked],
    ['s6', s6_e2e_rpc],
    ['s7', s7_cross_device_response_blocked],
    ['s8', s8_timeout],
    ['s9', s9_body_too_large],
    ['s10', s10_pending_budget],
    ['s11', s11_origin_whitelist],
    ['s12', s12_invalid_args],
    ['s13', s13_devices_loopback_only],
  ];
  for (const [, fn] of scenarios) {
    try {
      await fn();
    } catch (e: any) {
      bad(fn.name, e?.message || String(e));
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail === 0 ? 0 : 1);
}

await main();
