// The one way a test runs the built CLI.
//
// A run of `prime` that is not given a configuration and a home of its own is about the developer's: their
// ~/.prime, their fleet agent (an update restarts it), their services. Every run of the built binary in the
// end-to-end scripts goes through `spawnBuilt`/`spawnBuiltSync`, which refuse to start one that is not isolated, and a
// unit test (see `unit.test.ts`) fails if a script runs the binary any other way.
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface BuiltOptions {
  /**
   * The run is about the machine's real service manager and says so: it keeps the real home (a service's unit is in
   * the home the manager reads) and needs only a configuration of its own. Only `service-e2e.ts` does, and it never runs
   * a command that touches a fleet agent.
   */
  realHome?: boolean;
}

/** An environment that isolates a run: a configuration and a home inside `dir`, which is a scratch directory. */
export function isolatedEnv(dir: string, config: string): Record<string, string> {
  const home = join(dir, "home");
  return { PRIME_CONFIG: config, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1" };
}

/** A path as the file system knows it: links followed where it exists (a home reached through a link is the same home). */
function real(path: string): string {
  // The longest part of it that exists, with links followed, and the rest as it is.
  let rest = "";
  let head = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(head), rest);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      rest = join(basename(head), rest);
      head = parent;
    }
  }
}

function inside(path: string, parent: string): boolean {
  const rel = relative(real(parent), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep));
}

/** Throws unless the environment isolates the run (see above). */
export function requireIsolated(env: Record<string, string | undefined> | undefined, built: BuiltOptions = {}): void {
  const config = env?.PRIME_CONFIG;
  if (!config) throw new Error("a run of the built CLI needs PRIME_CONFIG: without it it is about the developer's configuration");
  const home = userInfo().homedir;
  if (inside(config, join(home, ".prime"))) throw new Error("a run of the built CLI must not use the developer's configuration: " + config);
  if (built.realHome) return;
  // HOME is what a POSIX program reads for its home, USERPROFILE what Windows does: both are the run's own.
  for (const name of process.platform === "win32" ? ["HOME", "USERPROFILE"] : ["HOME"]) {
    const value = env?.[name];
    if (!value) throw new Error("a run of the built CLI needs " + name + " of its own: without it it is about the developer's services and agent");
    if (real(value) === real(home)) throw new Error("a run of the built CLI must not use the developer's home (" + name + "): " + value);
  }
}

type Env = { env: Record<string, string | undefined> };

export function spawnBuilt<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "inherit",
>(cmd: string[], options: Bun.SpawnOptions.SpawnOptions<In, Out, Err> & Env, built: BuiltOptions = {}): Bun.Subprocess<In, Out, Err> {
  requireIsolated(options.env, built);
  return Bun.spawn(cmd, options);
}

export function spawnBuiltSync<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "pipe",
>(cmd: string[], options: Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err> & Env, built: BuiltOptions = {}): Bun.SyncSubprocess<Out, Err> {
  requireIsolated(options.env, built);
  return Bun.spawnSync(cmd, options);
}
