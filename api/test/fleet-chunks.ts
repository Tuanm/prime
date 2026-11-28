// A snapshot in pieces, against a real local worker: four 8 MiB pieces uploaded at once (what a member does), their memory, the
// manifest alone that names them, and what the bucket then holds. The unit tests cannot say what the runtime holds while a body is read.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { port } from "./ports";

const ROOT = import.meta.dir + "/..";
const WRANGLER = ROOT + "/node_modules/.bin/wrangler";
const PORT = port(8847);
// FLEET_E2E_BASE points the test at a deployed gateway instead of a local worker (FLEET_E2E_TOKEN is its operator token), where a
// Worker held to its real memory limit is the thing under test: FLEET_CHUNKS_LANES (default 4) pieces are uploaded at once, and a 1102
// ("exceeded memory") or any refusal fails the run. Nothing is measured there, since there is no process to look at.
const EXTERNAL = (process.env.FLEET_E2E_BASE ?? "").replace(/\/+$/, "");
const EXTERNAL_TOKEN = process.env.FLEET_E2E_TOKEN ?? "";
const LANES = Math.max(1, Math.min(32, Number(process.env.FLEET_CHUNKS_LANES) || 4));
const BASE = EXTERNAL || "http://127.0.0.1:" + PORT;
// A deployed gateway is shared: the fleet and the device made here have names of their own, and are removed at the end.
const RUN = Date.now().toString(36);
// The member is a device made the way a real one is: an anonymous device (POST /api/devices/anonymous), which needs no credential of the
// operator's. An anonymous device the gateway collects itself once it has been offline (a week), so it is not removed here. A gateway
// lets one address make 5 an hour.
let DEV = "";
let TOKEN = "";
const FLEET = EXTERNAL ? "pieces-" + Date.now().toString(36) : "pieces";
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
  if (EXTERNAL) return;
  rmSync(ROOT + "/.wrangler/state-" + PORT, { recursive: true, force: true });
  wrangler = spawn(
    "node",
    [WRANGLER, "dev", "--local", "-c", ROOT + "/wrangler.dev.toml", "--port", String(PORT), "--ip", "127.0.0.1",
      "--persist-to", ROOT + "/.wrangler/state-" + PORT, "--var", "RATE_LIMIT_MAX:100000", "--var", "FLEET_OPERATOR_TOKEN:chunks-operator-token-0123456789", "--var", "ADMIN_ACCESS:enforce", "--var", "TOKEN_PEPPER:chunks-smoke-pepper-0123456789abcdef"],
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
      if ((await fetch(BASE + "/")).status < 500) return;
    } catch {}
    await Bun.sleep(250);
  }
  wrangler.kill();
  throw new Error("wrangler did not become ready\n" + log.join("").slice(-1200));
}

// The operator's calls go to the fleet's own routes (`/fleets/...`) with the operator token: that is all it needs. `/admin/api/...` is behind
// Access on a deployed gateway, and the member is an anonymous device it makes for itself, so neither is used.
const OP = { "content-type": "application/json", authorization: "Bearer " + (EXTERNAL ? EXTERNAL_TOKEN : "chunks-operator-token-0123456789"), "x-prime-device": "" };
const admin = async (path: string, body: unknown = {}, device = "") => {
  const r = await fetch(BASE + path, { method: "POST", headers: device ? { ...OP, "x-prime-device": device } : OP, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const dev = (id: string, token: string) => ({ "content-type": "application/json", "x-prime-device": id, "x-device-token": token });
const member = async (path: string, id: string, token: string, body: unknown = {}, method = "POST") => {
  const r = await fetch(BASE + path, { method, headers: dev(id, token), body: method === "GET" ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

try {
  await startWorker();
  const root = wrangler?.pid ?? 0;
  const registered = await fetch(BASE + "/api/devices/anonymous", { method: "POST" });
  const made = (await registered.json().catch(() => ({}))) as { deviceId?: string; token?: string };
  if (registered.status !== 201 || !made.deviceId || !made.token) throw new Error("the device could not be made: " + registered.status + " " + JSON.stringify(made));
  DEV = made.deviceId;
  TOKEN = made.token;
  check("the fleet is made", (await admin("/fleets/" + FLEET, {}, DEV)).status === 200);
  const inv = await admin("/fleets/" + FLEET + "/invite");
  await member("/fleets/" + FLEET + "/join", DEV, TOKEN, { code: inv.json.code, label: DEV, pubkey: PUBKEY });
  await admin("/fleets/" + FLEET + "/approve", { deviceId: DEV });
  const boot = await member("/fleets/" + FLEET + "/bootstrap", DEV, TOKEN, { caps: ["chunks"] });
  check("the member takes the lease", boot.json.role === "primary", JSON.stringify(boot.json));
  const role = await member("/fleets/" + FLEET + "/role", DEV, TOKEN, {}, "GET");
  check("the limits are told", role.json.chunkLimit === PIECE && role.json.chunkedLimit === 512 * MIB, JSON.stringify(role.json));

  // Eight pieces, four at a time, as a member uploads them; the process is watched while they go. Once with the hash of each piece
  // (the Worker streams it) and once without (it is held whole), so that the two can be told apart in the same run.
  // Made as each lane needs it, so that a run with many lanes does not hold every piece in the test's own memory.
  const PIECES = Math.max(8, 2 * LANES);
  const pieceOf = (salt: number, i: number): Uint8Array => {
    const b = new Uint8Array(PIECE);
    crypto.getRandomValues(b.subarray(0, 65536));
    b.fill(((i + salt) % 250) + 1, 65536);
    return b;
  };
  async function round(label: string, salt: number, withHash: boolean) {
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
    const uploaded: Array<{ hash: string; bytes: number }> = new Array(PIECES);
    let next = 0;
    const lane = async () => {
      for (;;) {
        const i = next++;
        if (i >= PIECES) return;
        const piece = pieceOf(salt, i);
        const hash = sha(piece);
        const headers: Record<string, string> = { ...dev(DEV, TOKEN), "content-type": "application/octet-stream" };
        if (withHash) headers["x-prime-sha256"] = hash;
        const r = await fetch(BASE + "/fleets/" + FLEET + "/packs", { method: "POST", headers, body: piece });
        const j = (await r.json().catch(() => ({}))) as any;
        if (r.status !== 200 || j.hash !== hash) throw new Error(label + " piece " + i + ": " + r.status + " " + JSON.stringify(j));
        uploaded[i] = { hash, bytes: piece.length };
      }
    };
    await Promise.all(Array.from({ length: LANES }, () => lane()));
    clearInterval(watch);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (!Number.isNaN(before.all)) {
      console.log(
        "MEMORY " + label + ": whole tree " + before.all + " MiB before, peak " + peak + " (" + (peak - before.all) + " over); workerd alone " + before.workerd + " before, peak " + peakWorkerd + " (" + (peakWorkerd - before.workerd) + " over); " + LANES + " x 8 MiB in flight, " + PIECES * 8 + " MiB in " + seconds + " s",
      );
    } else {
      console.log("MEMORY " + label + ": not measured here (no ps); " + PIECES * 8 + " MiB uploaded in " + seconds + " s");
    }
    return uploaded;
  }
  // What this measures is the local runtime, which is not the deployed one: workerd here also runs the simulated bucket, which reads a
  // body whole, so the figures are told and compared with each other, not held to a number.
  const uploaded = await round("streamed (hash sent)", 0, true);
  await round("held (no hash)", 100, false);
  check("eight pieces are stored, each under its own hash", uploaded.every((u) => u && u.hash.length === 64));

  // A piece that is not the one whose hash was named is not kept, and one sent without a hash still goes the held way.
  const wrong = await fetch(BASE + "/fleets/" + FLEET + "/packs", { method: "POST", headers: { ...dev(DEV, TOKEN), "x-prime-sha256": "a".repeat(64) }, body: new Uint8Array(1000).fill(42) });
  check("a pack that is not the one whose hash was named is refused", wrong.status === 400, String(wrong.status));
  const gone = await fetch(BASE + "/fleets/" + FLEET + "/packs/" + "a".repeat(64), { headers: dev(DEV, TOKEN) });
  check("and nothing of it is kept", gone.status === 404, String(gone.status));
  // A wrong body, of another length, under the hash of a pack that is there: refused, and the pack is still there and whole.
  const clobber = await fetch(BASE + "/fleets/" + FLEET + "/packs", { method: "POST", headers: { ...dev(DEV, TOKEN), "x-prime-sha256": uploaded[0]!.hash }, body: new Uint8Array(1000).fill(44) });
  check("a body of another length under a stored pack's hash is refused", clobber.status === 400, String(clobber.status));
  const still = await fetch(BASE + "/fleets/" + FLEET + "/packs/" + uploaded[0]!.hash, { headers: dev(DEV, TOKEN) });
  const stillBytes = new Uint8Array(await still.arrayBuffer());
  check("and the pack that was there is whole and the same", still.status === 200 && stillBytes.length === PIECE && sha(stillBytes) === uploaded[0]!.hash, String(still.status) + " " + stillBytes.length);
  const held = await fetch(BASE + "/fleets/" + FLEET + "/packs", { method: "POST", headers: dev(DEV, TOKEN), body: new Uint8Array(1000).fill(43) });
  check("a pack sent without a hash is stored as before", held.status === 200 && ((await held.json()) as any).hash === sha(new Uint8Array(1000).fill(43)));

  // The manifest alone names them.
  const manifest = {
    seq: 1, full: true, seal: "tag", chunks: uploaded, packBytes: PIECES * PIECE, packHash: "9".repeat(64),
  };
  const text = new TextEncoder().encode(JSON.stringify(manifest));
  const frame = new Uint8Array(4 + text.length);
  new DataView(frame.buffer).setUint32(0, text.length);
  frame.set(text, 4);
  const done = await fetch(BASE + "/fleets/" + FLEET + "/snapshot", { method: "POST", headers: { ...dev(DEV, TOKEN), "content-type": "application/octet-stream" }, body: frame });
  const doneJson = (await done.json().catch(() => ({}))) as any;
  check("the manifest alone is published and the head moves", done.status === 200 && doneJson.head?.seq === 1, JSON.stringify(doneJson));
  const head = await member("/fleets/" + FLEET + "/head", DEV, TOKEN, {}, "GET");
  check("the head is the snapshot", head.json.head?.seq === 1, JSON.stringify(head.json));
  const piece = await fetch(BASE + "/fleets/" + FLEET + "/packs/" + uploaded[3]!.hash, { headers: dev(DEV, TOKEN) });
  const got = new Uint8Array(await piece.arrayBuffer());
  check("a piece is read back as it was stored", piece.status === 200 && sha(got) === uploaded[3]!.hash);

  // A piece the manifest names that was never uploaded is named in the refusal, and the head stays.
  const bad = { ...manifest, seq: 2, chunks: [...uploaded.slice(0, 2), { hash: "e".repeat(64), bytes: PIECE }], packBytes: 3 * PIECE };
  const t2 = new TextEncoder().encode(JSON.stringify(bad));
  const f2 = new Uint8Array(4 + t2.length);
  new DataView(f2.buffer).setUint32(0, t2.length);
  f2.set(t2, 4);
  const refused = await fetch(BASE + "/fleets/" + FLEET + "/snapshot", { method: "POST", headers: { ...dev(DEV, TOKEN), "content-type": "application/octet-stream" }, body: f2 });
  const refusedJson = (await refused.json().catch(() => ({}))) as any;
  check("a piece that is not in the bucket is named and nothing moves", refused.status === 409 && refusedJson.missing?.[0] === "e".repeat(64), JSON.stringify(refusedJson));
} catch (error) {
  fail++;
  failures.push(String(error));
  console.log("FAIL " + String(error));
  console.log(log.join("").slice(-2500));
} finally {
  wrangler?.kill();
  if (EXTERNAL) {
    // The deployed gateway is left as it was found: the fleet and with it every piece it holds go.
    await admin("/fleets/" + FLEET + "/delete").catch(() => {});
  }
}
console.log("\n" + pass + " passed, " + fail + " failed");
if (fail > 0) {
  console.log("Failures:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
