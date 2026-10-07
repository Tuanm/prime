// End-to-end test for the temporary-file feature (see src/files-routes.ts).
//
// Boots one local wrangler instance with deliberately tiny limits and an
// miniflare-simulated R2 bucket, so the whole pipeline runs offline:
// Basic auth, streaming upload (known length and chunked), download, Range,
// protected keys, device isolation, all four quotas, and expiry reaping.
//
//   bun test/files.ts

import { spawn } from "node:child_process";

const ROOT = import.meta.dir + "/..";
const WRANGLER = ROOT + "/node_modules/.bin/wrangler";
const PORT = 8819;
const BASE = `http://127.0.0.1:${PORT}`;

// Small enough that the caps are reachable with a few hundred bytes.
const MAX_UPLOAD = 1000;
const MAX_TOTAL = 2500;
const MAX_FILES = 3;
const MAX_EXPIRY_MS = 5000;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string): void {
  pass++;
  console.log("PASS " + name);
}
function bad(name: string, why: string): void {
  fail++;
  failures.push(`${name}: ${why}`);
  console.log(`FAIL ${name}: ${why}`);
}
function check(name: string, condition: boolean, why = ""): void {
  if (condition) ok(name);
  else bad(name, why || "assertion failed");
}
function checkIncludes(name: string, haystack: string, needle: string): void {
  check(name, haystack.includes(needle), `${JSON.stringify(needle)} not in ${haystack.slice(0, 160)}`);
}

function basic(deviceId: string, token: string): Record<string, string> {
  return { authorization: "Basic " + btoa(`${deviceId}:${token}`) };
}

const DEMO = basic("demo", "demo");
const OTHER = basic("other", "other");

async function startWorker(port: number, vars: string[] = []): Promise<() => void> {
  const proc = spawn(
    "node",
    [
      WRANGLER, "dev", "--local",
      "-c", ROOT + "/wrangler.dev.toml",
      "--port", String(port), "--ip", "127.0.0.1",
      "--persist-to", ROOT + `/.wrangler/state-${port}`,
      ...vars.flatMap((v) => ["--var", v]),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/admin/api/devices`);
      if (r.status < 500) return () => proc.kill();
    } catch {}
    await Bun.sleep(250);
  }
  proc.kill();
  throw new Error(`wrangler did not become ready on ${port}`);
}

interface UploadResult {
  status: number;
  body: any;
}

async function upload(
  body: BodyInit,
  query: string,
  headers: Record<string, string> = DEMO,
  extra: RequestInit = {},
): Promise<UploadResult> {
  const response = await fetch(`${BASE}/api/files?${query}`, { method: "POST", headers, body, ...extra });
  let parsed: any = {};
  try {
    parsed = await response.json();
  } catch {}
  return { status: response.status, body: parsed };
}

async function listIds(headers: Record<string, string> = DEMO): Promise<string[]> {
  const response = await fetch(BASE + "/api/files", { headers });
  const json = (await response.json()) as { files: { id: string }[] };
  return (json.files ?? []).map((f) => f.id);
}

async function main(): Promise<void> {
  const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);
  const small = bytes(100);
  const tooBig = bytes(2000);

  // Register the devices the way the admin UI does.
  for (const id of ["demo", "other"]) {
    const r = await fetch(BASE + "/admin/api/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: id, token: id }),
    });
    if (!r.ok) throw new Error(`could not register ${id}: ${r.status}`);
  }

  // ---- auth ----
  check("no credentials -> 401", (await fetch(BASE + "/api/files")).status === 401);
  check("wrong password -> 401", (await fetch(BASE + "/api/files", { headers: basic("demo", "nope") })).status === 401);
  check("unregistered device -> 401", (await fetch(BASE + "/api/files", { headers: basic("ghost", "ghost") })).status === 401);
  check("valid credentials -> 200", (await fetch(BASE + "/api/files", { headers: DEMO })).status === 200);

  // ---- upload ----
  const created = await upload(small, "name=hello.txt&expiry_days=0.00005");
  check("upload -> 201", created.status === 201, JSON.stringify(created.body));
  const helloId: string = created.body.file?.id;
  checkIncludes("response carries a download url", JSON.stringify(created.body), `/api/files/${helloId}`);
  check("reported size is the measured size", created.body.file?.size === 100, String(created.body.file?.size));
  check("missing ?name -> 400", (await upload(small, "expiry_days=1")).status === 400);
  check("empty body -> 400", (await fetch(BASE + "/api/files?name=x", { method: "POST", headers: DEMO, body: new Uint8Array(0) })).status === 400);

  // Chunked (unknown length) takes the multipart path.
  const chunkedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(small);
      controller.close();
    },
  });
  const chunked = await upload(chunkedStream, "name=chunked.txt&expiry_days=0.00005", DEMO, { duplex: "half" } as RequestInit);
  check("chunked upload -> 201", chunked.status === 201, JSON.stringify(chunked.body));
  const chunkedId: string = chunked.body.file?.id;

  // ---- size cap ----
  const oversized = await upload(tooBig, "name=big.bin&expiry_days=0.00005");
  check("over the size cap -> 413", oversized.status === 413, JSON.stringify(oversized.body));
  checkIncludes("413 reports the limit", JSON.stringify(oversized.body), "limit_bytes");
  const streamedTooBig = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(tooBig);
      controller.close();
    },
  });
  check(
    "over-cap chunked upload -> 413",
    (await upload(streamedTooBig, "name=big2.bin&expiry_days=0.00005", DEMO, { duplex: "half" } as RequestInit)).status === 413,
  );

  // ---- expiry cap ----
  check("expiry beyond the cap -> 400", (await upload(small, "name=long.bin&expiry_days=1")).status === 400);
  check("expiry in the past -> 400", (await upload(small, "name=past.bin&expiry_days=0")).status === 400);

  // ---- download ----
  const download = await fetch(`${BASE}/api/files/${helloId}`, { headers: DEMO });
  check("plain download -> 200", download.status === 200, String(download.status));
  checkIncludes("content-disposition is an attachment", download.headers.get("content-disposition") ?? "", "attachment");
  check("downloaded bytes match", (await download.arrayBuffer()).byteLength === 100);
  const ranged = await fetch(`${BASE}/api/files/${helloId}`, { headers: { ...DEMO, range: "bytes=0-4" } });
  check("ranged download -> 206", ranged.status === 206, String(ranged.status));
  checkIncludes("content-range present", ranged.headers.get("content-range") ?? "", "bytes 0-4/");
  check("unknown id -> 404", (await fetch(`${BASE}/api/files/${"0".repeat(32)}`, { headers: DEMO })).status === 404);
  check("malformed id -> 400", (await fetch(`${BASE}/api/files/nope`, { headers: DEMO })).status === 400);
  check("chunked content round-trips", (await (await fetch(`${BASE}/api/files/${chunkedId}`, { headers: DEMO })).arrayBuffer()).byteLength === 100);

  // ---- protected files: the key travels in a header, never in the URL ----
  const protectedUpload = await upload(small, "name=secret.txt&expiry_days=0.00005&key=sesame");
  const secretId: string = protectedUpload.body.file?.id;
  check("protected upload -> 201", protectedUpload.status === 201);
  check(
    "the API download url carries no key",
    !String(protectedUpload.body.file?.download_url ?? "").includes("sesame"),
    String(protectedUpload.body.file?.download_url),
  );
  check("no key -> 401", (await fetch(`${BASE}/api/files/${secretId}`)).status === 401);
  check(
    "a query-string key is NOT accepted by the API",
    (await fetch(`${BASE}/api/files/${secretId}?key=sesame`)).status === 401,
  );
  check(
    "wrong header key -> 401",
    (await fetch(`${BASE}/api/files/${secretId}`, { headers: { "X-File-Key": "nope" } })).status === 401,
  );
  check(
    "right header key -> 200",
    (await fetch(`${BASE}/api/files/${secretId}`, { headers: { "x-file-key": "sesame" } })).status === 200,
  );
  check("the 401 explains the header", (await (await fetch(`${BASE}/api/files/${secretId}`)).text()).includes("X-File-Key"));
  check("owner bypasses the key", (await fetch(`${BASE}/api/files/${secretId}`, { headers: DEMO })).status === 200);

  // The page still accepts ?key= (a browser navigation cannot set a header) and
  // then hands it to the API as a header instead of putting it back in a URL.
  const lockedPage = await fetch(`${BASE}/files/${secretId}`);
  const lockedHtml = await lockedPage.text();
  check("locked page renders -> 200", lockedPage.status === 200);
  checkIncludes("locked page asks for the key", lockedHtml, 'id="keyForm"');
  check("locked page does not leak the key", !lockedHtml.includes("sesame"));
  const unlockedPage = await fetch(`${BASE}/files/${secretId}?key=sesame`);
  const unlockedHtml = await unlockedPage.text();
  checkIncludes("unlocked page offers a download control", unlockedHtml, 'id="dlBtn"');
  checkIncludes("unlocked page sends the key as a header", unlockedHtml, "X-File-Key");
  const wrongPage = await fetch(`${BASE}/files/${secretId}?key=nope`);
  checkIncludes("wrong page key re-prompts", await wrongPage.text(), 'id="keyForm"');

  // ---- device isolation ----
  check("another device sees none of these files", (await listIds(OTHER)).length === 0);
  check("another device cannot delete them", (await fetch(`${BASE}/api/files/${helloId}`, { method: "DELETE", headers: OTHER })).status === 200);
  check("the file survives that attempt", (await fetch(`${BASE}/api/files/${helloId}`, { headers: DEMO })).status === 200);

  // ---- pages ----
  check("GET /files without auth -> 401", (await fetch(BASE + "/files")).status === 401);
  checkIncludes("401 sends a Basic challenge", (await fetch(BASE + "/files")).headers.get("www-authenticate") ?? "", "Basic realm");
  const page = await fetch(BASE + "/files", { headers: DEMO });
  const pageHtml = await page.text();
  check("GET /files -> 200", page.status === 200);
  checkIncludes("page names the device", pageHtml, "file management &middot; demo");
  checkIncludes("page embeds the file list", pageHtml, "hello.txt");
  checkIncludes("page has the upload control", pageHtml, 'id="picker"');
  const downloadPage = await fetch(`${BASE}/files/${helloId}`);
  const downloadHtml = await downloadPage.text();
  check("GET /files/{id} -> 200", downloadPage.status === 200);
  checkIncludes("download page shows the name", downloadHtml, "hello.txt");
  checkIncludes("download page links the bytes", downloadHtml, `/api/files/${helloId}`);
  checkIncludes("pages carry a no-referrer policy", page.headers.get("referrer-policy") ?? "", "no-referrer");
  checkIncludes("downloads are sniff-proof", download.headers.get("x-content-type-options") ?? "", "nosniff");
  checkIncludes("pages are sniff-proof", page.headers.get("x-content-type-options") ?? "", "nosniff");
  check("unknown page -> 404", (await fetch(`${BASE}/files/${"0".repeat(32)}`)).status === 404);

  // ---- delete ----
  // helloId has been downloaded several times by now, so the worker's owner
  // cache holds it: deletion must still win over that cache.
  check(
    "repeat downloads still resolve after caching",
    (await fetch(`${BASE}/api/files/${helloId}`, { headers: DEMO })).status === 200,
  );
  check("delete -> 200", (await fetch(`${BASE}/api/files/${helloId}`, { method: "DELETE", headers: DEMO })).status === 200);
  check("deleted file -> 404", (await fetch(`${BASE}/api/files/${helloId}`, { headers: DEMO })).status === 404);
  check("deleted page -> 404", (await fetch(`${BASE}/files/${helloId}`)).status === 404);

  // ---- per-device file cap ----
  for (const id of await listIds()) await fetch(`${BASE}/api/files/${id}`, { method: "DELETE", headers: DEMO });
  for (let i = 0; i < MAX_FILES; i++) {
    const r = await upload(small, `name=cap${i}.bin&expiry_days=0.00005`);
    check(`cap file ${i + 1} accepted`, r.status === 201, JSON.stringify(r.body));
  }
  const overFiles = await upload(small, "name=cap-extra.bin&expiry_days=0.00005");
  check("one file too many -> 409", overFiles.status === 409, JSON.stringify(overFiles.body));
  checkIncludes("409 explains the limit", JSON.stringify(overFiles.body), "file limit reached");

  // ---- the quota check is atomic under concurrency ----
  // The check-then-insert lives in one Durable Object operation, so a burst must
  // not be able to exceed the cap. Fired together, `MAX_FILES + 3` uploads have
  // to produce exactly MAX_FILES successes.
  for (const id of await listIds()) await fetch(`${BASE}/api/files/${id}`, { method: "DELETE", headers: DEMO });
  const burst = await Promise.all(
    Array.from({ length: MAX_FILES + 3 }, (_, i) => upload(small, `name=race${i}.bin&expiry_days=0.00005`)),
  );
  const accepted = burst.filter((r) => r.status === 201).length;
  const refused = burst.filter((r) => r.status === 409).length;
  check(
    `${MAX_FILES + 3} concurrent uploads stop exactly at the ${MAX_FILES}-file cap`,
    accepted === MAX_FILES && refused === 3,
    `201s=${accepted} 409s=${refused} other=${burst.length - accepted - refused}`,
  );

  // ---- total-bytes cap ----
  for (const id of await listIds()) await fetch(`${BASE}/api/files/${id}`, { method: "DELETE", headers: DEMO });
  const nineHundred = bytes(900);
  check("900 B accepted", (await upload(nineHundred, "name=t1.bin&expiry_days=0.00005")).status === 201);
  check("second 900 B accepted", (await upload(nineHundred, "name=t2.bin&expiry_days=0.00005")).status === 201);
  const overTotal = await upload(nineHundred, "name=t3.bin&expiry_days=0.00005");
  check("third would pass the total cap -> 413", overTotal.status === 413, JSON.stringify(overTotal.body));

  // ---- expiry reaping ----
  for (const id of await listIds()) await fetch(`${BASE}/api/files/${id}`, { method: "DELETE", headers: DEMO });
  const expiring = await upload(small, "name=gone.bin&expires_in=1");
  const expiringId: string = expiring.body.file?.id;
  check("short-lived upload -> 201", expiring.status === 201);
  check("visible before expiry", (await fetch(`${BASE}/api/files/${expiringId}`, { headers: DEMO })).status === 200);
  await Bun.sleep(2500);
  check("gone from the list after expiry", !(await listIds()).includes(expiringId));
  check("download after expiry -> 404", (await fetch(`${BASE}/api/files/${expiringId}`, { headers: DEMO })).status === 404);
  check("page after expiry -> 404", (await fetch(`${BASE}/files/${expiringId}`)).status === 404);
  check("the slot is reusable after expiry", (await upload(small, "name=after.bin&expires_in=1")).status === 201);

  // ---- multipart boundaries ----
  // The tiny limits above cannot exercise a body larger than one R2 part, so a
  // second instance runs with the real defaults. The body is pushed in odd-sized
  // chunks so they straddle the 5 MiB part boundaries, which is exactly the
  // copying loop in putChunked that a single-part upload never reaches.
  const BIG_PORT = 8822;
  const BIG_BASE = `http://127.0.0.1:${BIG_PORT}`;
  const stopBig = await startWorker(BIG_PORT);
  try {
    await fetch(BIG_BASE + "/admin/api/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "demo", token: "demo" }),
    });

    const PART = 5 * 1024 * 1024;
    const total = PART * 2 + 12345; // two full parts and a short tail
    const payload = new Uint8Array(total);
    for (let i = 0; i < total; i++) payload[i] = (i * 31 + 7) & 0xff;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let offset = 0;
        while (offset < total) {
          const size = Math.min(700_000, total - offset);
          controller.enqueue(payload.subarray(offset, offset + size));
          offset += size;
        }
        controller.close();
      },
    });

    const bigUpload = await fetch(`${BIG_BASE}/api/files?name=multipart.bin&expiry_days=1`, {
      method: "POST",
      headers: DEMO,
      body: stream,
      duplex: "half",
    } as RequestInit);
    const bigJson: any = await bigUpload.json().catch(() => ({}));
    check("chunked upload spanning three parts -> 201", bigUpload.status === 201, JSON.stringify(bigJson).slice(0, 200));
    check("reported size is the full body", bigJson.file?.size === total, `${bigJson.file?.size} vs ${total}`);

    const bigDown = await fetch(`${BIG_BASE}/api/files/${bigJson.file?.id}`, { headers: DEMO });
    const received = new Uint8Array(await bigDown.arrayBuffer());
    let identical = received.length === total;
    if (identical) {
      for (let i = 0; i < total; i++) {
        if (received[i] !== payload[i]) {
          identical = false;
          break;
        }
      }
    }
    check(`all parts reassemble byte-identically (${(total / 1048576).toFixed(1)} MiB)`, identical, `${received.length} bytes`);

    // A Range request against the same object exercises the cached owner lookup.
    const midRange = await fetch(`${BIG_BASE}/api/files/${bigJson.file?.id}`, {
      headers: { ...DEMO, range: `bytes=${PART}-4294967295` },
    });
    check("range across a part boundary -> 206", midRange.status === 206, String(midRange.status));
  } finally {
    stopBig();
  }
}

// Tiny limits so the quotas are reachable with a few hundred bytes.
const stop = await startWorker(PORT, [
  `FILES_MAX_UPLOAD_BYTES:${MAX_UPLOAD}`,
  `FILES_MAX_TOTAL_BYTES:${MAX_TOTAL}`,
  `FILES_MAX_PER_DEVICE:${MAX_FILES}`,
  `FILES_MAX_EXPIRY_MS:${MAX_EXPIRY_MS}`,
]);
try {
  await main();
} catch (err) {
  bad("unexpected error", err instanceof Error ? err.message : String(err));
} finally {
  stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
