// End to end, against a real local worker: a decision made while the log is being copied to the bucket.
//
// The unit tests cannot show this: a stand-in for blockConcurrencyWhile has no input gate. In the runtime an
// audit entry that waited for a trim that waited for the bucket held the whole object shut until the platform
// reset it thirty seconds later. Here the copy is made slow (a seam), the log is made to trim after a few entries
// (another), and decisions are made while it is in flight: each must be answered in a moment, and the log must
// come out whole.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { port } from "./ports";

const ROOT = import.meta.dir + "/..";
const WRANGLER = ROOT + "/node_modules/.bin/wrangler";
const PORT = port(8843);
const BASE = "http://127.0.0.1:" + PORT;
const SLOW_MS = 4000;

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

async function startWorker(): Promise<{ stop: () => void }> {
  rmSync(ROOT + "/.wrangler/state-" + PORT, { recursive: true, force: true });
  const proc = spawn(
    "node",
    [WRANGLER, "dev", "--local", "-c", ROOT + "/wrangler.dev.toml", "--port", String(PORT), "--ip", "127.0.0.1",
      "--persist-to", ROOT + "/.wrangler/state-" + PORT, "--var", "RATE_LIMIT_MAX:100000",
      "--var", "FLEET_AUDIT_KEEP:4", "--var", "FLEET_AUDIT_BATCH:2", "--var", "FLEET_AUDIT_ARCHIVE_DELAY_MS:" + SLOW_MS],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log: string[] = [];
  const keep = (c: Buffer) => {
    log.push(c.toString());
    while (log.length > 60) log.shift();
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  for (let i = 0; i < 1200; i++) {
    try {
      const r = await fetch(BASE + "/admin/api/devices");
      if (r.status < 500) return { stop: () => proc.kill() };
    } catch {}
    await Bun.sleep(250);
  }
  proc.kill();
  throw new Error("wrangler did not become ready\n" + log.join("").slice(-1200));
}

const JSON_HEADERS = { "content-type": "application/json" };
async function admin(path: string, body: unknown = {}, method = "POST"): Promise<{ status: number; json: any; ms: number }> {
  const t = Date.now();
  const r = await fetch(BASE + path, { method, headers: JSON_HEADERS, body: method === "GET" ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})), ms: Date.now() - t };
}

const worker = await startWorker();
try {
  const made = await admin("/admin/api/fleets/trim", {});
  check("the fleet is made", made.status === 200, JSON.stringify(made.json));
  // Entries until the next one's tail starts a trim (keep 4 + batch 2 = 6): the copy then takes SLOW_MS.
  for (let i = 0; i < 6; i++) await admin("/admin/api/fleets/trim/invite");
  // The trim is now in flight. Decisions that make an entry each (the thing that deadlocked): all must be answered at once.
  const during: Array<{ status: number; ms: number }> = [];
  for (const [path, body] of [["/admin/api/fleets/trim/invite", {}], ["/admin/api/fleets/trim/meta", { label: "during a trim" }], ["/admin/api/fleets/trim/invite", {}]] as const) {
    during.push(await admin(path, body));
  }
  check("decisions during a trim are answered", during.every((d) => d.status === 200), JSON.stringify(during));
  check("...at once, not after the copy (and never thirty seconds later)", during.every((d) => d.ms < SLOW_MS - 1500), JSON.stringify(during));
  // Concurrent ones, too.
  const together = await Promise.all([1, 2, 3, 4].map(() => admin("/admin/api/fleets/trim/invite")));
  check("several at once are answered", together.every((d) => d.status === 200 && d.ms < SLOW_MS - 1500), JSON.stringify(together.map((d) => [d.status, d.ms])));
  // After the copy, the entries that went are out of the object and the rest is a chain.
  await Bun.sleep(SLOW_MS + 1500);
  const log = await admin("/admin/api/fleets/trim/audit?limit=500", {}, "GET");
  check("the log reads", log.status === 200, JSON.stringify(log.json).slice(0, 200));
  check("the oldest entries have gone to the bucket", log.json.first > 1, "first " + log.json.first);
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);
  const hash = async (e: unknown): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sorted(e))))), (b) => b.toString(16).padStart(2, "0")).join("");
  let chained = true;
  const entries: Array<{ n: number; prev: string }> = log.json.entries ?? [];
  for (let i = 1; i < entries.length; i++) if (entries[i]!.prev !== (await hash(entries[i - 1])) || entries[i]!.n !== entries[i - 1]!.n + 1) chained = false;
  check("what is left is a whole chain, up to the head", chained && entries.length > 0 && log.json.head?.hash === (await hash(entries[entries.length - 1])));
  check("the decisions made during the copy are in it", entries.some((e: any) => e.action === "fleet-changed"), JSON.stringify(entries.map((e: any) => e.action)));
  const gone = await admin("/admin/api/fleets/trim", {}, "DELETE");
  check("the fleet is deleted", gone.status === 200, JSON.stringify(gone.json));
} catch (err) {
  fail++;
  failures.push("crashed: " + (err instanceof Error ? err.stack ?? err.message : String(err)));
  console.log("FAIL crashed: " + (err instanceof Error ? err.message : String(err)));
} finally {
  worker.stop();
}
console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) {
  console.log(failures.join("\n"));
  process.exit(1);
}
process.exit(0);
