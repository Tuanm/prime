// Why is an upload to a deployed gateway slow? Sends the same sizes of body to the same fleet in different ways, one at a time, and
// prints how long each took and what the gateway said it spent (`ms` in its answer), so that the client, the network, the Worker's
// reading of the body and the bucket can be told apart:
//
//   ingest   POST /snapshot with a body that is not a frame: the gateway reads it whole and refuses it. Network and read only; no bucket.
//   held     POST /packs without the hash: read whole, then put to the bucket.
//   streamed POST /packs with the hash: piped to the bucket as it arrives (what a member does).
//   each from bun (a Buffer body; and, for streamed, a body that is a stream, as fleet-chunks.ts sends) and from curl.
//
// The operator token is read from the first line of stdin (never from an argument, so that it is not in a process list):
//   echo "$TOKEN" | bun test/upload-probe.ts https://<gateway>
// It makes one anonymous device (5 an hour per address) and a fleet of its own, and deletes the fleet at the end. The device is not removed:
// nothing but the admin API (behind Access) deletes an anonymous device, and the gateway collects it itself a week after it was last online. A 1 MiB body goes first
// in every way; the 8 MiB one is sent only the ways that did the 1 MiB in under 20 s.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const BASE = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!BASE) throw new Error("usage: echo $TOKEN | bun test/upload-probe.ts https://<gateway>");
const TOKEN = (await Bun.stdin.text()).split("\n")[0]!.trim();
if (!TOKEN) throw new Error("the operator token is read from the first line of stdin");
const FLEET = "probe-" + Date.now().toString(36);
const MIB = 1024 * 1024;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const OP = { "content-type": "application/json", authorization: "Bearer " + TOKEN };
let DEV = "";
let CODE = "";
const dev = () => ({ "x-prime-device": DEV, "x-device-token": CODE });
const json = async (r: Response) => ((await r.json().catch(() => ({}))) as any);

async function call(path: string, headers: Record<string, string>, body: unknown = {}, method = "POST") {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await json(r) };
}

interface Row { way: string; mib: number; status: string; seconds: number; rate: string; says: string }
const rows: Row[] = [];
function note(way: string, mib: number, status: string, ms: number, says: string) {
  const row = { way, mib, status, seconds: ms / 1000, rate: (((mib * MIB) / 1024) / (ms / 1000)).toFixed(0) + " KB/s", says };
  rows.push(row);
  console.log(way.padEnd(34) + String(mib).padStart(2) + " MiB  " + status.padEnd(8) + row.seconds.toFixed(1).padStart(6) + " s  " + row.rate.padStart(10) + "  " + says);
}

async function viaBun(way: string, path: string, headers: Record<string, string>, bytes: Uint8Array, asStream: boolean) {
  const mib = bytes.length / MIB;
  const h = { ...dev(), "content-type": "application/octet-stream", "content-length": String(bytes.length), ...headers };
  let sent = 0;
  const body: BodyInit = asStream
    ? new ReadableStream<Uint8Array>({ pull(c) { if (sent >= bytes.length) return c.close(); const end = Math.min(bytes.length, sent + 65536); c.enqueue(bytes.subarray(sent, end)); sent = end; } })
    : bytes;
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { method: "POST", headers: h, body, duplex: "half", signal: AbortSignal.timeout(100_000) } as RequestInit);
    const text = await r.text();
    const j = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    note(way, mib, String(r.status), Date.now() - t0, "ms=" + JSON.stringify(j.ms ?? null) + " ray=" + (r.headers.get("cf-ray") ?? "-") + (r.status >= 400 ? " " + text.slice(0, 120) : ""));
  } catch (error) {
    note(way, mib, "ERROR", Date.now() - t0, String((error as Error)?.message ?? error).slice(0, 100) + (asStream ? " (" + sent + " bytes taken)" : ""));
  }
}

async function viaCurl(way: string, path: string, headers: Record<string, string>, bytes: Uint8Array, extra: string[] = []) {
  const file = "/tmp/upload-probe-" + process.pid + ".bin";
  writeFileSync(file, bytes);
  // The device's code is given to curl on its standard input (a config), not on its command line, where a process list would show it.
  const config = ["Expect:", "content-type: application/octet-stream", "x-prime-device: " + DEV, "x-device-token: " + CODE, ...Object.entries(headers).map(([k, v]) => k + ": " + v)]
    .map((h) => 'header = "' + h.replace(/["\\]/g, "\\$&") + '"')
    .join("\n");
  const args = ["-sS", "--max-time", "100", "-X", "POST", ...extra, "-o", "/tmp/upload-probe-" + process.pid + ".out", "-w", "%{http_code} %{time_starttransfer} %{speed_upload} %{http_version}", "--data-binary", "@" + file, "-K", "-", BASE + path];
  const t0 = Date.now();
  // Not spawnSync: a curl that takes a minute must not stop the lease being renewed meanwhile.
  const child = Bun.spawn(["curl", ...args], { stdin: new TextEncoder().encode(config), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const r = { status: exit, stdout, stderr };
  const ms = Date.now() - t0;
  let says = "";
  try { says = " ms=" + JSON.stringify(JSON.parse(readFileSync("/tmp/upload-probe-" + process.pid + ".out", "utf8") || "{}").ms ?? null); } catch {}
  const [code, firstByte, speed, version] = (r.stdout || "").trim().split(" ");
  note(way, bytes.length / MIB, r.status === 0 ? code ?? "?" : "curl " + r.status, ms, "first byte after " + firstByte + " s, curl says " + Math.round(Number(speed) / 1024) + " KB/s over HTTP " + version + says + (r.status ? " " + (r.stderr || "").slice(0, 100) : ""));
  rmSync(file, { force: true });
  rmSync("/tmp/upload-probe-" + process.pid + ".out", { force: true });
}

try {
  const reg = await fetch(BASE + "/api/devices/anonymous", { method: "POST" });
  const made = await json(reg);
  if (reg.status !== 201 || !made.deviceId) throw new Error("the device could not be made: " + reg.status + " " + JSON.stringify(made));
  DEV = made.deviceId;
  CODE = made.token;
  const created = await call("/fleets/" + FLEET, { ...OP, "x-prime-device": DEV });
  if (created.status !== 200) throw new Error("the fleet could not be made: " + created.status + " " + JSON.stringify(created.json));
  const inv = await call("/fleets/" + FLEET + "/invite", OP);
  await call("/fleets/" + FLEET + "/join", dev(), { code: inv.json.code, label: DEV, pubkey: "A".repeat(43) + "=" });
  await call("/fleets/" + FLEET + "/approve", OP, { deviceId: DEV });
  const boot = await call("/fleets/" + FLEET + "/bootstrap", dev(), { caps: ["chunks"] });
  if (boot.json.role !== "primary") throw new Error("not the primary: " + JSON.stringify(boot.json));
  // The lease is renewed every third of it (15 s of 45) for as long as the probe runs, and taken again if it was lost, saying so: a refusal
  // as "only the primary may publish" in a row below means it was not the gateway being slow but the lease being gone.
  const started = Date.now();
  const roleNow = await call("/fleets/" + FLEET + "/role", dev(), {}, "GET");
  const every = Math.max(1000, Math.floor((typeof roleNow.json.leaseMs === "number" ? roleNow.json.leaseMs : 45_000) / 3));
  const renew = setInterval(async () => {
    try {
      const r = await call("/fleets/" + FLEET + "/lease/renew", dev());
      if (r.status === 200) return;
      console.log("LEASE renewal refused after " + ((Date.now() - started) / 1000).toFixed(0) + " s: " + r.status + " " + JSON.stringify(r.json) + "; taking it again");
      const again = await call("/fleets/" + FLEET + "/bootstrap", dev(), { caps: ["chunks"] });
      console.log("LEASE bootstrap again: " + again.json.role);
    } catch (error) {
      console.log("LEASE renewal failed: " + String(error));
    }
  }, every);
  console.log("gateway " + BASE + ", fleet " + FLEET + ", device " + DEV + "\n");
  console.log("way".padEnd(34) + "size       status   time        rate   what the gateway says it spent (ms)");

  const ways: Array<{ name: string; run: (bytes: Uint8Array) => Promise<void> | void }> = [
    { name: "ingest, bun Buffer", run: (b) => viaBun("ingest, bun Buffer", "/fleets/" + FLEET + "/snapshot", {}, b, false) },
    { name: "ingest, curl", run: (b) => viaCurl("ingest, curl", "/fleets/" + FLEET + "/snapshot", {}, b) },
    { name: "held, bun Buffer", run: (b) => viaBun("held, bun Buffer", "/fleets/" + FLEET + "/packs", {}, b, false) },
    { name: "held, curl", run: (b) => viaCurl("held, curl", "/fleets/" + FLEET + "/packs", {}, b) },
    { name: "streamed, bun Buffer", run: (b) => viaBun("streamed, bun Buffer", "/fleets/" + FLEET + "/packs", { "x-prime-sha256": sha(b) }, b, false) },
    { name: "streamed, bun stream body", run: (b) => viaBun("streamed, bun stream body", "/fleets/" + FLEET + "/packs", { "x-prime-sha256": sha(b) }, b, true) },
    { name: "streamed, curl", run: (b) => viaCurl("streamed, curl", "/fleets/" + FLEET + "/packs", { "x-prime-sha256": sha(b) }, b) },
    { name: "streamed, curl HTTP/1.1", run: (b) => viaCurl("streamed, curl HTTP/1.1", "/fleets/" + FLEET + "/packs", { "x-prime-sha256": sha(b) }, b, ["--http1.1"]) },
  ];
  const fast = new Set<string>();
  for (const w of ways) {
    await w.run(new Uint8Array(randomBytes(1 * MIB)));
    const row = rows[rows.length - 1]!;
    if (row.seconds < 20) fast.add(w.name);
  }
  console.log("");
  for (const w of ways) if (fast.has(w.name)) await w.run(new Uint8Array(randomBytes(8 * MIB)));
  clearInterval(renew);
} catch (error) {
  console.log("FAIL " + String(error));
  process.exitCode = 1;
} finally {
  await call("/fleets/" + FLEET + "/delete", OP).catch(() => {});
}
