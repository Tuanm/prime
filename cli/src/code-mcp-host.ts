// The bundled code-mcp device server (src/code-mcp.ts, vendored from
// github.com/Tuanm/code-mcp - see src/code-mcp.source.json and
// scripts/sync-code-mcp.ts).
//
// code-mcp.ts is a script, not a library: importing it parses Bun.argv, starts
// an HTTP server and (with --gateway) dials the gateway. It must therefore never
// be imported statically. The only way in is the hidden "mcp code-mcp"
// subcommand, which rewrites argv and then imports it dynamically.
//
// The specifier "#code-mcp" is a package.json subpath import that points at
// ./src/code-mcp.ts. It is a static string literal, so Bun.build and
// "bun build --compile" include the module in the bundle/binary. It is not a
// relative path so that "bun run typecheck" (tsconfig.typecheck.json) can map it
// to a declaration stub: the vendored file is kept byte-identical to upstream
// and is not written to this package's strict compiler settings.

/**
 * Environment variable carrying the device credential from "mcp connect" to the
 * code-mcp child. A command-line flag would be visible to every local user via
 * ps; the environment of a process is not (only to its owner and root).
 */
export const GATEWAY_TOKEN_ENV = "MCP_CODE_MCP_GATEWAY_TOKEN";

/**
 * The argv code-mcp should see: the given args, plus "--gateway-token <value>"
 * from GATEWAY_TOKEN_ENV unless the args already carry an explicit one.
 * Exported for tests; the injected value only ever exists in this process.
 */
export function codeMcpArgv(args: string[], env: Record<string, string | undefined> = process.env): string[] {
  const token = env[GATEWAY_TOKEN_ENV];
  const explicit = args.some((a) => a === "--gateway-token" || a.startsWith("--gateway-token="));
  return token && !explicit ? [...args, "--gateway-token", token] : [...args];
}

/**
 * The pid of the "mcp connect" that launched this code-mcp. Killing a process
 * does not kill its children - on Windows never (only a console Ctrl-C reaches
 * both), on POSIX not for SIGKILL - so without this an orphaned code-mcp would
 * keep the device online after "mcp connect" is gone.
 */
export const PARENT_PID_ENV = "MCP_CODE_MCP_PARENT_PID";
const PARENT_POLL_MS = 1_000;

/** Is the process alive? Signal 0 only probes; EPERM still means it exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exit when the launching "mcp connect" disappears. Returns the timer (for tests). */
export function watchParent(pid: number, exit: () => void = () => process.exit(0)): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (!processAlive(pid)) {
      clearInterval(timer);
      console.error("[mcp] 'mcp connect' is gone; stopping code-mcp");
      exit();
    }
  }, PARENT_POLL_MS);
  timer.unref();
  return timer;
}

/** Run code-mcp in this process with the given command-line arguments. */
export async function runCodeMcp(args: string[]): Promise<void> {
  const effective = codeMcpArgv(args);
  // Consumed: code-mcp's own child processes (bash, jobs, MCP servers) inherit
  // process.env, and must never receive the device credential.
  delete process.env[GATEWAY_TOKEN_ENV];
  const parent = Number(process.env[PARENT_PID_ENV]);
  delete process.env[PARENT_PID_ENV];
  if (Number.isInteger(parent) && parent > 0) watchParent(parent);
  // code-mcp reads Bun.argv.slice(2). Rewrite both argv views in place so the
  // script sees exactly its own flags (not "code-mcp" or any mcp flag). This
  // changes only the in-memory arrays, not what ps shows for this process.
  for (const argv of [Bun.argv, process.argv]) {
    const head = argv.slice(0, 2);
    argv.splice(0, argv.length, ...head, ...effective);
  }
  await import("#code-mcp");
}

/**
 * The argv that re-runs this CLI: the compiled binary itself, or the Bun
 * runtime plus the script (src/index.ts or dist/mcp.js).
 */
export function selfCommand(): string[] {
  const main = Bun.main;
  // A compiled executable reports its embedded entry point from the virtual
  // filesystem: /$bunfs/root/... on POSIX, B:/~BUN/root/... on Windows.
  const compiled = main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main);
  return compiled ? [process.execPath] : [process.execPath, main];
}
