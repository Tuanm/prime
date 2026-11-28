import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../src/context";
import { setupFleetSpace } from "../src/fleet-space";
import { fleetStateDir, readFleetState, recordPublished, writeFleetState } from "../src/fleets";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/** A gateway that says this device is not a member, takes its join, and never admits it. */
function gateway(status: "member" | "none") {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      calls.push(req.method + " " + path);
      if (req.method === "GET" && path.endsWith("/me")) return Response.json({ status }, { status: status === "member" ? 200 : 404 });
      if (req.method === "POST" && path.endsWith("/join")) return Response.json({ ok: true });
      return Response.json({ member: false });
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: "http://127.0.0.1:" + server.port, calls };
}

function config(): string {
  const root = mkdtempSync(join(tmpdir(), "fleet-space-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "config.yaml");
}

function ctxFor(configPath: string): Ctx {
  return { configPath, config: {}, parsed: {}, json: false, quiet: true, verbose: false, color: false, out() {}, note() {} } as unknown as Ctx;
}

const options = (gw: string) => ({
  fleet: "x",
  spaceName: "r1",
  gateway: gw,
  deviceId: "dev",
  deviceToken: "tok",
  code: "invite",
  create: false,
  approvalWaitMs: 0,
});

describe("a space that joins a fleet", () => {
  test("starts from nothing: the position and the unwritten publish of an earlier fleet under the name are forgotten", async () => {
    const path = config();
    writeFleetState(path, "x", "r1", { seq: 40, base: "a".repeat(40), tree: "t", roster: "r" });
    recordPublished(path, "x", "r1", { seq: 41, base: "b".repeat(40) });
    expect(readFleetState(path, "x", "r1").seq).toBe(41);
    const gw = gateway("none");
    const setup = await setupFleetSpace(ctxFor(path), options(gw.url));
    expect(setup.role).toBe("pending");
    expect(gw.calls).toContain("POST /fleets/x/join");
    expect(readFleetState(path, "x", "r1")).toEqual({});
    expect(existsSync(join(fleetStateDir(path, "x", "r1"), "published.json"))).toBe(false);
  });

  test("a device that is a member already keeps its position", async () => {
    const path = config();
    writeFleetState(path, "x", "r1", { seq: 40, base: "a".repeat(40) });
    const gw = gateway("member");
    await setupFleetSpace(ctxFor(path), { ...options(gw.url), waitMs: 0 }).catch(() => undefined);
    expect(gw.calls).not.toContain("POST /fleets/x/join");
    expect(readFleetState(path, "x", "r1").seq).toBe(40);
  });
});
