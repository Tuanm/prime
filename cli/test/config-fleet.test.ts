import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, type Config } from "../src/config";

describe("the fleet fields of a space survive a save", () => {
  test("a space in a fleet keeps its fleet, its role and its work directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-config-"));
    const path = join(dir, "config.yaml");
    try {
      const config: Config = {
        defaults: {},
        devices: {},
        spaces: {
          work: {
            id: "space-1",
            runtime: "apple",
            image: "img",
            mode: "ephemeral",
            container: "prime-space-1",
            token: "t",
            fleet: "acme",
            fleet_role: "primary",
            work_dir: "/tmp/work",
          },
        },
        codeMcp: {},
      };
      saveConfig(path, config);
      const loaded = loadConfig(path);
      expect(loaded.spaces.work?.fleet).toBe("acme");
      expect(loaded.spaces.work?.fleet_role).toBe("primary");
      expect(loaded.spaces.work?.work_dir).toBe("/tmp/work");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a space that is not in a fleet has no fleet fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-config-"));
    const path = join(dir, "config.yaml");
    try {
      writeFileSync(
        path,
        "devices: {}\nspaces:\n  plain:\n    id: space-2\n    runtime: apple\n    image: img\n    mode: ephemeral\n    container: c\n    token: t\n",
      );
      const loaded = loadConfig(path);
      expect(loaded.spaces.plain?.fleet).toBeUndefined();
      expect(loaded.spaces.plain?.work_dir).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
