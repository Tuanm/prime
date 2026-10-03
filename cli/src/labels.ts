// Resolution of the `<device-id>.<tool-id>` label.
//
// Both halves may legally contain dots (device ids allow `[A-Za-z0-9._-]` and
// tool names are arbitrary), so a plain `split(".")` is ambiguous. Resolution
// order:
//   1. longest configured device id that prefixes the label (`a.b.c` -> device `a.b`)
//   2. otherwise the text before the first dot
//   3. a bare name with exactly one device configured is treated as that device's tool
// Explicit --device / --tool flags always win.

import { UsageError } from "./errors.ts";

export interface ResolvedLabel {
  deviceId: string;
  toolName: string;
}

export function splitLabel(label: string, knownDeviceIds: string[]): ResolvedLabel {
  const trimmed = label.trim();
  if (trimmed.length === 0) throw new UsageError("empty tool reference");

  // 1. longest configured device prefix
  const candidates = knownDeviceIds.filter((id) => trimmed.startsWith(`${id}.`)).sort((a, b) => b.length - a.length);
  if (candidates.length > 0) {
    const deviceId = candidates[0]!;
    return { deviceId, toolName: trimmed.slice(deviceId.length + 1) };
  }

  // 2. first dot
  const index = trimmed.indexOf(".");
  if (index > 0 && index < trimmed.length - 1) {
    return { deviceId: trimmed.slice(0, index), toolName: trimmed.slice(index + 1) };
  }

  // 3. bare tool name with a single configured device
  if (index === -1 && knownDeviceIds.length === 1) {
    return { deviceId: knownDeviceIds[0]!, toolName: trimmed };
  }

  if (index === -1) {
    throw new UsageError(
      `"${trimmed}" is not a <device-id>.<tool-id> reference`,
      "Use the form <device-id>.<tool-id>, e.g. 'mcp tools view my-device.snapshot'.",
    );
  }
  throw new UsageError(`invalid tool reference "${trimmed}"`);
}
