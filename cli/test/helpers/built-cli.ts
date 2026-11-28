// The one way a test runs the built CLI.
//
// A run of `prime` that is not given a configuration and a home of its own is about the developer's: their
// ~/.prime, their fleet agent (an update restarts it), their services. Every run of the built binary in the
// end-to-end scripts goes through `spawnBuilt`/`spawnBuiltSync`, which refuse to start one that is not isolated, and a
// unit test (see `unit.test.ts`) fails if a script runs the binary any other way.
import { userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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

function inside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep));
}

/** Throws unless the environment isolates the run (see above). */
export function requireIsolated(env: Record<string, string | undefined> | undefined, built: BuiltOptions = {}): void {
  const config = env?.PRIME_CONFIG;
  if (!config) throw new Error("a run of the built CLI needs PRIME_CONFIG: without it it is about the developer's configuration");
  const real = userInfo().homedir;
  if (inside(config, join(real, ".prime"))) throw new Error("a run of the built CLI must not use the developer's configuration: " + config);
  if (built.realHome) return;
  const home = env?.HOME;
  if (!home) throw new Error("a run of the built CLI needs HOME of its own: without it it is about the developer's services and agent");
  if (resolve(home) === real) throw new Error("a run of the built CLI must not use the developer's home: " + home);
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
