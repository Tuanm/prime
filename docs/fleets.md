# Fleets

A fleet is a named group of devices that hold the same work and can take
over for each other. Exactly one member is **primary** (may write); the rest
are **replicas** (read-only, mirroring the primary).

This document covers membership: who may join, how they prove it, and what
state a new member starts from.

## Roles

| Role | Who | Can do |
|---|---|---|
| operator | holder of the gateway token | create a fleet, mint invites, approve and remove members |
| owner | the device that created the fleet | everything the operator can, through its own device token |
| member | any admitted device | read sync state, hold the lease |
| primary | the member holding the lease | publish snapshots |
| replica | every other member | fetch snapshots, never write |

The operator role exists because a fleet sometimes has to be administered
from a machine that is not itself a member.

## Two credentials, two jobs

- **Gateway token** proves operator authority. It is per-deployment, never
  leaves the operator's machine, and is only used for administration.
- **Device token** proves the identity of one device. It is per-device, is
  minted when the device registers, and is the only thing that can speak for
  that device.

A request never carries an identity that is not backed by one of these. The
Worker proves the credential, then tells the Durable Object *who* the caller
is over an internal header. The Durable Object is not reachable from the
internet - it exists only behind the Worker's binding - so that header is
trustworthy. Authentication at the edge, authorization in the object.

This matters: a lease whose holder is a client-supplied string can be
hijacked by anyone who repeats the string. Deriving the holder from a proven
credential is the whole point.

## Joining

```
operator                      gateway                       new device
   |                             |                              |
   |-- POST /fleets ------------->|  creates the fleet           |
   |-- POST /fleets/:f/invite --->|  mints a single-use code     |
   |                             |                              |
   |          (code handed over out of band) ------------------>|
   |                             |                              |
   |                             |<-- POST /fleets/:f/join -----|
   |                             |    (device token + code)     |
   |                             |                              |
   |<-- GET /fleets/:f/pending --|  request waits for approval  |
   |-- POST /fleets/:f/approve -->|                              |
   |                             |--- admitted ---------------->|
```

The invite is what makes an admission deliberate. It is:

- **single use** - consumed by the first device that presents it, whether or
  not approval follows;
- **short lived** - ten minutes by default, one hour at most;
- **stored hashed** - a dump of the Durable Object's storage yields no usable
  codes;
- **not an identity** - it proves an invitation, not who is holding it. That
  is why the default is a second step: the operator sees which device is
  asking and approves it.

`--auto-approve` collapses the two steps for a fleet that is being set up in
one sitting. It is a deliberate opt-in, not the default.

Knowing the fleet name is never enough. A leaked code admits at most one
device, for at most an hour, and only to the pending list unless the operator
approves.

### Why not a shared fleet secret?

A secret every member holds means every member can act as every other member,
and revoking one member means rotating for all of them. Per-device identity
gives per-member leases, per-member revocation, and an audit trail that names
one device.

## Bootstrapping the state a new member starts from

A space created with `--fleet` must be **ready** when the command returns: it
either holds the newest state, or it is the primary that produced it. Joining
and syncing are one operation, not two.

The Durable Object decides in one atomic step, so two spaces created at the
same time cannot both conclude "I am first":

```
POST /fleets/:f/bootstrap   (device token)
  no head yet, no lease        -> { role: "primary", epoch: 1 }
  head exists                  -> { role: "replica", head: {...} }
  a lease is already held      -> { role: "replica", head: {...} }
```

- **No state at all.** The first member to bootstrap takes the lease, becomes
  primary, and publishes the initial snapshot. Its work directory *is* the
  fleet's state, so there is nothing to fetch.
- **State exists.** The new space is a replica. It fetches the head manifest,
  then the packs it is missing, decrypts and applies them, and only then is
  reported ready. A replica that has not caught up must never be promoted.

The rule that keeps this honest:

> **Catch up before promoting.** A new primary applies every snapshot up to
> the current head before it accepts a single write. A primary that starts
> behind the head forks the fleet.

### Why bootstrap is a state-machine decision, not a guess

The client must not decide for itself whether it is first - two devices
starting together would both decide yes. The object serializes the decision
under `blockConcurrencyWhile`, and nothing inside that lock touches the
network, so the check and its effect are one step and stay fast.

## What the fleet stores

In the Durable Object:

| key | contents |
|---|---|
| `members` | deviceId to role, addedAt, addedBy |
| `invites` | invite hash to expiry and auto-approve flag |
| `pending` | deviceId to requestedAt and a cosmetic label |
| `lease` | holder, epoch, expiry |
| `head` | sequence, manifest key, manifest hash, epoch |

The head and the epoch also live in R2, so that losing the object's storage
cannot reset them. The epoch is a fencing token: it only ever increases, and a
member acts only under the epoch it was granted.

## Roster visibility

An operator sees full device ids. A member sees the roster only if it is in
it, and other members are truncated to a prefix - enough to recognise a peer,
not enough to impersonate one.

## Failure behaviour

| Situation | Behaviour |
|---|---|
| invite expired | refused, removed from storage |
| invite already used | refused; one code admits once |
| fleet full | refused (cap 32 members) |
| owner removed | refused; a fleet with no owner cannot be administered |
| owner device gone | another device must be promoted by re-creating the fleet, or the operator mints invites with the gateway token |
| primary dies | lease expires; a replica bootstraps, catches up, then takes over |
| object storage lost | head and epoch re-read from R2; membership is rebuilt by re-inviting |

## Limits

| Limit | Value | Why |
|---|---|---|
| members per fleet | 32 | each member is a replication target; beyond this the primary's fan-out dominates |
| pending requests | 32 | bounds the approval queue |
| invite lifetime | 10 min default, 1 h max | long enough to walk to another machine, short enough that a leaked code expires |
| fleet id | 1-32 chars, `[a-z0-9-]` | readable, unambiguous, no path tricks |
