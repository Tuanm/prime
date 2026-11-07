import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LANDING_HTML } from "../src/landing-page";

const script = /<script>([\s\S]*)<\/script>/.exec(LANDING_HTML)?.[1] ?? "";

describe("landing page", () => {
  test("is a complete page with the gateway's favicon", () => {
    expect(LANDING_HTML.startsWith("<!doctype html>")).toBe(true);
    expect(LANDING_HTML).toContain('<link rel="icon" href="data:image');
    expect(LANDING_HTML).not.toContain("__FAVICON__");
    expect(LANDING_HTML).toContain('id="connect"');
    expect(LANDING_HTML).toContain('aria-haspopup="menu"');
  });

  test("its script parses", () => {
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });

  test("offers exactly the platforms the CLI is built for", () => {
    // The page builds asset names as prime-<version>-<id>[.exe]: the ids must be
    // the CLI's build targets, or Connect would point at a file that does not exist.
    const build = readFileSync(join(import.meta.dir, "..", "..", "cli", "scripts", "build.ts"), "utf8");
    const targets = [...build.matchAll(/out: "prime-([a-z0-9-]+?)(\.exe)?"/g)].map((m) => m[1]).sort();
    const offered = [...script.matchAll(/\{ id: "([a-z0-9-]+)"/g)].map((m) => m[1]).filter((id) => id !== "bundle").sort();
    expect(targets.length).toBe(6);
    expect(offered).toEqual(targets);
  });

  test("reads the version from prime-v<version> tags", () => {
    expect(script).toContain('rel.tag_name.slice("prime-v".length)');
    expect(script).toContain('/^prime-v/');
  });
});
