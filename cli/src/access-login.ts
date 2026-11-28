// A person's Cloudflare Access token, for the fleet commands that speak as that person (`--sso`).
//
// The gateway's /admin is behind Cloudflare Access. `cloudflared access login <app>` opens the browser once and keeps a
// session; `cloudflared access token -app=<app>` prints the JWT for it. The fleet routes accept that JWT as
// `cf-access-token` and record who it is (see docs/fleets.md, "Who did it"). The token is a credential: it is
// handed to the request and nothing else; it is never printed or written down.

import { spawn } from "node:child_process";

import { CliError } from "./errors.ts";

export interface AccessRun {
  /** The exit code; null when the program did not start or was ended. */
  code: number | null;
  out: string;
  /** True when the program is not installed. */
  missing?: boolean;
}

/** How the program is run: `interactive` gives it the terminal (the login opens a browser and says what to do). */
export type AccessRunner = (cmd: string, args: string[], opts: { interactive: boolean; timeoutMs: number }) => Promise<AccessRun>;

const JWT = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/;

export const defaultAccessRunner: AccessRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (r: AccessRun): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, { stdio: opts.interactive ? ["inherit", "pipe", "inherit"] : ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, out });
    }, opts.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > 65_536) out = out.slice(-65_536);
    });
    child.on("error", (err: NodeJS.ErrnoException) => finish({ code: null, out, missing: err.code === "ENOENT" }));
    child.on("close", (code) => finish({ code, out }));
  });

const cache = new Map<string, string>();
export function forgetAccessTokens(): void {
  cache.clear();
}

/** The token for the gateway's admin app: the session's, and a login first when there is none. */
export async function accessToken(gateway: string, run: AccessRunner = defaultAccessRunner): Promise<string> {
  const app = gateway.replace(/\/+$/, "") + "/admin";
  const cached = cache.get(app);
  if (cached !== undefined) return cached;
  const ask = async (): Promise<string | undefined> => {
    const r = await run("cloudflared", ["access", "token", "-app=" + app], { interactive: false, timeoutMs: 30_000 });
    if (r.missing) {
      throw new CliError(
        "--sso needs cloudflared, and it is not installed",
        "Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run this again; it logs you in through the browser.",
      );
    }
    const token = r.out.trim().split(/\s+/).pop() ?? "";
    return r.code === 0 && JWT.test(token) ? token : undefined;
  };
  let token = await ask();
  if (token === undefined) {
    const login = await run("cloudflared", ["access", "login", app], { interactive: true, timeoutMs: 300_000 });
    if (login.missing) throw new CliError("--sso needs cloudflared, and it is not installed");
    if (login.code !== 0) throw new CliError("cloudflared could not log you in to " + app, "Run 'cloudflared access login " + app + "' yourself and see what it says.");
    token = await ask();
  }
  if (token === undefined) throw new CliError("cloudflared gave no access token for " + app, "Run 'cloudflared access token -app=" + app + "' yourself and see what it says.");
  cache.set(app, token);
  return token;
}
