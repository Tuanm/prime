// The device keys this machine has seen answer: the first reply signature from a device pins its key
// (trust on first use), and a different key later is refused. A device that signs its replies lets
// the caller tell that the device, and not the gateway relaying for it, produced the answer. The pinned
// key can be compared out of band with the one the device shows (`prime devices callers`).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { withDirLockSync } from "./dir-lock.ts";
import { keyIdOf } from "./caller-key.ts";

export function devicePinsPath(): string {
  const override = process.env.PRIME_DEVICE_KEYS;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".prime", "device-keys.json");
}

export type PinVerdict = "pinned" | "same" | "changed";

/** The pins file cannot be read as pins. It is left as it is: replacing it would forget every other device's key. */
export class PinsFileError extends Error {}

function readPins(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new PinsFileError(`${path} is not valid JSON; fix or delete it (device keys are not pinned until then)`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PinsFileError(`${path} does not hold an object of pinned device keys; fix or delete it`);
  }
  const pins: Record<string, string> = {};
  for (const [name, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key !== "string") throw new PinsFileError(`${path} has a pin for ${name} that is not a key; fix or delete it`);
    pins[name] = key;
  }
  return pins;
}

const pinName = (gateway: string, deviceId: string) => `${deviceId}@${gateway}`;

/** The pinned key of a device (raw, base64), if there is one. Throws PinsFileError when the file is damaged. */
export function pinnedDeviceKey(gateway: string, deviceId: string, path: string = devicePinsPath()): string | undefined {
  return readPins(path)[pinName(gateway, deviceId)];
}

function updatePins<T>(path: string, change: (pins: Record<string, string>) => { pins?: Record<string, string>; result: T }): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Read again under the lock, so two prime processes keep each other's pins.
  return withDirLockSync(
    `${path}.lock`,
    () => {
      const { pins, result } = change(readPins(path));
      if (pins) writeFileAtomic(path, JSON.stringify(pins, null, 2) + "\n", 0o600, { durable: true });
      return result;
    },
    { waitMs: 10_000, staleMs: 60_000 },
  );
}

/** Pin the key a device signed with if it has none yet; say whether it is the key already pinned. */
export function checkDeviceKey(gateway: string, deviceId: string, pub: Buffer, path: string = devicePinsPath()): PinVerdict {
  const name = pinName(gateway, deviceId);
  const given = pub.toString("base64");
  return updatePins(path, (pins) => {
    const known = pins[name];
    if (known === undefined) return { pins: { ...pins, [name]: given }, result: "pinned" as PinVerdict };
    return { result: (known === given ? "same" : "changed") as PinVerdict };
  });
}

/** Stop trusting what was pinned for a device (it will be pinned again at its next signed reply). */
export function forgetDeviceKey(gateway: string, deviceId: string, path: string = devicePinsPath()): boolean {
  const name = pinName(gateway, deviceId);
  return updatePins(path, (pins) => {
    if (!(name in pins)) return { result: false };
    const { [name]: _gone, ...rest } = pins;
    return { pins: rest, result: true };
  });
}

export function deviceKeyLabel(pub: Buffer): string {
  return keyIdOf(pub);
}
