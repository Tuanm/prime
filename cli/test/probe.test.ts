import { describe, expect, test } from "bun:test";
import { pickPowerShell, probeExits, windowsPowerShellPath } from "../src/probe";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

describe("a look for a program on the path", () => {
  test("is true on exit 0, false on another exit, and says nothing of either", () => {
    const said: string[] = [];
    expect(probeExits(["x"], "bash", 5000, () => ({ exitCode: 0 }), (l) => said.push(l))).toBe(true);
    expect(probeExits(["x"], "bash", 5000, () => ({ exitCode: 1 }), (l) => said.push(l))).toBe(false);
    expect(said).toEqual([]);
  });

  test("that ran out of time is false, and a line says it was a doubt and for which program", () => {
    const said: string[] = [];
    expect(probeExits(["x"], "powershell", 15_000, () => ({ exitCode: null, exitedDueToTimeout: true }), (l) => said.push(l))).toBe(false);
    expect(said.length).toBe(1);
    expect(said[0]).toContain("powershell");
    expect(said[0]).toContain("15 s");
    expect(said[0]).toContain("not found");
  });

  test("that could not be started is false, with a line", () => {
    const said: string[] = [];
    const broke = (): never => {
      throw new Error("no sh");
    };
    expect(probeExits(["x"], "rg", 5000, broke, (l) => said.push(l))).toBe(false);
    expect(said[0]).toContain("no sh");
  });
});

describe("the PowerShell code-mcp uses", () => {
  const env = { SystemRoot: "C:\\Win" };
  test("is Windows PowerShell by its fixed place when the look along the path ran out of time, so that it is not cmd", () => {
    const asked: string[] = [];
    const slow = (bin: string): boolean => (asked.push(bin), false); // `where` gave up on both
    const fixed = windowsPowerShellPath(env);
    expect(fixed.replace(/\\/g, "/")).toContain("Win/System32/WindowsPowerShell/v1.0/powershell.exe");
    expect(pickPowerShell(slow, true, (p) => p === fixed, env)).toBe("powershell");
    // The fixed place is looked at before `where powershell` is run, so that look is not needed at all.
    expect(asked).toEqual(["pwsh"]);
  });

  test("is pwsh when it is found, nothing when nothing is, and only the path is asked off Windows", () => {
    expect(pickPowerShell((b) => b === "pwsh", true, () => true, env)).toBe("pwsh");
    expect(pickPowerShell(() => false, true, () => false, env)).toBeNull();
    expect(pickPowerShell((b) => b === "powershell", true, () => false, env)).toBe("powershell");
    const asked: string[] = [];
    expect(pickPowerShell((b) => (asked.push(b), false), false, () => true, env)).toBeNull();
    expect(asked).toEqual(["pwsh", "powershell"]);
  });
});
