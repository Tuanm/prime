import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, type Config } from "../src/config";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

describe("what `prime update` needs of a space survives a save", () => {
  test("the entrypoint a container was made with, and what the person allowed, are read back", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-config-"));
    const path = join(dir, "config.yaml");
    try {
      const config: Config = {
        defaults: {},
        devices: {},
        spaces: { work: { id: "space-1", runtime: "docker", image: "img", mode: "ephemeral", container: "c", token: "t", fleet: "acme", entrypoint: 2, allow_rootful: true, allow_no_limits: true } },
        codeMcp: {},
      };
      saveConfig(path, config);
      expect(loadConfig(path).spaces.work).toMatchObject({ entrypoint: 2, allow_rootful: true, allow_no_limits: true });
      // taken back by a start that is given no flag: gone from the file, not kept by the merge with what was there
      const again = loadConfig(path);
      again.spaces.work!.allow_rootful = undefined;
      again.spaces.work!.allow_no_limits = undefined;
      saveConfig(path, again);
      const last = loadConfig(path).spaces.work!;
      expect(last.allow_rootful).toBeUndefined();
      expect(last.allow_no_limits).toBeUndefined();
      expect(last.entrypoint).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
