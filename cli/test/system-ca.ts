#!/usr/bin/env bun
// CI only: a root certificate installed in the OS certificate store - the way
// an organisation's IT deploys a TLS-inspection root - is trusted by code-mcp's
// tunnel when NODE_USE_SYSTEM_CA=1 (what 'mcp service' and 'mcp connect' set),
// and not without it. Needs administrator rights to edit the store, so it runs
// only with CODE_MCP_SYSTEM_CA_TEST=1 (set in CI).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.CODE_MCP_SYSTEM_CA_TEST !== "1") {
  console.log("skipped (set CODE_MCP_SYSTEM_CA_TEST=1; edits the OS certificate store)");
  process.exit(0);
}
const CN = "code-mcp CI Inspection Root " + Date.now();
const dir = mkdtempSync(join(tmpdir(), "sysca-"));
const sh = (cmd: string[], opts: { allowFail?: boolean } = {}) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0 && !opts.allowFail) throw new Error(cmd.join(" ") + " failed: " + r.stderr.toString() + r.stdout.toString());
  return r.stdout.toString();
};
const ca = join(dir, "ca.pem"), key = join(dir, "ca.key"), sk = join(dir, "srv.key"), csr = join(dir, "srv.csr"), crt = join(dir, "srv.pem"), ext = join(dir, "ext.cnf");
sh(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", ca, "-days", "2", "-subj", "/CN=" + CN]);
sh(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", sk, "-out", csr, "-subj", "/CN=localhost"]);
writeFileSync(ext, "subjectAltName=DNS:localhost");
sh(["openssl", "x509", "-req", "-in", csr, "-CA", ca, "-CAkey", key, "-CAcreateserial", "-out", crt, "-days", "2", "-extfile", ext]);

function install() {
  if (process.platform === "darwin") sh(["sudo", "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", ca]);
  else if (process.platform === "linux") { sh(["sudo", "cp", ca, "/usr/local/share/ca-certificates/code-mcp-ci.crt"]); sh(["sudo", "update-ca-certificates"]); }
  else sh(["certutil", "-addstore", "-f", "Root", ca]);
}
function uninstall() {
  if (process.platform === "darwin") sh(["sudo", "security", "delete-certificate", "-c", CN, "/Library/Keychains/System.keychain"], { allowFail: true });
  else if (process.platform === "linux") { sh(["sudo", "rm", "-f", "/usr/local/share/ca-certificates/code-mcp-ci.crt"], { allowFail: true }); sh(["sudo", "update-ca-certificates", "--fresh"], { allowFail: true }); }
  else sh(["certutil", "-delstore", "Root", CN], { allowFail: true });
}

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: Bun.file(crt), key: Bun.file(sk) },
  fetch(req, s) { if (s.upgrade(req)) return; return new Response("ok"); }, websocket: { message(ws, m) { ws.send("echo:" + m); } } });
const client = join(dir, "client.ts");
writeFileSync(client, 'const r = await new Promise((res) => { const ws = new WebSocket("wss://localhost:' + server.port + '/"); const t = setTimeout(() => res("timeout"), 8000); ws.onopen = () => ws.send("hi"); ws.onmessage = (e) => { clearTimeout(t); res(String(e.data)); ws.close(); }; ws.onerror = (e) => { clearTimeout(t); res("fail: " + e.message); }; }); console.log(r);');
const tunnel = (extra: Record<string, string>) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(NODE_USE_SYSTEM_CA|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(k)) env[k] = v;
  return Bun.spawn([process.execPath, client], { env: { ...env, ...extra }, stdout: "pipe" }).stdout.text().then((s) => s.trim());
};

let fail = 0;
try {
  install();
  const plain = await tunnel({});
  const system = await tunnel({ NODE_USE_SYSTEM_CA: "1" });
  const ok = (c: boolean, m: string) => { if (!c) fail++; console.log((c ? "PASS " : "FAIL ") + m); };
  ok(plain.startsWith("fail"), "without NODE_USE_SYSTEM_CA the OS-installed root is not trusted (" + plain.slice(0, 80) + ")");
  ok(system === "echo:hi", "with NODE_USE_SYSTEM_CA=1 the tunnel connects (" + system.slice(0, 80) + ")");
} finally {
  uninstall();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
