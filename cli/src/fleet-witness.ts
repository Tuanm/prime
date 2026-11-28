// The client of the witness (api/witness): a place outside the gateway that holds the newest checkpoint each member signed, so that
// a member can notice that the gateway shows it an older history than another member saw (a rollback), or two histories (a fork).
//
// What is posted and read is fixed by api/witness/README.md ("Exact forms", "Wire"): a checkpoint is the array
// `["prime-cp-v1", fleetKey, fleet, incarnation, seq, manifestHash, rosterN|null, ts]`, signed over `JSON.stringify` of the array
// by the member's signing key (the `spub` the roster names). The witness checks only the signature and that the key is the roster's;
// it is members that decide what a checkpoint is worth, and this file is that: a checkpoint counts only when its key is one the
// roster this member verified names, and the witness being down never stops anything (the answer is "unwitnessed").
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic-write.ts";
import type { MemberSignKey } from "./fleet-crypto.ts";
import { entryBytes, mayCheckpointAt, type SignedEntry, type VerifiedRoster } from "./fleet-roster.ts";
import { FleetTrust } from "./fleet-trust.ts";
import { fetchHead, type FleetCredentials } from "./fleet-transport.ts";

export const CHECKPOINT_TAG = "prime-cp-v1";

/**
 * How a member and the witness keep pace (api/witness/README.md, "What a client must do"): a checkpoint is posted for every new
 * snapshot the member publishes or takes in, at most one per ten seconds (the newest supersedes the ones skipped); the witness is read
 * when the snapshot the member holds changes, but not more than once a minute, and in any case every two minutes, so a member that
 * sees nothing change still looks.
 */
export const WITNESS_CHECK_MS = 120_000;
export const WITNESS_READ_MIN_MS = 60_000;
export const WITNESS_POST_MIN_MS = 10_000;
/** A request to the witness is cut short after this: it is a side channel, and never holds a round up. */
export const WITNESS_TIMEOUT_MS = 8_000;

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const TOKEN = /^[A-Za-z0-9._~:+=/-]{1,128}$/;
const FLEET_KEY = /^[A-Za-z0-9_-]{43}$/;

/** ["prime-cp-v1", fleetKey, fleet, incarnation, seq, manifestHash, rosterN, ts] */
export type Cp = [string, string, string, string, number, string, number | null, number];

/** One checkpoint as the witness lists it. */
export interface WitnessCheckpoint {
  cp: Cp;
  sig: string;
  spub: string;
  tier?: string;
  at?: number;
}

export interface Proof {
  genesis?: SignedEntry["entry"];
  entry: SignedEntry["entry"];
  sig: string;
  by?: string;
}

// ---- making and checking a checkpoint --------------------------------------------------------

/** The checkpoint of a member that has seen snapshot `seq` (whose manifest has the hash `manifestHash`) of the fleet `v` describes. */
export function checkpointOf(v: VerifiedRoster, seq: number, manifestHash: string, ts: number): Cp {
  return [CHECKPOINT_TAG, v.fleetKey, v.fleet, v.incarnation, seq, manifestHash, v.head.n, ts];
}

export function signCheckpoint(cp: Cp, key: MemberSignKey): { cp: Cp; sig: string; spub: string } {
  const sig = cryptoSign(null, entryBytes(cp), createPrivateKey(key.privateKey)).toString("base64url");
  return { cp, sig, spub: key.publicKey };
}

/** The Ed25519 public key (SPKI) of a raw 32-byte key. */
function publicKeyOf(rawB64u: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(rawB64u, "base64url")]), format: "der", type: "spki" });
}

export function verifyCheckpoint(c: { cp: unknown[]; sig: string; spub: string }): boolean {
  if (!B64URL_32.test(c.spub) || !B64URL_64.test(c.sig)) return false;
  try {
    return cryptoVerify(null, entryBytes(c.cp), publicKeyOf(c.spub), Buffer.from(c.sig, "base64url"));
  } catch {
    return false;
  }
}

/** The shape of a checkpoint the witness lists, or null: anything else is not looked at. */
export function parseCheckpoint(raw: unknown): WitnessCheckpoint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { cp, sig, spub, tier, at } = raw as Record<string, unknown>;
  if (!Array.isArray(cp) || cp.length !== 8 || cp[0] !== CHECKPOINT_TAG) return null;
  const [, fleetKey, fleet, incarnation, seq, hash, rosterN, ts] = cp;
  if (typeof fleetKey !== "string" || !FLEET_KEY.test(fleetKey)) return null;
  if (typeof fleet !== "string" || !TOKEN.test(fleet) || typeof incarnation !== "string" || !TOKEN.test(incarnation) || typeof hash !== "string" || !TOKEN.test(hash)) return null;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0 || !Number.isSafeInteger(ts) || (ts as number) < 0) return null;
  if (rosterN !== null && (!Number.isSafeInteger(rosterN) || (rosterN as number) < 0)) return null;
  if (typeof sig !== "string" || typeof spub !== "string") return null;
  return { cp: cp as Cp, sig, spub, ...(typeof tier === "string" ? { tier } : {}), ...(typeof at === "number" ? { at } : {}) };
}

/**
 * What shows the witness that a key is a member's: the owner-signed `add` or `rotate` entry that names it (with the genesis, whose hash
 * is the fleet's name there), or a `rotate-self` entry with the key that held the device's place before. Undefined when the roster has none
 * (the key is then posted without, and is kept in the witness's small tier of signers it cannot vouch for).
 */
export function proofFor(v: VerifiedRoster, spub: string): Proof | undefined {
  for (let i = v.entries.length - 1; i >= 1; i--) {
    const { entry, sig } = v.entries[i]!;
    if (entry[9] !== spub) continue;
    if (entry[6] === "add" || entry[6] === "rotate") return { genesis: v.entries[0]!.entry, entry, sig };
    if (entry[6] === "rotate-self") {
      // The key that held the place of this device just before it.
      for (let j = i - 1; j >= 1; j--) {
        const before = v.entries[j]!.entry;
        if (before[7] === entry[7] && before[9] !== null && before[9] !== spub && ["add", "rotate", "rotate-self"].includes(before[6] as string)) return { entry, sig, by: before[9] as string };
      }
    }
  }
  return undefined;
}

// ---- judging what the witness holds ------------------------------------------------------------

/** Two checkpoints of members for one sequence, with manifests that differ. */
export interface ForkProof {
  /** What it is, so that one the operator has looked at is not raised again. */
  id: string;
  seq: number;
  a: WitnessCheckpoint;
  b: WitnessCheckpoint;
}

export interface Alert {
  kind: "rollback" | "different-head";
  /** The newest sequence a member says it saw, and which key said it. */
  seq: number;
  manifestHash: string;
  spub: string;
  /** What the gateway shows now. */
  headSeq: number;
  headHash: string;
  /** When that member signed it (its own clock, signed). */
  ts: number;
}

export interface Verdict {
  /** Checkpoints whose signature, fleet and key were right. */
  counted: number;
  /** Checkpoints that were not (a key the roster does not name, a bad signature, another fleet): left out. */
  ignored: number;
  alert?: Alert;
  forks: ForkProof[];
}

export const forkId = (seq: number, hashes: [string, string]): string => "fork:" + seq + ":" + [...hashes].sort().join(":");

/**
 * Compare what the witness holds with the head the gateway shows. The checkpoints must have been read BEFORE the head: a head only goes
 * forward, so a checkpoint that is ahead of a head read after it is the gateway's doing, and not a publish that happened in between.
 *
 * - **rollback**: a member's checkpoint is for a later sequence than the head.
 * - **different-head**: a member's checkpoint is for the head's sequence with another manifest.
 * - **fork**: two members' checkpoints for one sequence with different manifests (the gateway told two members two stories).
 */
export function judgeWitness(v: VerifiedRoster, held: WitnessCheckpoint[], head: { seq: number; manifestHash: string }, acknowledged: readonly string[] = []): Verdict {
  const counted: WitnessCheckpoint[] = [];
  let ignored = 0;
  for (const c of held) {
    const ours = c.cp[1] === v.fleetKey && c.cp[2] === v.fleet && c.cp[3] === v.incarnation;
    // The key must have held a place in the chain at the sequence it vouches for: one that was removed (or replaced) saw nothing
    // after that, and what it says then is not a member's.
    if (ours && mayCheckpointAt(v, c.spub, c.cp[4]) && verifyCheckpoint(c)) counted.push(c);
    else ignored++;
  }
  const verdict: Verdict = { counted: counted.length, ignored, forks: [] };

  let newest: WitnessCheckpoint | undefined;
  for (const c of counted) if (newest === undefined || c.cp[4] > newest.cp[4]) newest = c;
  if (newest !== undefined && newest.cp[4] > head.seq) {
    verdict.alert = { kind: "rollback", seq: newest.cp[4], manifestHash: newest.cp[5], spub: newest.spub, headSeq: head.seq, headHash: head.manifestHash, ts: newest.cp[7] };
  } else {
    const other = counted.find((c) => c.cp[4] === head.seq && c.cp[5] !== head.manifestHash);
    if (other !== undefined) verdict.alert = { kind: "different-head", seq: head.seq, manifestHash: other.cp[5], spub: other.spub, headSeq: head.seq, headHash: head.manifestHash, ts: other.cp[7] };
  }

  const bySeq = new Map<number, WitnessCheckpoint[]>();
  for (const c of counted) bySeq.set(c.cp[4], [...(bySeq.get(c.cp[4]) ?? []), c]);
  for (const [seq, list] of bySeq) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.cp[5] === b.cp[5] || a.spub === b.spub) continue;
        const id = forkId(seq, [a.cp[5], b.cp[5]]);
        if (acknowledged.includes(id) || verdict.forks.some((f) => f.id === id)) continue;
        verdict.forks.push({ id, seq, a, b });
      }
    }
  }
  return verdict;
}

// ---- what a member keeps ---------------------------------------------------------------------

/** What the agent last found, kept beside the key file: where the witness is, and what it showed. */
export interface WitnessState {
  url?: string;
  /** The last checkpoint this member posted (`ts` is what it signed). */
  posted?: { seq: number; manifestHash: string; at: number; ts: number };
  /** The witness is refusing, or is full or limiting this member (not just unreachable): kept until a request goes through. */
  fault?: { at: number; status: number; what: string };
  /** The last time the witness was read, and how it went. */
  checked?: { at: number; status: "ok" | "unwitnessed" | "not-held" | "no-roster"; counted?: number; ignored?: number; error?: string };
  /** A rollback, or a head that is not the one a member saw: until the witness and the gateway agree again. */
  alert?: Alert & { at: number };
  /** Two members saw two histories: a publish on top of it is refused until the operator has looked (`witness clear`). */
  fork?: ForkProof & { at: number };
  /** Forks the operator has looked at. */
  acknowledged?: string[];
}

export function witnessStateFile(keyFile: string): string {
  return keyFile + ".witness.json";
}

export function readWitnessState(keyFile: string): WitnessState {
  try {
    const raw = JSON.parse(readFileSync(witnessStateFile(keyFile), "utf8")) as WitnessState;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function writeWitnessState(keyFile: string, state: WitnessState): void {
  writeFileAtomic(witnessStateFile(keyFile), JSON.stringify(state, null, 2) + "\n", 0o600);
}

export function updateWitnessState(keyFile: string, change: (s: WitnessState) => void): WitnessState {
  const state = readWitnessState(keyFile);
  change(state);
  writeWitnessState(keyFile, state);
  return state;
}

export function hasWitnessState(keyFile: string): boolean {
  return existsSync(witnessStateFile(keyFile));
}

/** Where this member's witness is: what was set for it, else PRIME_FLEET_WITNESS. */
export function witnessUrlOf(keyFile: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const given = readWitnessState(keyFile).url ?? env.PRIME_FLEET_WITNESS;
  if (!given) return undefined;
  return normalizeWitnessUrl(given);
}

export function normalizeWitnessUrl(text: string): string | undefined {
  try {
    const u = new URL(text);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return undefined;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

// ---- talking to it -----------------------------------------------------------------------------

export class WitnessError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** What the witness holds for the fleet: null when it does not hold it (404). Any other failure is an error: the witness is "unwitnessed". */
export async function readWitness(url: string, fleetKey: string, fetcher: typeof fetch = fetch): Promise<WitnessCheckpoint[] | null> {
  const res = await fetcher(url + "/w/" + encodeURIComponent(fleetKey), { signal: AbortSignal.timeout(WITNESS_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new WitnessError("the witness answered " + res.status, res.status);
  const body = (await res.json().catch(() => null)) as { checkpoints?: unknown } | null;
  if (body === null || !Array.isArray(body.checkpoints)) throw new WitnessError("the witness's answer is not a list of checkpoints");
  return body.checkpoints.map(parseCheckpoint).filter((c): c is WitnessCheckpoint => c !== null);
}

/** Post a checkpoint, with the proof the witness asks for; true when it was stored (false: an older one than the signer's newest). */
export async function postCheckpoint(url: string, v: VerifiedRoster, key: MemberSignKey, seq: number, manifestHash: string, now: number, fetcher: typeof fetch = fetch): Promise<boolean> {
  const signed = signCheckpoint(checkpointOf(v, seq, manifestHash, now), key);
  const proof = proofFor(v, key.publicKey);
  const res = await fetcher(url + "/w/" + encodeURIComponent(v.fleetKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...signed, ...(proof ? { proof } : {}) }),
    signal: AbortSignal.timeout(WITNESS_TIMEOUT_MS),
  });
  if (!res.ok) throw new WitnessError("the witness refused the checkpoint (" + res.status + ")" + (await res.text().then((t) => " " + t.slice(0, 160), () => "")), res.status);
  const body = (await res.json().catch(() => ({}))) as { stored?: boolean };
  return body.stored !== false;
}

// ---- what a refusal means -------------------------------------------------------------------------

/**
 * A witness that answers with a refusal that needs a person (it is full, it is limiting, it does not take the fleet's owner, it was told the
 * key is gone) is not "unwitnessed": the operator has to hear what it means. Anything else that fails is the witness being out of reach.
 */
export function faultOf(err: unknown): { status: number; what: string } | undefined {
  if (!(err instanceof WitnessError) || err.status === undefined) return undefined;
  const said = err.message;
  switch (err.status) {
    case 507:
      return { status: 507, what: "the witness is full (a tier of signers, or the whole witness): this member's checkpoints are not kept. Whoever runs the witness has to make room (" + said + ")" };
    case 429:
      return { status: 429, what: "the witness is limiting requests from this address or for this fleet; checkpoints are posted again as it allows (" + said + ")" };
    case 403:
      return { status: 403, what: "the witness does not serve this fleet's owner (the owner key is not in the witness's OWNER_KEYS): nothing of this fleet is kept there (" + said + ")" };
    case 409:
      return { status: 409, what: "the witness holds that this member's key was replaced or removed in the roster, so it takes no more checkpoints from it (" + said + ")" };
    default:
      return undefined;
  }
}

// ---- posting this member's checkpoint -------------------------------------------------------------

/** The snapshot a member holds because it published it or took it in, and the hash of the manifest it is. */
export interface Held {
  seq: number;
  manifestHash: string;
}

export interface WitnessPost {
  creds: FleetCredentials;
  fleet: string;
  keyFile: string;
  held: Held;
  signKey: () => MemberSignKey;
  now?: number;
  fetcher?: typeof fetch;
}

export interface WitnessOutcome {
  status: "off" | "no-roster" | "unwitnessed" | "fault" | "not-held" | "ok" | "alert" | "fork";
  posted?: boolean;
  error?: string;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Post the checkpoint of a snapshot this member published or took in, with the hash of the manifest it holds (not what the gateway says
 * the head is now). Never throws: a witness out of reach is "unwitnessed", and a refusal that needs a person is a fault (`state.fault`).
 */
export async function postHeld(post: WitnessPost): Promise<WitnessOutcome> {
  const url = witnessUrlOf(post.keyFile);
  if (url === undefined) return { status: "off" };
  const now = post.now ?? Date.now();
  const note = (change: (s: WitnessState) => void): void => void updateWitnessState(post.keyFile, change);
  const last = readWitnessState(post.keyFile).posted;
  if (last !== undefined && last.seq === post.held.seq && last.manifestHash === post.held.manifestHash) return { status: "ok" };
  try {
    const v = await FleetTrust.beside(post.keyFile).verifiedRoster(post.creds, post.fleet);
    if (v === null) return { status: "no-roster" };
    const key = post.signKey();
    if (!v.tenures.some((t) => t.spub === key.publicKey && t.until === null)) throw new WitnessError("this member's signing key is not in the roster");
    await postCheckpoint(url, v, key, post.held.seq, post.held.manifestHash, now, post.fetcher ?? fetch);
    note((s) => {
      s.posted = { seq: post.held.seq, manifestHash: post.held.manifestHash, at: now, ts: now };
      delete s.fault;
    });
    return { status: "ok", posted: true };
  } catch (err) {
    const error = messageOf(err);
    const fault = faultOf(err);
    if (fault) {
      note((s) => void (s.fault = { at: now, ...fault }));
      return { status: "fault", error: fault.what };
    }
    note((s) => void (s.checked = { ...(s.checked ?? { at: now, status: "ok" }), status: "unwitnessed", error: "the checkpoint was not posted: " + error }));
    return { status: "unwitnessed", error };
  }
}

// ---- reading what it holds ---------------------------------------------------------------------------

export interface WitnessLook {
  creds: FleetCredentials;
  fleet: string;
  keyFile: string;
  now?: number;
  fetcher?: typeof fetch;
}

/**
 * Read what the witness holds and compare it with the gateway's head. Never throws and never blocks anything: a witness that cannot be
 * reached is an answer ("unwitnessed"), and what was found is written beside the key file.
 */
export async function lookAtWitness(look: WitnessLook): Promise<WitnessOutcome> {
  const url = witnessUrlOf(look.keyFile);
  if (url === undefined) return { status: "off" };
  const now = look.now ?? Date.now();
  const fetcher = look.fetcher ?? fetch;
  const note = (change: (s: WitnessState) => void): WitnessState => updateWitnessState(look.keyFile, change);
  let v: VerifiedRoster | null;
  try {
    v = await FleetTrust.beside(look.keyFile).verifiedRoster(look.creds, look.fleet);
  } catch (err) {
    const error = messageOf(err);
    note((s) => void (s.checked = { at: now, status: "no-roster", error }));
    return { status: "no-roster", error };
  }
  if (v === null) {
    note((s) => void (s.checked = { at: now, status: "no-roster", error: "the roster of this fleet is not signed: the witness holds only fleets that have one" }));
    return { status: "no-roster" };
  }
  // The witness is read first and the head after it: the head only goes forward, so a checkpoint ahead of it is not a publish in between.
  let held: WitnessCheckpoint[] | null;
  try {
    held = await readWitness(url, v.fleetKey, fetcher);
  } catch (err) {
    const error = messageOf(err);
    const fault = faultOf(err);
    note((s) => {
      s.checked = { at: now, status: "unwitnessed", error };
      if (fault) s.fault = { at: now, ...fault };
    });
    return fault ? { status: "fault", error: fault.what } : { status: "unwitnessed", error };
  }
  let head: { seq: number; manifestHash: string } | undefined;
  try {
    const h = await fetchHead(look.creds, look.fleet);
    head = { seq: h.seq, manifestHash: h.manifestHash };
  } catch {
    // No head yet (a fleet nobody published to), or the gateway did not answer: nothing to compare with.
  }
  const before = readWitnessState(look.keyFile);
  const verdict = held === null || head === undefined ? undefined : judgeWitness(v, held, head, before.acknowledged ?? []);
  let outcome: WitnessOutcome = { status: held === null ? "not-held" : "ok" };
  note((s) => {
    s.checked = { at: now, status: held === null ? "not-held" : "ok", ...(verdict ? { counted: verdict.counted, ignored: verdict.ignored } : {}) };
    if (verdict === undefined) return;
    // A rollback or a different head ends when the witness and the gateway agree again; a fork stays until the operator has looked.
    if (verdict.alert) s.alert = { ...verdict.alert, at: s.alert && s.alert.kind === verdict.alert.kind && s.alert.seq === verdict.alert.seq ? s.alert.at : now };
    else delete s.alert;
    const fork = verdict.forks[0];
    if (fork && !s.fork) s.fork = { ...fork, at: now };
  });
  if (verdict?.forks[0] && !before.fork) outcome = { status: "fork" };
  else if (verdict?.alert) outcome = { status: "alert" };
  return outcome;
}

/** The fork proof that keeps this member from publishing, if there is one: the operator has not looked at it yet. */
export function forkBlocking(keyFile: string): ForkProof | undefined {
  return readWitnessState(keyFile).fork;
}
