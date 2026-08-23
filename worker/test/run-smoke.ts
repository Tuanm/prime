// Runner: starts the two local wrangler instances, waits for readiness, then
// runs test/smoke.ts against them. Usage: bun test/run-smoke.ts
import { spawn } from "node:child_process";

const ROOT = import.meta.dir + "/..";
const WRANGLER = ROOT + "/node_modules/.bin/wrangler";
const { rmSync } = await import("node:fs");
try { rmSync(ROOT + "/.wrangler", { recursive: true, force: true }); } catch {} // fresh DO state (all instances)
const BUN = process.env.BUN_PATH || (await import("node:os")).homedir() + "/.bun/bin/bun";

async function start(port: number, vars: string[]): Promise<any> {
  // Use wrangler.dev.toml: it omits the [[containers]] block, which would make
  // wrangler dev try to build the Docker image (no Docker on CI runners).
  const args = [
    WRANGLER, "dev", "--local", "-c", ROOT + "/wrangler.dev.toml",
    "--port", String(port), "--ip", "127.0.0.1",
    "--persist-to", ROOT + "/.wrangler/state-" + port,
    ...vars.flatMap((v) => ["--var", v]),
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

console.log("Starting plain wrangler (8801)...");
const plain = await start(8801, [
  "TIMEOUT_MS:3000",
  "ALLOWED_ORIGINS:https://good.example",
  "MAX_PENDING_PER_DEVICE:2",
  "MAX_BODY_BYTES:256",
  "KEEPALIVE_TIMEOUT_MS:5000", // stale-socket cleanup fast in miniflare (reliable tests)
]);
console.log("Starting auth wrangler (8802)...");
const auth = await start(8802, [
  "GATEWAY_TOKEN:gw-secret-abc",
  "DEVICE_TOKEN:dev-secret-xyz",
  "ADMIN_TOKEN:admin-secret-xyz",
]);
console.log("plain:", plain.base, "| auth:", auth.base);

let code = 1;
try {
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(BUN, ["test/smoke.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, GW_PLAIN_PORT: "8801", GW_AUTH_PORT: "8802" },
  });
  code = res.status ?? 1;
} finally {
  plain.proc.kill();
  auth.proc.kill();
}
process.exit(code);
