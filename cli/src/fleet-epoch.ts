// Epoch keys: a member makes a new X25519 pair every day or so, tells the fleet its public half (signed with its signing key), and
// deletes the private half of an old one once it has taken in a snapshot wrapped to a newer one. The primary wraps each snapshot's
// key to the members' newest epoch keys, so a copy of a key file taken later opens the snapshots of the epochs still on it, not
// every snapshot the gateway still holds.
//
// What the gateway says of a member's epoch key is checked here: the signature is the member's, made with the signing key the
// fleet's signed roster names for it (a fleet with no signed roster has only the gateway's word for that key, as it has for the
// member's sealing key). `PRIME_FLEET_EPOCH=off` stops a build making keys and wrapping to them; what it holds still opens snapshots.

import { createPrivateKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { publicKeyFromRaw } from "./caller-key";
import { generateEpochKey, type EpochKey } from "./fleet-crypto";
import { updateKeyFile, readKeyPair } from "./fleet-keyfile";
import { EPOCH_CAP, postEpochKey, fetchRole, type FleetCredentials, type PostedEpochKey } from "./fleet-transport";

export const EPOCH_ENTRY = "prime-epoch-v1";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The most the gateway lets a key last (31 days), less a day for a clock that is off. */
const NOT_AFTER_MAX_MS = 30 * DAY_MS;
/** A key is not wrapped to when it has less than this left: the member would be asked to open it just as it was let go of. */
const NOT_AFTER_MARGIN_MS = 10 * 60_000;
/**
 * How long a private half is kept once a snapshot wrapped to a newer epoch has been taken in: a publisher that had not yet been told of the
 * new key may still wrap one more snapshot to the old one, and this is the time it has to arrive.
 */
export const EPOCH_GRACE_MS = 30 * 60_000;
const B64_32_RE = /^[A-Za-z0-9+/]{43}=$/;
const B64URL_64_RE = /^[A-Za-z0-9_-]{86}$/;

export interface EpochSettings {
  enabled: boolean;
  /** How long an epoch key is made for. */
  lengthMs: number;
  /** How many snapshots taken in make a new one before that. */
  snapshots: number;
}

export function epochSettings(env: Record<string, string | undefined> = process.env): EpochSettings {
  const off = /^(off|0|false|no)$/i.test(env.PRIME_FLEET_EPOCH ?? "");
  const hours = Number(env.PRIME_FLEET_EPOCH_HOURS);
  return {
    enabled: !off,
    // Not under an hour (the gateway takes a key every five minutes at most), not over a week.
    lengthMs: (Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : 24) * HOUR_MS,
    snapshots: 256,
  };
}

/** What is signed of an epoch key: the array, as JSON (the form the gateway checks). */
export function epochEntry(fleet: string, incarnation: string, device: string, n: number, pub: string, notAfter: number): [string, string, string, string, number, string, number] {
  return [EPOCH_ENTRY, fleet, incarnation, device, n, pub, notAfter];
}

/** The signature of a member's signing key (PEM) over an epoch entry. */
export function signEpochEntry(entry: readonly unknown[], signPrivateKeyPem: string): string {
  return cryptoSign(null, Buffer.from(JSON.stringify(entry), "utf8"), createPrivateKey(signPrivateKeyPem)).toString("base64url");
}

/** Whether `key` is this device's epoch key for this fleet, signed by `spub` (base64url), and still good for a while. */
export function epochKeyHolds(
  key: PostedEpochKey,
  who: { fleet: string; incarnation: string; device: string; spub: string },
  now: number,
): boolean {
  if (!B64_32_RE.test(key.pub) || !B64URL_64_RE.test(key.sig) || key.notAfter < now + NOT_AFTER_MARGIN_MS) return false;
  try {
    const entry = epochEntry(who.fleet, who.incarnation, who.device, key.n, key.pub, key.notAfter);
    return cryptoVerify(null, Buffer.from(JSON.stringify(entry), "utf8"), publicKeyFromRaw(Buffer.from(who.spub, "base64url")), Buffer.from(key.sig, "base64url"));
  } catch {
    return false;
  }
}

const warnedBadEpoch = new Set<string>();

/**
 * The members to wrap to an epoch key, and which one. `signing` is the signing key each device has in the fleet's signed roster
 * (null for a fleet that has none: the gateway's `spub` is used, which is only as good as the gateway). A key whose signature does not
 * hold is said once, and that member is wrapped to as it was before.
 */
export function epochsToWrapTo(
  members: ReadonlyArray<{ deviceId: string; spub?: string; epochKey?: PostedEpochKey; caps?: string[] }>,
  signing: ReadonlyMap<string, string> | null,
  fleet: string,
  incarnation: string | undefined,
  now: number = Date.now(),
  settings: EpochSettings = epochSettings(),
): Map<string, { n: number; publicKey: string }> {
  const out = new Map<string, { n: number; publicKey: string }>();
  if (!settings.enabled || incarnation === undefined) return out;
  for (const m of members) {
    // A member that does not list the cap is a build that reads an epoch-wrapped snapshot as damaged (a rollback after it posted a key): wrapped as it always was.
    if (!m.epochKey || m.caps?.includes(EPOCH_CAP) !== true) continue;
    const spub = signing ? signing.get(m.deviceId) : m.spub;
    if (spub !== undefined && epochKeyHolds(m.epochKey, { fleet, incarnation, device: m.deviceId, spub }, now)) {
      out.set(m.deviceId, { n: m.epochKey.n, publicKey: m.epochKey.pub });
      continue;
    }
    // Expired is the ordinary end of a member that went away; only a key that was never good is worth saying.
    if (m.epochKey.notAfter >= now + NOT_AFTER_MARGIN_MS && !warnedBadEpoch.has(fleet + " " + m.deviceId + " " + m.epochKey.n)) {
      warnedBadEpoch.add(fleet + " " + m.deviceId + " " + m.epochKey.n);
      process.stderr.write("prime: fleet " + fleet + ": the epoch key listed for " + m.deviceId + " is not signed by its signing key: it is wrapped to its own key instead\n");
    }
  }
  return out;
}

// ---- what the key file holds -------------------------------------------------------------------------------------------

/** The epoch keys in the file, oldest first. */
export function readEpochs(keyFile: string): EpochKey[] {
  try {
    return readKeyPair(keyFile)?.epochs ?? [];
  } catch {
    return [];
  }
}

const takenIn = new Map<string, number>();

/** A snapshot was taken in (counted towards `settings.snapshots`). */
export function countTakenIn(keyFile: string): void {
  takenIn.set(keyFile, (takenIn.get(keyFile) ?? 0) + 1);
}

/**
 * A snapshot wrapped to epoch `n` has been taken in (or published, for the member that made it): every older epoch is let go of after a
 * short while, and then its private half is deleted (see `pruneEpochs`). A snapshot not wrapped to an epoch says nothing.
 */
export function noteEpochTakenIn(keyFile: string, n: number | undefined, now: number = Date.now()): void {
  countTakenIn(keyFile);
  if (n === undefined) return;
  updateKeyFile(keyFile, (pair) => {
    const next = epochsAfterTakenIn(pair.epochs ?? [], n, now);
    return next === undefined ? undefined : { ...pair, epochs: next };
  });
  pruneEpochs(keyFile, now);
}

/** `epochs` once a snapshot wrapped to epoch `n` has been taken in at `now`: every older one is marked as let go of; undefined when none was to be. */
export function epochsAfterTakenIn(epochs: readonly EpochKey[], n: number, now: number): EpochKey[] | undefined {
  if (!epochs.some((e) => e.n < n && e.supersededAt === undefined)) return undefined;
  return epochs.map((e) => (e.n < n && e.supersededAt === undefined ? { ...e, supersededAt: now } : e));
}

/** The epoch keys to keep at `now`: not one that a newer was taken in over for the grace time, nor one older than the hard limit; never the newest. */
export function epochsAfterPrune(epochs: readonly EpochKey[], now: number, settings: EpochSettings = epochSettings()): EpochKey[] {
  if (epochs.length === 0) return [];
  const newest = Math.max(...epochs.map((e) => e.n));
  const hard = 2 * settings.lengthMs + 7 * DAY_MS;
  return epochs.filter((e) => e.n === newest || !((e.supersededAt !== undefined && now - e.supersededAt >= EPOCH_GRACE_MS) || now - e.createdAt >= hard));
}

/**
 * Delete the private half of every epoch key that a newer one has been taken in over for the grace time, and any that is older than
 * twice the epoch's length and a week whatever (a member away that long takes a whole tree wrapped to its newer key). The newest key is never
 * deleted here. Returns how many were deleted.
 */
export function pruneEpochs(keyFile: string, now: number = Date.now(), settings: EpochSettings = epochSettings()): number {
  let gone = 0;
  updateKeyFile(keyFile, (pair) => {
    const epochs = pair.epochs;
    if (!epochs || epochs.length === 0) return undefined;
    const keep = epochsAfterPrune(epochs, now, settings);
    gone = epochs.length - keep.length;
    if (gone === 0) return undefined;
    const { epochs: _old, ...rest } = pair;
    return keep.length > 0 ? { ...rest, epochs: keep } : rest;
  });
  return gone;
}

/**
 * Make the next epoch key when it is time (none yet, or the newest has been posted and is as old as an epoch, or as many snapshots
 * have been taken in as one is for). A key not yet posted is not followed by another: it is posted first.
 */
export function ensureEpoch(keyFile: string, now: number = Date.now(), settings: EpochSettings = epochSettings()): EpochKey | undefined {
  if (!settings.enabled) return undefined;
  const pair = updateKeyFile(keyFile, (p) => {
    const epochs = p.epochs ?? [];
    const newest = epochs.length > 0 ? epochs.reduce((a, b) => (b.n > a.n ? b : a)) : undefined;
    const due = newest === undefined || (newest.posted !== undefined && (now - newest.createdAt >= settings.lengthMs || (takenIn.get(keyFile) ?? 0) >= settings.snapshots));
    if (!due) return undefined;
    takenIn.set(keyFile, 0);
    return { ...p, epochs: [...epochs, generateEpochKey((newest?.n ?? 0) + 1, now)] };
  });
  return pair?.epochs?.reduce<EpochKey | undefined>((a, b) => (a === undefined || b.n > a.n ? b : a), undefined);
}

// ---- telling the fleet -----------------------------------------------------------------------------------------------------

/** When each fleet's key file was last looked at, and a gateway that said it has no such route. */
const lastTick = new Map<string, number>();
const notBefore = new Map<string, number>();
const TICK_MS = 60_000;
const NO_ROUTE_MS = HOUR_MS;
/** A signed entry with less than this left to run is signed again (the fleet would take it for a key about to lapse). */
const SIGNED_STALE_MS = 2 * HOUR_MS;

/**
 * Make an epoch key when it is time, post the newest one when the fleet does not have it (not yet posted, or posted under another signing key),
 * and delete what is to be deleted. Never throws, and does no more than ask once a minute: it is called from the paths that fetch and publish.
 */
export async function tickEpoch(creds: FleetCredentials, fleet: string, keyFile: string, signKey: { publicKey: string; privateKey: string }, now: number = Date.now()): Promise<void> {
  const settings = epochSettings();
  if (!settings.enabled) return;
  const id = keyFile;
  if (now - (lastTick.get(id) ?? 0) < TICK_MS || now < (notBefore.get(id) ?? 0)) return;
  lastTick.set(id, now);
  try {
    pruneEpochs(keyFile, now, settings);
    const key = ensureEpoch(keyFile, now, settings);
    if (!key || key.posted === signKey.publicKey) return;
    const role = await fetchRole(creds, fleet);
    if (!role.member || role.incarnation === undefined) return;
    // Signed once, under the key file's lock, and sent again as it is until the fleet has taken it: a second process of this member, or a post
    // whose answer was lost, sends the same entry, which the fleet answers "taken already", and does not make another one that it would refuse.
    let sent: { spub: string; notAfter: number; sig: string } | undefined;
    updateKeyFile(keyFile, (p) => {
      const mine = (p.epochs ?? []).find((e) => e.n === key.n);
      if (!mine || mine.posted === signKey.publicKey) return undefined;
      if (mine.signed && mine.signed.spub === signKey.publicKey && mine.signed.notAfter >= now + SIGNED_STALE_MS) {
        sent = mine.signed;
        return undefined;
      }
      const notAfter = now + Math.min(2 * settings.lengthMs, NOT_AFTER_MAX_MS);
      const sig = signEpochEntry(epochEntry(fleet, role.incarnation!, creds.deviceId, mine.n, mine.publicKey, notAfter), signKey.privateKey);
      sent = { spub: signKey.publicKey, notAfter, sig };
      return { ...p, epochs: (p.epochs ?? []).map((e) => (e.n === mine.n ? { ...e, signed: sent! } : e)) };
    });
    if (!sent) return;
    const entry = epochEntry(fleet, role.incarnation, creds.deviceId, key.n, key.publicKey, sent.notAfter);
    const result = await postEpochKey(creds, fleet, entry, sent.sig);
    if (result.ok) {
      updateKeyFile(keyFile, (p) => ({ ...p, epochs: (p.epochs ?? []).map((e) => (e.n === key.n ? { ...e, posted: signKey.publicKey } : e)) }));
      return;
    }
    if (result.status === 404 || result.status === 405) {
      // A gateway that has no such route: the key was never used by anyone, and is not kept.
      notBefore.set(id, now + NO_ROUTE_MS);
      updateKeyFile(keyFile, (p) => {
        const keep = (p.epochs ?? []).filter((e) => !(e.n === key.n && e.posted === undefined));
        if (keep.length === (p.epochs ?? []).length) return undefined;
        const { epochs: _gone, ...rest } = p;
        return keep.length > 0 ? { ...rest, epochs: keep } : rest;
      });
    } else if (result.status === 429) notBefore.set(id, now + Math.max(result.retryAfterMs ?? 0, TICK_MS));
    else if (result.status === 409 && result.n !== undefined && result.n >= key.n) {
      // The fleet holds a key of this member that is not this one (the key file was lost, or copied back, or an entry with another expiry
      // was taken): the next key is made after it. This one is kept as it is, with its number: snapshots may be wrapped to it.
      const after = result.n + 1;
      updateKeyFile(keyFile, (p) => ((p.epochs ?? []).some((e) => e.n >= after) ? undefined : { ...p, epochs: [...(p.epochs ?? []), generateEpochKey(after, now)] }));
    } else notBefore.set(id, now + 10 * 60_000);
  } catch {
    // Nothing here may stop a fetch or a publish; the next minute asks again.
    notBefore.set(id, now + 5 * 60_000);
  }
}

/** For tests: forget what the throttles remember. */
export function resetEpochThrottle(): void {
  lastTick.clear();
  notBefore.clear();
  takenIn.clear();
  warnedBadEpoch.clear();
}
