// The set of deactivated ("disabled") devices, shared by every route that
// authenticates a device: the MCP relay and tunnel (index.ts) and the file and
// sandbox pages (files-routes.ts). Cached for the same short TTL as the device
// map and invalidated by the admin routes that change it.

import type { Env } from "./config";
import { validDeviceId } from "./config";

const CACHE_TTL_MS = 2_000;

let disabledCache: { at: number; set: Set<string> } | null = null;

export async function effectiveDisabledSet(env: Env): Promise<Set<string>> {
  if (disabledCache && Date.now() - disabledCache.at < CACHE_TTL_MS) return disabledCache.set;
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
  const set = new Set<string>();
  try {
    const r = await reg.fetch("https://registry/disabled");
    if (r.ok) {
      const j = (await r.json()) as { disabled?: string[] };
      for (const id of j.disabled || []) {
        if (validDeviceId(id)) set.add(id);
      }
    }
  } catch {}
  disabledCache = { at: Date.now(), set };
  return set;
}

export function invalidateDisabledCache(): void {
  disabledCache = null;
}
