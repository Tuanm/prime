// `prime fleets log` and `--sso`: the audit log is read page by page, its hash chain is checked the way the gateway made it,
// and a log that was cut back or rewritten is said to be, and fails the command.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accessToken, forgetAccessTokens, type AccessRun } from "../src/access-login";
import { AUDIT_GENESIS, auditEntryHash, canonicalJson, checkAuditChain, fleetsLog, fleetsMembers, useAccessRunner, type AuditRow } from "../src/fleets";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

describe("the audit log's hash", () => {
  // Made by the gateway's own code (api/src/fleet-audit.ts `entryHash`, impl/g2) for these two entries.
  const e1: AuditRow = { n: 1, prev: AUDIT_GENESIS, at: 1700000000000, actor: { kind: "access", email: "a@b.c" }, action: "fleet-created" };
  const e2: AuditRow = {
    n: 2,
    prev: "d86907941220203e7adc7312398a4db5684ac8499be4142e73776587a5d4a0db",
    at: 1700000001000,
    actor: { kind: "owner", id: "dev-1" },
    action: "member-admitted",
    target: "dev-2",
    detail: { role: "member", fp: "ab12", ok: true, k: null, z: 3 },
  };
  test("is the same as the gateway's for the same entry", () => {
    expect(auditEntryHash(e1)).toBe(e2.prev);
    expect(auditEntryHash(e2)).toBe("ef1fcd684e311a829076841f36caaa0b6a6ee1761707a6a6d88c8d1d07d97ef2");
  });
  test("canonical JSON puts keys in order and leaves out what is undefined", () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: null }] })).toBe('{"a":[{"c":null}],"b":1}');
  });
  test("a chain is checked for numbers and previous hashes, and the first is checked only when it is expected to be known", () => {
    expect(checkAuditChain([e1, e2], AUDIT_GENESIS).brokenAt).toBeNull();
    expect(checkAuditChain([e2], null).brokenAt).toBeNull();
    expect(checkAuditChain([e2], AUDIT_GENESIS).brokenAt).toBe(2);
    expect(checkAuditChain([e1, { ...e2, prev: "0".repeat(64) }], AUDIT_GENESIS).brokenAt).toBe(2);
    expect(checkAuditChain([e1, { ...e2, n: 3 }], AUDIT_GENESIS).brokenAt).toBe(3);
    // an entry that was changed shows at the one after it
    expect(checkAuditChain([{ ...e1, action: "other" }, e2], AUDIT_GENESIS).brokenAt).toBe(2);
  });
});

/** A gateway that keeps a log the way G2's does: a chain, read by `after`/`limit`/`tail`. */
function auditServer() {
  const state = { entries: [] as AuditRow[], seen: [] as Array<{ path: string; headers: Headers }>, last: "" };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      state.seen.push({ path: url.pathname + url.search, headers: req.headers });
      if (url.pathname === "/fleets/acme/audit") {
        const all = state.entries;
        const head = all.length ? { n: all[all.length - 1]!.n, hash: auditEntryHash(all[all.length - 1]!) } : { n: 0, hash: AUDIT_GENESIS };
        let rows: AuditRow[];
        if (url.searchParams.has("tail")) rows = all.slice(-Number(url.searchParams.get("tail")));
        else {
          const after = Number(url.searchParams.get("after") ?? 0);
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
          rows = all.filter((e) => e.n > after).slice(0, limit);
        }
        return Response.json({ ok: true, entries: rows, head, first: 1, limit: 500 });
      }
      if (url.pathname === "/fleets/acme/members") return Response.json({ ok: true, members: [] });
      return Response.json({ error: "no" }, { status: 404 });
    },
  });
  const add = (action: string, extra: Partial<AuditRow> = {}): void => {
    const prev = state.entries.length ? auditEntryHash(state.entries[state.entries.length - 1]!) : AUDIT_GENESIS;
    state.entries.push({ n: state.entries.length + 1, prev, at: 1_700_000_000_000 + state.entries.length * 1000, actor: { kind: "access", email: "me@tuanm.dev" }, action, ...extra });
  };
  return { state, add, url: "http://127.0.0.1:" + server.port, stop: () => server.stop(true) };
}

describe("prime fleets log", () => {
  let dir: string;
  let gw: ReturnType<typeof auditServer>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet-log-"));
    gw = auditServer();
  });
  afterAll(() => {
    gw.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    useAccessRunner(undefined);
    forgetAccessTokens();
  });

  const out: string[] = [];
  const run = (flags: Record<string, string | number | boolean> = {}, json = false) => {
    out.length = 0;
    return fleetsLog({
      config: { defaults: { gateway: gw.url, fleet_operator_token: "op" }, devices: {}, spaces: {}, codeMcp: {} },
      configPath: join(dir, "config.yaml"),
      json,
      out: (l: string) => out.push(l),
      parsed: { positionals: ["fleets", "log", "acme"], flags: new Map(Object.entries(flags)), help: false },
    } as never);
  };
  const said = () => out.join("\n");

  test("prints the newest entries and says the chain is intact", async () => {
    for (const a of ["fleet-created", "invite-created", "member-admitted", "published"]) gw.add(a, { target: a === "member-admitted" ? "dev-2" : undefined });
    await run();
    expect(said()).toContain("member-admitted");
    expect(said()).toContain("access:me@tuanm.dev");
    expect(said()).toContain("chain intact");
    expect(gw.state.seen.at(-1)!.path).toBe("/fleets/acme/audit?tail=50");
    expect(gw.state.seen.at(-1)!.headers.get("authorization")).toBe("Bearer op");
  });

  test("a page after a number, and every page with --all", async () => {
    await run({ after: 2, limit: 1 });
    expect(said()).toContain("member-admitted");
    expect(said()).not.toContain("invite-created");
    await run({ all: true });
    expect(said()).toContain("fleet-created");
    expect(said()).toContain("published");
  });

  test("the json carries the entries, the head and the verdict", async () => {
    const lines: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      await run({ tail: 2 }, true);
    } finally {
      (process.stdout as { write: unknown }).write = real;
    }
    const body = JSON.parse(lines.join("\n"));
    expect(body.verified).toBe(true);
    expect(body.entries.map((e: AuditRow) => e.n)).toEqual([3, 4]);
    expect(body.head.n).toBe(4);
  });

  test("an entry the gateway changed is found at the one after it, and the command fails", async () => {
    const saved = gw.state.entries[1]!;
    gw.state.entries[1] = { ...saved, action: "nothing-happened" };
    await expect(run({ all: true })).rejects.toThrow(/does not verify/);
    expect(said()).toContain("BROKEN");
    gw.state.entries[1] = saved;
  });

  test("an entry that was removed is found, too", async () => {
    const saved = [...gw.state.entries];
    gw.state.entries.splice(1, 1);
    await expect(run({ all: true })).rejects.toThrow(/does not verify/);
    gw.state.entries = saved;
  });

  test("a log cut back, or rewritten whole, since this machine last checked it is found", async () => {
    await run(); // remembers the head (entry 4)
    gw.add("published");
    await run({ after: 4 }); // follows the entry it remembers
    expect(said()).toContain("chain intact");
    const saved = [...gw.state.entries];
    gw.state.entries = saved.slice(0, 3); // cut back to entry 3
    await expect(run()).rejects.toThrow(/does not verify/);
    expect(said()).toContain("cut back");
    // rewritten from entry 3 on, as a gateway that kept its own copy might
    gw.state.entries = saved.slice(0, 2);
    gw.add("something-else");
    gw.add("another");
    gw.add("and-more");
    gw.add("and-more-still");
    gw.add("and-the-last");
    await expect(run({ all: true })).rejects.toThrow(/does not verify/);
    expect(said()).toContain("rewritten");
    gw.state.entries = saved;
  });

  test("with --sso the call carries the person's Access token and not the operator token", async () => {
    const calls: string[][] = [];
    const jwt = "aaaa.bbbb.cccc";
    useAccessRunner(async (cmd, args): Promise<AccessRun> => {
      calls.push([cmd, ...args]);
      return { code: 0, out: jwt + "\n" };
    });
    await run({ sso: true, tail: 1 });
    const seen = gw.state.seen.at(-1)!;
    expect(seen.headers.get("cf-access-token")).toBe(jwt);
    expect(seen.headers.get("authorization")).toBeNull();
    expect(calls[0]).toEqual(["cloudflared", "access", "token", "-app=" + gw.url + "/admin"]);
    expect(said()).not.toContain(jwt);
  });

  test("other commands take --sso too", async () => {
    useAccessRunner(async () => ({ code: 0, out: "aaaa.bbbb.cccc" }));
    await fleetsMembers({
      config: { defaults: { gateway: gw.url }, devices: {}, spaces: {}, codeMcp: {} },
      configPath: join(dir, "config.yaml"),
      json: false,
      out: () => undefined,
      parsed: { positionals: ["fleets", "members", "acme"], flags: new Map([["sso", true]]), help: false },
    } as never);
    expect(gw.state.seen.at(-1)!.headers.get("cf-access-token")).toBe("aaaa.bbbb.cccc");
  });
});

describe("the Access token", () => {
  afterEach(() => forgetAccessTokens());
  const jwt = "xxxx.yyyy.zzzz";

  test("is asked for first, and a login comes only when there is none", async () => {
    const calls: string[] = [];
    let loggedIn = false;
    const token = await accessToken("https://gw.example/", async (_cmd, args) => {
      calls.push(args[1]!);
      if (args[1] === "login") {
        loggedIn = true;
        return { code: 0, out: "" };
      }
      return loggedIn ? { code: 0, out: "\n" + jwt + "\n" } : { code: 1, out: "" };
    });
    expect(token).toBe(jwt);
    expect(calls).toEqual(["token", "login", "token"]);
    // kept for the rest of the run
    expect(await accessToken("https://gw.example", async () => ({ code: 1, out: "" }))).toBe(jwt);
  });

  test("a missing cloudflared is said, not a failure to log in", async () => {
    await expect(accessToken("https://gw.example", async () => ({ code: null, out: "", missing: true }))).rejects.toThrow(/not installed/);
  });

  test("an answer that is not a token is refused", async () => {
    await expect(accessToken("https://gw.example", async (_c, args) => (args[1] === "login" ? { code: 0, out: "" } : { code: 0, out: "login required" }))).rejects.toThrow(/no access token/);
  });
});
