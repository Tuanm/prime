// TEMPORARY diagnostic (windows-support PR): code-mcp's Windows C# helper
// compile under different environments, to find why it times out in code-mcp.
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const src = readFileSync(join(import.meta.dir, "..", "src", "code-mcp.ts"), "utf8");
const m = /const MCP_WINDOWS_JOB_SOURCE = String\.raw\x60([\s\S]*?)\x60;/.exec(src)!;
const ALLOW = ["PATH","HOME","USER","SHELL","LANG","LC_ALL","LC_CTYPE","TZ","TMPDIR","TEMP","TMP","SystemRoot","SystemDrive","USERPROFILE","APPDATA","LOCALAPPDATA","PROGRAMFILES","PROGRAMDATA","WINDIR","COMSPEC","PATHEXT"];
const SYSTEM = ["PSModulePath","ProgramFiles(x86)","ProgramW6432","CommonProgramFiles","CommonProgramFiles(x86)","CommonProgramW6432","ALLUSERSPROFILE","PUBLIC","OS","PROCESSOR_ARCHITECTURE","PROCESSOR_IDENTIFIER","NUMBER_OF_PROCESSORS","COMPUTERNAME","USERNAME","USERDOMAIN","HOMEDRIVE","HOMEPATH","DriverData"];
const pick = (keys: string[]) => {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  return Object.fromEntries(Object.entries(process.env).filter(([k, v]) => want.has(k.toLowerCase()) && typeof v === "string")) as Record<string, string>;
};
async function compile(label: string, env: Record<string, string> | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "probe-owner-"));
  const source = join(dir, "owner.cs"), exe = join(dir, "owner.exe");
  await Bun.write(source, m[1]);
  const q = (v: string) => "'" + v.replaceAll("'", "''") + "'";
  const script = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText(" + q(source) + ")) -OutputAssembly " + q(exe) + " -OutputType ConsoleApplication";
  const ps = resolve(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const t0 = performance.now();
  const p = Bun.spawn([ps, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const code = await Promise.race([p.exited, Bun.sleep(60_000).then(() => "TIMEOUT")]);
  if (code === "TIMEOUT") p.kill();
  const err = (await Promise.race([new Response(p.stderr).text(), Bun.sleep(2000).then(() => "")])).replace(/\s+/g, " ");
  console.log(label.padEnd(26) + " exit=" + code + " ms=" + Math.round(performance.now() - t0) + " exe=" + existsSync(exe) + (err && !/^#< CLIXML\s*$/.test(err) ? " stderr=" + err.slice(0, 400) : ""));
}
const missing = SYSTEM.filter((k) => !Object.keys(pick(ALLOW)).some((a) => a.toLowerCase() === k.toLowerCase()) && Object.keys(process.env).some((e) => e.toLowerCase() === k.toLowerCase()));
console.log("system vars the allowlist drops: " + missing.join(", "));
await compile("full environment", undefined);
await compile("code-mcp allowlist", pick(ALLOW));
await compile("allowlist + system vars", pick([...ALLOW, ...SYSTEM]));
for (const k of ["PSModulePath", "PROCESSOR_ARCHITECTURE", "USERNAME", "ProgramFiles(x86)"]) await compile("allowlist + " + k, pick([...ALLOW, k]));
