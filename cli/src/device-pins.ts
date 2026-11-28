// The device keys this machine has seen answer: the first reply signature from a device pins its key
// (trust on first use), and a different key later is reported. A device that signs its replies lets
// the caller tell that the device, and not the gateway relaying for it, produced the answer.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { keyIdOf } from "./caller-key.ts";

export function devicePinsPath(): string {
  const override = process.env.PRIME_DEVICE_KEYS;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".prime", "device-keys.json");
}

export type PinVerdict = "pinned" | "same" | "changed";

function readPins(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
    }
  } catch {}
  return {};
}

/** The pinned key of a device (raw, base64), if there is one. */
export function pinnedDeviceKey(gateway: string, deviceId: string, path: string = devicePinsPath()): string | undefined {
  return readPins(path)[`${deviceId}@${gateway}`];
}

/** Pin the key a device signed with if it has none yet; say whether it is the key already pinned. */
export function checkDeviceKey(gateway: string, deviceId: string, pub: Buffer, path: string = devicePinsPath()): PinVerdict {
  const pins = readPins(path);
  const name = `${deviceId}@${gateway}`;
  const given = pub.toString("base64");
  const known = pins[name];
  if (known === undefined) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, JSON.stringify({ ...pins, [name]: given }, null, 2) + "\n", 0o600);
    return "pinned";
  }
  return known === given ? "same" : "changed";
}

export function deviceKeyLabel(pub: Buffer): string {
  return keyIdOf(pub);
}
