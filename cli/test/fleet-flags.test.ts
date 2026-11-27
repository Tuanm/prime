import { describe, expect, test } from "bun:test";
import { bool, parseArgs, str } from "../src/args";
import { fleetFlagsFor } from "../src/fleet-flags";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

// The argv `prime fleets <sub> ...` is parsed with, as the entry point parses it.
const parse = (sub: string, ...rest: string[]) => parseArgs(["fleets", sub, ...rest], fleetFlagsFor(sub));

describe("the flags of `prime fleets`", () => {
  test("`agent uninstall --force` is accepted, with the configuration it is run for", () => {
    const parsed = parse("agent", "uninstall", "--force", "--config", "/tmp/x.yaml");
    expect(bool(parsed, "force")).toBe(true);
    expect(parsed.positionals).toEqual(["fleets", "agent", "uninstall"]);
    expect(str(parsed, "config")).toBe("/tmp/x.yaml");
    // Without it, it is off.
    expect(bool(parse("agent", "uninstall"), "force")).toBe(false);
  });

  test("the other subcommands keep their flags, and still refuse the ones that are not theirs", () => {
    expect(bool(parse("sync", "x", "--space", "s", "--force"), "force")).toBe(true);
    expect(str(parse("join", "x", "--code", "c"), "code")).toBe("c");
    expect(() => parse("invite", "x", "--force")).toThrow(/unknown option/);
    expect(() => parse("agent", "start", "--watch")).toThrow(/unknown option/);
  });

  test("`approve --key` and `remove --key-change` are accepted, each by its own command", () => {
    const approve = parse("approve", "acme", "--member", "dev-1", "--key", "AAAAAAAAAAA=");
    expect(str(approve, "member")).toBe("dev-1");
    expect(str(approve, "key")).toBe("AAAAAAAAAAA=");
    const remove = parse("remove", "acme", "--member", "dev-1", "--key-change");
    expect(bool(remove, "key-change")).toBe(true);
    expect(bool(parse("remove", "acme", "--member", "dev-1"), "key-change")).toBe(false);
    expect(() => parse("approve", "acme", "--member", "dev-1", "--key-change")).toThrow(/unknown option/);
    expect(() => parse("remove", "acme", "--member", "dev-1", "--key", "x")).toThrow(/unknown option/);
  });

  test("`rotate-key`, `pending` and the operator's token take the common flags", () => {
    expect(str(parse("rotate-key", "acme", "--space", "work"), "space")).toBe("work");
    expect(str(parse("pending", "acme", "--operator-token", "op"), "operator-token")).toBe("op");
  });
});
