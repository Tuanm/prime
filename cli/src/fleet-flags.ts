// The flags each `prime fleets <subcommand>` accepts.

import { flag, type FlagSpec } from "./args.ts";

const FLEET_FLAGS: FlagSpec[] = [
  flag("gateway", "string", "Gateway origin", { placeholder: "<url>" }),
  flag("operator-token", "string", "The gateway's fleet operator credential (FLEET_OPERATOR_TOKEN), for running fleets as the operator; not the gateway token", { placeholder: "<token>" }),
  flag("gateway-token", "string", "Not used by fleet commands any more (the gateway token does not run fleets): see --operator-token", { placeholder: "<token>" }),
  flag("device", "string", "Device id this call speaks as", { placeholder: "<id>" }),
  flag("token", "string", "Device token (X-Device-Token)", { placeholder: "<token>" }),
  flag("space", "string", "Take the device credentials from this space", { placeholder: "<name>" }),
  flag("timeout", "number", "Per-request timeout in milliseconds", { placeholder: "<ms>" }),
  flag("sso", "boolean", "Speak as yourself: sign in through Cloudflare Access (cloudflared) instead of using the operator token (PRIME_FLEET_SSO=1 does it always)"),
];

const FLEET_LOG_FLAGS: FlagSpec[] = [
  ...FLEET_FLAGS,
  flag("after", "number", "Entries after this number", { placeholder: "<n>" }),
  flag("limit", "number", "At most this many entries (the gateway's page is 500)", { placeholder: "<n>" }),
  flag("tail", "number", "The newest entries (default 50)", { placeholder: "<n>" }),
  flag("all", "boolean", "Every entry the gateway holds, page by page"),
];

/** The owner key of a fleet's signed roster: where this machine keeps it. */
const OWNER_KEY_FLAG = flag("owner-key", "string", "The file holding the fleet's owner key (default: PRIME_FLEET_OWNER_KEY, or ~/.prime/fleet-owner/)", { placeholder: "<file>" });

const FLEET_ROSTER_FLAGS: FlagSpec[] = [
  ...FLEET_FLAGS,
  OWNER_KEY_FLAG,
  flag("clear", "boolean", "With `trust pin`: forget the pinned owner key (a pin made before the roster was signed)"),
  flag("owner", "string", "The fingerprint of the owner key to pin", { placeholder: "<fingerprint>" }),
  flag("yes", "boolean", "Sign and send; without it `roster init` only shows what it would do"),
  flag("expect", "string", "With --yes: the digest `roster init` printed for the rows you compared", { placeholder: "<digest>" }),
  flag("witness", "string", "The witness's address, to tell it of a removal (or PRIME_FLEET_WITNESS)", { placeholder: "<url>" }),
];

const FLEET_INVITE_FLAGS: FlagSpec[] = [
  ...FLEET_FLAGS,
  OWNER_KEY_FLAG,
  flag("ttl", "number", "How long the invite stays valid, in seconds", { placeholder: "<s>" }),
];

const FLEET_JOIN_FLAGS: FlagSpec[] = [
  ...FLEET_FLAGS,
  flag("code", "string", "Invite code from the operator", { placeholder: "<code>" }),
  flag("label", "string", "A name for this machine, shown to the operator", { placeholder: "<label>" }),
];

const FLEET_APPROVE_FLAGS: FlagSpec[] = [
  ...FLEET_FLAGS,
  flag("rotate", "boolean", "In a signed fleet: approve a member's new key (a plain approve never changes a key)"),
  OWNER_KEY_FLAG,
  flag("member", "string", "The member to approve", { placeholder: "<id>" }),
  flag("signing-key", "string", "In a fleet whose roster is signed: the fingerprint of the signing key the member prints on its own machine, in full (approve takes it with --key)", { placeholder: "<fingerprint>" }),
  flag("key", "string", "For a member's request for a new key: the fingerprint of the key approved (the KEY of `prime fleets pending`)", { placeholder: "<fingerprint>" }),
];

const FLEET_REMOVE_FLAGS: FlagSpec[] = [
  ...FLEET_FLAGS,
  flag("witness", "string", "In a signed fleet: the witness's address, to tell it of the removal (or PRIME_FLEET_WITNESS)", { placeholder: "<url>" }),
  OWNER_KEY_FLAG,
  flag("member", "string", "The member to remove", { placeholder: "<id>" }),
  flag("key-change", "boolean", "Decline the member's request for a new key, and keep the member"),
];

const FLEET_SYNC_FLAGS: FlagSpec[] = [
  ...FLEET_FLAGS,
  flag("space", "string", "The space that belongs to the fleet", { placeholder: "<name>" }),
  flag("watch", "boolean", "Keep going: publish when primary, pull when replica"),
  flag("interval", "number", "Seconds between rounds when watching", { placeholder: "<s>" }),
  flag("force", "boolean", "Publish even when the workspace has not changed"),
];

const FLEET_SET_FLAGS: FlagSpec[] = [
  ...FLEET_FLAGS,
  flag("lease", "string", "How long a place in the fleet lasts without being renewed: 30s to 180s (90s, 2m, or seconds), or \"default\" for the gateway's own", { placeholder: "<time>" }),
];

/** `prime fleets agent ...`: the common flags, and `--force` for `uninstall`. */
const FLEET_AGENT_FLAGS: FlagSpec[] = [
  ...FLEET_FLAGS,
  flag("force", "boolean", "With `uninstall`: remove the service although it runs another configuration"),
];

/** The flags that `prime fleets <sub>` is parsed with. */
export function fleetFlagsFor(sub: string | undefined): FlagSpec[] {
  if (sub === "invite") return FLEET_INVITE_FLAGS;
  if (sub === "join") return FLEET_JOIN_FLAGS;
  if (sub === "approve") return FLEET_APPROVE_FLAGS;
  if (sub === "remove") return FLEET_REMOVE_FLAGS;
  if (sub === "sync") return FLEET_SYNC_FLAGS;
  if (sub === "log") return FLEET_LOG_FLAGS;
  if (sub === "agent") return FLEET_AGENT_FLAGS;
  if (sub === "set") return FLEET_SET_FLAGS;
  if (sub === "roster" || sub === "trust") return FLEET_ROSTER_FLAGS;
  return FLEET_FLAGS;
}
