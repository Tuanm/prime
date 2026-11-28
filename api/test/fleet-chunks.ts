// A snapshot in pieces, against a real local worker: four 8 MiB pieces uploaded at once (what a member does), their memory, the
// manifest alone that names them, and what the bucket then holds. The unit tests cannot say what the runtime holds while a body is read.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { port } from "./ports";

const ROOT = import.meta.dir + "/..";
const WRANGLER = ROOT + "/node_modules/.bin/wrangler";
const PORT = port(8847);
const BASE = "http://127.0.0.1:" + PORT;
const MIB = 1024 * 1024;
const PIECE = 8 * MIB;
const PUBKEY = "A".repeat(43) + "=";

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

/**
 * The resident size, in MiB, of a process and everything it started, and of the workerd processes among them (the runtime that holds
 * the Worker: wrangler itself, a Node process that proxies the requests, is the rest). NaN where `ps` is not there.
 */
function treeRss(root: number): { all: number; workerd: number } {
  let out: string;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], { encoding: "utf8" });
  } catch {
    // No `ps` (Windows, or a sandbox that does not allow it): the memory is not measured, the rest still runs.
    return { all: Number.NaN, workerd: Number.NaN };
  }
  const kids = new Map<number, number[]>();
  const rss = new Map<number, number>();
  const name = new Map<number, string>();
  for (const line of out.trim().split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [pid, ppid, kb] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rss.set(pid, kb);
    name.set(pid, m[4] ?? "");
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  let all = 0;
  let workerd = 0;
  const walk = (pid: number): void => {
    all += rss.get(pid) ?? 0;
    if (/workerd/.test(name.get(pid) ?? "")) workerd += rss.get(pid) ?? 0;
    for (const k of kids.get(pid) ?? []) walk(k);
  };
  walk(root);
  return { all: Math.round(all / 1024), workerd: Math.round(workerd / 1024) };
}

let wrangler: ReturnType<typeof spawn> | undefined;
const log: string[] = [];
async function startWorker(): Promise<void> {
  rmSync(ROOT + "/.wrangler/state-" + PORT, { recursive: true, force: true });
  wrangler = spawn(
    "node",
    [WRANGLER, "dev", "--local", "-c", ROOT + "/wrangler.dev.toml", "--port", String(PORT), "--ip", "127.0.0.1",
      "--persist-to", ROOT + "/.wrangler/state-" + PORT, "--var", "RATE_LIMIT_MAX:100000", "--var", "FLEET_OPERATOR_TOKEN:chunks-operator-token-0123456789"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const keep = (c: Buffer) => {
    log.push(c.toString());
    while (log.length > 60) log.shift();
  };
  wrangler.stdout?.on("data", keep);
  wrangler.stderr?.on("data", keep);
  for (let i = 0; i < 1200; i++) {
    try {
      if ((await fetch(BASE + "/admin/api/devices")).status < 500) return;
    } catch {}
    await Bun.sleep(250);
  }
  wrangler.kill();
  throw new Error("wrangler did not become ready\n" + log.join("").slice(-1200));
}

const OP = { "content-type": "application/json", authorization: "Bearer chunks-operator-token-0123456789" };
const dev = (id: string, token: string) => ({ "content-type": "application/json", "x-prime-device": id, "x-device-token": token });
const admin = async (path: string, body: unknown = {}) => {
  const r = await fetch(BASE + path, { method: "POST", headers: OP, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const member = async (path: string, id: string, token: string, body: unknown = {}, method = "POST") => {
  const r = await fetch(BASE + path, { method, headers: dev(id, token), body: method === "GET" ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

try {
  await startWorker();
  const root = wrangler!.pid!;
  await admin("/admin/api/devices", { deviceId: "dev-a", token: "token-a-1234" });
  check("the fleet is made", (await admin("/admin/api/fleets/pieces")).status === 200);
  const inv = await admin("/admin/api/fleets/pieces/invite");
  await member("/fleets/pieces/join", "dev-a", "token-a-1234", { code: inv.json.code, label: "dev-a", pubkey: PUBKEY });
  await admin("/admin/api/fleets/pieces/approve", { deviceId: "dev-a" });
  const boot = await member("/fleets/pieces/bootstrap", "dev-a", "token-a-1234", { caps: ["chunks"] });
  check("the member takes the lease", boot.json.role === "primary", JSON.stringify(boot.json));
  const role = await member("/fleets/pieces/role", "dev-a", "token-a-1234", {}, "GET");
  check("the limits are told", role.json.chunkLimit === PIECE && role.json.chunkedLimit === 512 * MIB, JSON.stringify(role.json));

  // Eight pieces, four at a time, as a member uploads them; the process is watched while they go.
  const pieces = Array.from({ length: 8 }, (_, i) => {
    const b = new Uint8Array(PIECE);
    crypto.getRandomValues(b.subarray(0, 65536));
    b.fill(i + 1, 65536);
    return b;
  });
  const before = treeRss(root);
  let peak = before.all;
  let peakWorkerd = before.workerd;
  const watch = setInterval(() => {
    const now = treeRss(root);
    if (!Number.isNaN(now.all)) {
      peak = Math.max(peak, now.all);
      peakWorkerd = Math.max(peakWorkerd, now.workerd);
    }
  }, 50);
  const started = Date.now();
  const uploaded: Array<{ hash: string; bytes: number }> = new Array(pieces.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= pieces.length) return;
      const r = await fetch(BASE + "/fleets/pieces/packs", { method: "POST", headers: { ...dev("dev-a", "token-a-1234"), "content-type": "application/octet-stream" }, body: pieces[i]! });
      const j = (await r.json().catch(() => ({}))) as any;
      if (r.status !== 200 || j.hash !== sha(pieces[i]!)) throw new Error("piece " + i + ": " + r.status + " " + JSON.stringify(j));
      uploaded[i] = { hash: j.hash, bytes: pieces[i]!.length };
    }
  };
  await Promise.all([lane(), lane(), lane(), lane()]);
  clearInterval(watch);
  const measured = !Number.isNaN(before.all);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (measured) {
    // What it cost is told, not asserted: the local runtime is not held to 128 MB, and the processes around the Worker (wrangler's
    // proxy, the simulated bucket) hold copies of a body that the deployed one does not.
    console.log(
      "MEMORY whole tree " + before.all + " MiB before, peak " + peak + " MiB (" + (peak - before.all) + " over); workerd alone " + before.workerd + " before, peak " + peakWorkerd + " (" + (peakWorkerd - before.workerd) + " over); 4 x 8 MiB in flight, 64 MiB in " + seconds + " s",
    );
  } else {
    console.log("MEMORY not measured here (no ps); 64 MiB uploaded in " + seconds + " s");
  }
  check("eight pieces are stored, each under its own hash", uploaded.every((u) => u && u.hash.length === 64));

  // The manifest alone names them.
  const manifest = {
    seq: 1, full: true, seal: "tag", chunks: uploaded, packBytes: 8 * PIECE, packHash: "9".repeat(64),
  };
  const text = new TextEncoder().encode(JSON.stringify(manifest));
  const frame = new Uint8Array(4 + text.length);
  new DataView(frame.buffer).setUint32(0, text.length);
  frame.set(text, 4);
  const done = await fetch(BASE + "/fleets/pieces/snapshot", { method: "POST", headers: { ...dev("dev-a", "token-a-1234"), "content-type": "application/octet-stream" }, body: frame });
  const doneJson = (await done.json().catch(() => ({}))) as any;
  check("the manifest alone is published and the head moves", done.status === 200 && doneJson.head?.seq === 1, JSON.stringify(doneJson));
  const head = await member("/fleets/pieces/head", "dev-a", "token-a-1234", {}, "GET");
  check("the head is the snapshot", head.json.head?.seq === 1, JSON.stringify(head.json));
  const piece = await fetch(BASE + "/fleets/pieces/packs/" + uploaded[3]!.hash, { headers: dev("dev-a", "token-a-1234") });
  const got = new Uint8Array(await piece.arrayBuffer());
  check("a piece is read back as it was stored", piece.status === 200 && sha(got) === uploaded[3]!.hash);

  // A piece the manifest names that was never uploaded is named in the refusal, and the head stays.
  const bad = { ...manifest, seq: 2, chunks: [...uploaded.slice(0, 2), { hash: "e".repeat(64), bytes: PIECE }], packBytes: 3 * PIECE };
  const t2 = new TextEncoder().encode(JSON.stringify(bad));
  const f2 = new Uint8Array(4 + t2.length);
  new DataView(f2.buffer).setUint32(0, t2.length);
  f2.set(t2, 4);
  const refused = await fetch(BASE + "/fleets/pieces/snapshot", { method: "POST", headers: { ...dev("dev-a", "token-a-1234"), "content-type": "application/octet-stream" }, body: f2 });
  const refusedJson = (await refused.json().catch(() => ({}))) as any;
  check("a piece that is not in the bucket is named and nothing moves", refused.status === 409 && refusedJson.missing?.[0] === "e".repeat(64), JSON.stringify(refusedJson));
} catch (error) {
  fail++;
  failures.push(String(error));
  console.log("FAIL " + String(error));
  console.log(log.join("").slice(-2500));
} finally {
  wrangler?.kill();
}
console.log("\n" + pass + " passed, " + fail + " failed");
if (fail > 0) {
  console.log("Failures:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
