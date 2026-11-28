// What a caller with no standing may ask of the fleet routes, and how much it may send.
//
// Two things on the fleet path cost the gateway something for a caller that has proved nothing:
//
//   a code check     asking for an anonymous device with a fleet and an invite code wakes that fleet's
//                    Durable Object for any name it is given, and says whether the code is good (the
//                    gateway uses the answer to let a joining space past the cap on new devices);
//   an unknown       a request that names a device the gateway has not got cannot be answered from the cache,
//   device           so it reads the one registry object to be sure - and then it is refused.
//
// Both are billed to the monthly fleet budget, and a flood of either spends it, which refuses every fleet.
// So each is held to a few a minute for any one address.
//
// Two layers, because neither is enough alone:
//
//   * a window kept in the isolate: free, exact for the isolate, and what the tests and a gateway with
//     nothing else configured rely on. It is not shared, so a flood that is spread over many isolates
//     gets the limit once for each of them.
//   * a Cloudflare rate-limit binding, when one is configured ([[ratelimits]] in wrangler.toml): counted
//     across the isolates of a location, with no Durable Object and no storage behind it, so it costs
//     nothing the budget counts. Counters are per location and eventually consistent, which is the right
//     grain for this: a flood comes from one address, to one location, and what is wanted is that it stops,
//     not an exact number.
//
// A Durable Object keyed by address would be exact everywhere, but each ask would then be a Durable Object
// request (and a wake) of its own - the cost being limited - and one that held its counts in memory would
// lose them when it was evicted, which a paced caller could use to start its window again.

import { num, type Env } from "./config";
import { RateLimiter, clientIp } from "./rate-limit";

export type LimitKind = "invite-check" | "unknown-device";

const WINDOW_MS = 60_000;

/** Per address per minute. An invite is checked once or twice by a person joining; no space asks for an unknown device. */
const DEFAULT_MAX: Record<LimitKind, number> = { "invite-check": 30, "unknown-device": 60 };
const ENV_MAX: Record<LimitKind, string> = { "invite-check": "FLEET_INVITE_RATE_MAX", "unknown-device": "FLEET_UNKNOWN_RATE_MAX" };

/** The largest body a fleet route forwards to its object: every one of them takes a small JSON document. */
export const FLEET_BODY_MAX_DEFAULT = 64 * 1024;
/** An invite check carries one code. */
export const INVITE_CHECK_BODY_MAX = 4 * 1024;

export function fleetBodyMax(env: Env): number {
  const n = num(env, "FLEET_BODY_MAX_BYTES", FLEET_BODY_MAX_DEFAULT);
  return n > 0 ? n : FLEET_BODY_MAX_DEFAULT;
}

const limiters = new Map<string, RateLimiter>();

function limiterFor(kind: LimitKind, max: number): RateLimiter {
  const key = kind + ":" + max;
  let limiter = limiters.get(key);
  if (!limiter) {
    // A changed limit is a new window; the old one is let go.
    for (const [k, l] of limiters) if (k.startsWith(kind + ":")) { l.stop(); limiters.delete(k); }
    limiter = new RateLimiter(WINDOW_MS, max);
    limiters.set(key, limiter);
  }
  return limiter;
}

/** The refusal: 429, and when to come back. */
export function tooManyAsks(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return Response.json(
    { error: "rate limited", retryAfterMs: seconds * 1000 },
    { status: 429, headers: { "retry-after": String(seconds), "cache-control": "no-store" } },
  );
}

/**
 * Count one ask of this kind from the caller's address. Null when it may go on; the 429 to answer with when
 * it may not.
 */
export async function limitAsk(env: Env, kind: LimitKind, request: Request): Promise<Response | null> {
  const max = num(env, ENV_MAX[kind], DEFAULT_MAX[kind]);
  if (max === 0) return null;
  const ip = clientIp(request);
  const key = kind + ":" + ip;
  const local = limiterFor(kind, max).check(key);
  if (!local.ok) return tooManyAsks(local.retryAfterMs);
  const binding = kind === "invite-check" ? env.FLEET_RL_INVITE : env.FLEET_RL_UNKNOWN;
  if (binding) {
    try {
      const outcome = await binding.limit({ key });
      if (!outcome.success) return tooManyAsks(WINDOW_MS);
    } catch {
      // A limiter that cannot be asked is not a reason to refuse: the one in the isolate still holds.
    }
  }
  return null;
}
