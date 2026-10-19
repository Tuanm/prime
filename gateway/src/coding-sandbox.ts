// CodingSandbox - the cloud device's dev container.
//
// A Cloudflare Container (Durable Object) running a long-lived dev image
// (node, bun, python, git, bash, ripgrep). The gateway's cloud-device MCP
// tools call these RPC methods to run real processes at the edge - the
// "shell / file / jobs" capability that plain Workers cannot provide.
//
// See https://developers.cloudflare.com/containers/ for the platform.

import { Container } from "@cloudflare/containers";
import type { Env } from "./config";

const MAX_OUTPUT = 256 * 1024; // per-stream cap on captured output
const JOBS_DIR = "/tmp/code-mcp-jobs";
const JOB_LOG = JOBS_DIR + "/job.log";
const decoder = new TextDecoder();

export interface SandboxExecResult {
  pid: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function stdinStream(s: string): ReadableStream {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(s));
      controller.close();
    },
  });
}

function cap(buf: ArrayBuffer): string {
  const s = decoder.decode(buf);
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n... [truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

// Quote a string for embedding into a single-quoted bash -lc argument.
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\''") + "'";
}

export class CodingSandbox extends Container<Env> {
  private get ctnr() {
    if (!this.ctx.container) throw new Error("container context unavailable - is the containers binding deployed?");
    return this.ctx.container;
  }

  private async ensureRunning(): Promise<void> {
    if (!this.ctnr.running) {
      // Internet on: tools like npm/pip/git need outbound access.
      await this.start({ enableInternet: true });
    }
  }

  // ---- shell ---------------------------------------------------------------

  async shellRun(cmd: string, opts?: { stdin?: string; cwd?: string }): Promise<SandboxExecResult> {
    await this.ensureRunning();
    const proc = await this.ctnr.exec(["bash", "-lc", cmd], {
      cwd: opts?.cwd,
      stdin: opts?.stdin !== undefined ? stdinStream(opts.stdin) : undefined,
    });
    const out = await proc.output();
    return { pid: proc.pid, exitCode: out.exitCode, stdout: cap(out.stdout), stderr: cap(out.stderr) };
  }

  // ---- files ---------------------------------------------------------------

  async fsRead(path: string): Promise<SandboxExecResult> {
    await this.ensureRunning();
    const proc = await this.ctnr.exec(["cat", path]);
    const out = await proc.output();
    return { pid: proc.pid, exitCode: out.exitCode, stdout: cap(out.stdout), stderr: cap(out.stderr) };
  }

  async fsWrite(path: string, content: string): Promise<SandboxExecResult> {
    await this.ensureRunning();
    // tee with stdin writes (and prints) the content; truncates existing file.
    const proc = await this.ctnr.exec(["tee", path], { stdin: stdinStream(content) });
    const out = await proc.output();
    return { pid: proc.pid, exitCode: out.exitCode, stdout: "", stderr: cap(out.stderr) };
  }

  async fsList(path: string): Promise<SandboxExecResult> {
    return this.shellRun(`ls -la ${shq(path)}`);
  }

  // ---- jobs (background processes via nohup + log file) ----------------------

  async jobStart(cmd: string): Promise<SandboxExecResult> {
    // nohup keeps the process alive after the exec returns; the pid goes to
    // stdout so the agent can poll / stop it. Output lands in JOB_LOG.
    return this.shellRun(`mkdir -p ${JOBS_DIR} && nohup bash -lc ${shq(cmd)} > ${JOB_LOG} 2>&1 & echo $!`);
  }

  async jobStatus(pid: number): Promise<SandboxExecResult> {
    const alive = await this.shellRun(`kill -0 ${pid} 2>/dev/null && echo RUNNING || echo EXITED`);
    const tail = await this.shellRun(`tail -n 50 ${JOB_LOG} 2>/dev/null || echo '(no log yet)'`);
    return { pid: alive.pid, exitCode: alive.exitCode, stdout: alive.stdout + "\n--- log tail ---\n" + tail.stdout, stderr: alive.stderr || tail.stderr };
  }

  async jobStop(pid: number): Promise<SandboxExecResult> {
    return this.shellRun(`kill -9 ${pid} 2>/dev/null; echo stopped`);
  }
}
