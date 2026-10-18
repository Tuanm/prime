// TEMPORARY diagnostic (windows-support PR): time code-mcp's Windows C# helper
// compile exactly as code-mcp runs it, with a generous budget.
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const src = readFileSync(join(import.meta.dir, "..", "src", "code-mcp.ts"), "utf8");
const m = /const MCP_WINDOWS_JOB_SOURCE = String\.raw\x60([\s\S]*?)\x60;/.exec(src);
if (!m) { console.log("source not found"); process.exit(1); }
for (const round of [1, 2]) {
  const dir = mkdtempSync(join(tmpdir(), "probe-owner-"));
  const source = join(dir, "owner.cs"), exe = join(dir, "owner.exe");
  await Bun.write(source, m[1]);
  const q = (v: string) => "'" + v.replaceAll("'", "''") + "'";
  const script = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText(" + q(source) + ")) -OutputAssembly " + q(exe) + " -OutputType ConsoleApplication";
  const ps = resolve(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const t0 = performance.now();
  const p = Bun.spawn([ps, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const code = await Promise.race([p.exited, Bun.sleep(180_000).then(() => "TIMEOUT")]);
  const ms = Math.round(performance.now() - t0);
  console.log("round " + round + ": exit=" + code + " ms=" + ms + " exe=" + existsSync(exe));
  if (code === "TIMEOUT") p.kill();
  const err = await new Response(p.stderr).text();
  if (err.trim()) console.log("stderr: " + err.slice(0, 600));
}
