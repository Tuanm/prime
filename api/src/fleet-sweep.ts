/**
 * The daily sweep of what fleets leave in the bucket.
 *
 * A publish that is refused, or whose publisher dies, leaves a pack or a manifest that no snapshot names, and a
 * fleet that was deleted while the bucket was out of reach leaves everything. Nothing else ever removes them, and
 * they cost storage for as long as the account lives. Once a day the gateway lists what each fleet has stored,
 * asks the fleet's object which of the older objects it keeps, and deletes the rest.
 *
 * Deleting a live object is the one way this can do harm, so everything here leans the other way:
 *  - an object is only a candidate when it is older than an hour (a publish in flight stores its objects first and
 *    names them second), and the object keeps its own `storing` list and the head's objects whatever it remembers;
 *  - only `packs/` and `manifests/` of a fleet that exists are touched, never its head or its `audit/` record;
 *  - a fleet that is not in the registry is cleared only when its object says it does not exist, and only the
 *    objects of it that are older than a day;
 *  - anything that cannot be read (the registry, the object, the bucket) leaves the fleet alone for today;
 *  - a run deletes at most 1,000 objects of one fleet and 10,000 in all.
 */
import type { Env } from "./config";
import { countFleetR2 } from "./usage";

export const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;
export const SWEEP_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
export const SWEEP_PER_FLEET = 1000;
export const SWEEP_TOTAL = 10_000;
// Pages of a listing (1,000 objects each) read for one fleet, and of fleet prefixes read in all.
const LIST_PAGES_PER_FLEET = 30;
const LIST_PAGES_PREFIXES = 20;

export interface SweepOptions {
  /** Count what would be deleted and delete nothing. */
  dryRun?: boolean;
  now?: number;
}

export interface SweepReport {
  dryRun: boolean;
  /** Fleets of the registry looked at. */
  fleets: number;
  /** Objects of existing fleets that nothing keeps. */
  orphans: number;
  /** Objects of fleets that no longer exist. */
  goneObjects: number;
  /** Fleets (no longer existing) that were cleared. */
  goneFleets: number;
  /** Whether a cap stopped the run early, so that the rest waits for tomorrow. */
  capped: boolean;
  /** What could not be read: a fleet or a prefix that was left alone. */
  skipped: Array<{ fleet: string; why: string }>;
}

// Which objects of a fleet the sweep may touch.
const SWEEPABLE = /\/(packs|manifests)\/[0-9a-f]{64}$/;

function adminHeaders(fleetId: string): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-prime-caller", "admin");
  headers.set("x-prime-fleet", fleetId);
  return headers;
}

export async function sweepFleets(env: Env, options: SweepOptions = {}): Promise<SweepReport> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? Date.now();
  const report: SweepReport = { dryRun, fleets: 0, orphans: 0, goneObjects: 0, goneFleets: 0, capped: false, skipped: [] };
  const bucket = env.BUCKET;
  const namespace = env.FLEET;
  if (!bucket || !namespace || !env.REGISTRY) return report;

  // Which fleets there are. Without that, nothing is known to be an orphan.
  let registered: string[];
  try {
    const answer = await env.REGISTRY.get(env.REGISTRY.idFromName("global")).fetch("https://registry/fleets");
    if (!answer.ok) throw new Error("registry " + answer.status);
    registered = ((await answer.json()) as { fleets?: string[] }).fleets ?? [];
  } catch {
    report.skipped.push({ fleet: "*", why: "the registry could not be read" });
    return report;
  }

  let budget = SWEEP_TOTAL;

  const remove = async (keys: string[]): Promise<void> => {
    for (let at = 0; at < keys.length; at += 1000) {
      const batch = keys.slice(at, at + 1000);
      countFleetR2("write");
      await bucket.delete(batch);
    }
  };

  // ---- Fleets that exist: what none of their snapshots keeps ------------------------------------------------
  for (const fleetId of registered) {
    if (budget <= 0) {
      report.capped = true;
      break;
    }
    report.fleets += 1;
    try {
      const candidates: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIST_PAGES_PER_FLEET; page++) {
        countFleetR2("write"); // a listing is a Class A operation
        const listed = await bucket.list({ prefix: "fleets/" + fleetId + "/", limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const o of listed.objects) {
          if (SWEEPABLE.test(o.key) && now - o.uploaded.getTime() >= SWEEP_MIN_AGE_MS) candidates.push(o.key);
        }
        if (!listed.truncated) break;
        cursor = listed.cursor;
        if (page === LIST_PAGES_PER_FLEET - 1) report.capped = true;
      }
      if (candidates.length === 0) continue;

      const stub = namespace.get(namespace.idFromName(fleetId));
      const doomed: string[] = [];
      for (let at = 0; at < candidates.length; at += 1000) {
        const asked = await stub.fetch("https://fleet/unreferenced", {
          method: "POST",
          headers: adminHeaders(fleetId),
          body: JSON.stringify({ keys: candidates.slice(at, at + 1000) }),
        });
        if (!asked.ok) throw new Error("the fleet answered " + asked.status);
        const answer = (await asked.json()) as { exists?: boolean; keys?: unknown };
        // A fleet the registry lists but the object does not know is left to be sorted out, not swept.
        if (answer.exists !== true) throw new Error("the fleet's object does not know the fleet");
        for (const key of Array.isArray(answer.keys) ? answer.keys : []) if (typeof key === "string") doomed.push(key);
      }
      const take = doomed.slice(0, Math.min(SWEEP_PER_FLEET, budget));
      if (take.length < doomed.length) report.capped = true;
      if (!dryRun) {
        await remove(take);
        // The fleet's own log says what was cleared from it. Best effort: the objects are gone either way.
        if (take.length > 0) {
          const headers = adminHeaders(fleetId);
          headers.set("x-prime-actor", "gateway");
          await stub.fetch("https://fleet/note", { method: "POST", headers, body: JSON.stringify({ action: "bucket-swept", count: take.length }) }).catch(() => undefined);
        }
      }
      report.orphans += take.length;
      budget -= take.length;
    } catch (error) {
      report.skipped.push({ fleet: fleetId, why: error instanceof Error ? error.message : String(error) });
    }
  }

  // ---- Fleets that are gone: what is left under their names ----------------------------------------------------
  try {
    const known = new Set(registered);
    const prefixes: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGES_PREFIXES; page++) {
      countFleetR2("write");
      const listed = await bucket.list({ prefix: "fleets/", delimiter: "/", limit: 1000, ...(cursor ? { cursor } : {}) });
      prefixes.push(...(listed.delimitedPrefixes ?? []));
      if (!listed.truncated) break;
      cursor = listed.cursor;
      if (page === LIST_PAGES_PREFIXES - 1) report.capped = true;
    }
    for (const prefix of prefixes) {
      const fleetId = prefix.slice("fleets/".length).replace(/\/$/, "");
      if (!fleetId || known.has(fleetId)) continue;
      if (budget <= 0) {
        report.capped = true;
        break;
      }
      try {
        const asked = await namespace.get(namespace.idFromName(fleetId)).fetch("https://fleet/exists", { method: "GET", headers: adminHeaders(fleetId) });
        if (!asked.ok) throw new Error("the fleet answered " + asked.status);
        // A fleet the registry does not list but which exists (a registration that is still on its way) is not gone.
        if (((await asked.json()) as { exists?: boolean }).exists !== false) continue;

        const old: string[] = [];
        let more: string | undefined;
        let young = false;
        for (let page = 0; page < LIST_PAGES_PER_FLEET; page++) {
          countFleetR2("write");
          const listed = await bucket.list({ prefix, limit: 1000, ...(more ? { cursor: more } : {}) });
          for (const o of listed.objects) {
            if (now - o.uploaded.getTime() >= SWEEP_ORPHAN_AGE_MS) old.push(o.key);
            else young = true;
          }
          if (!listed.truncated) break;
          more = listed.cursor;
          if (page === LIST_PAGES_PER_FLEET - 1) report.capped = true;
        }
        const take = old.slice(0, budget);
        if (take.length < old.length) report.capped = true;
        if (!dryRun) await remove(take);
        report.goneObjects += take.length;
        budget -= take.length;
        if (!young && take.length === old.length && take.length > 0) report.goneFleets += 1;
      } catch (error) {
        report.skipped.push({ fleet: fleetId, why: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    report.skipped.push({ fleet: "*", why: "the fleets in the bucket could not be listed: " + (error instanceof Error ? error.message : String(error)) });
  }
  return report;
}
