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

The operator is not the only one who may run a fleet. The device that
created a fleet owns it, and the owner may mint invites, approve requests,
remove members and revoke codes with its own device credential. A member it
invited would otherwise have no way to admit anyone else, which would make
the gateway token a requirement for a fleet to work at all.

## Who runs a fleet

The device that creates a fleet owns it. The owner mints the invites, admits
the members, removes them and deletes the fleet, using its own credential.
The gateway token still works, and is the way in when the owner is gone.

A fleet space is kept in step by an agent on the host: a small background
process that watches the space's workspace, publishes what changed when
the space is the primary, and pulls what the primary published when it
is not. It starts with the space and stops with it, and it needs no
attention:

```
prime fleets agent start     # start it now
prime fleets agent status    # what it is doing
```

A change reaches the other members in well under a second, because the
agent notices a change at once instead of waiting for the next round.

An owner that leaves hands the fleet to the member that has been in it the
longest, so a fleet is never left with nobody able to run it. A space that is
deleted leaves its fleet.

A fleet that has not been touched for a day is not being run by anybody, and
any proven device may clean such a fleet up. Otherwise a fleet whose members
are all gone would sit there for ever with nobody able to touch it.

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
  a lease is already held      -> { role: "replica", reason: "lease-held", head: {...} }
  no lease is held             -> { role: "primary", epoch: N, head: {...} }
                                   and, when a head exists,
                                   { catchUpTo: <the sequence to apply> }
```

- **No state at all.** The first member to bootstrap takes the lease, becomes
  primary, and publishes the initial snapshot. Its work directory *is* the
  fleet's state, so there is nothing to fetch.
- **State exists and the lease is free.** This is what a takeover looks like:
  the member takes the lease, and the fleet tells it which sequence it has
  to apply first. It may not publish until it says it has.
- **The lease is held.** The member is a replica. It fetches the head
  manifest, then the packs it is missing, decrypts and applies them, and
  only then is reported ready.

The rule that keeps this honest:

> **Catch up before promoting.** A new primary applies every snapshot up to
> the current head before it accepts a single write. A primary that starts
> behind the head forks the fleet.

The Durable Object enforces it rather than trusting the client: it records
how far each member has got, and refuses a head advance from a member that
has not applied the state it is about to replace.

A member without a public key may not hold the lease at all. It could never
open a snapshot, so it could never catch up, so it would publish on top of
state it cannot read.

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

The member that publishes snapshots needs the members' public keys, and it
gets them from their own route, which only the lease holder may read. The
roster keeps the ids cut short for everybody else.

## Nested repositories

A repository inside the work tree belongs to the member, not to the fleet.
The fleet **excludes** it: it does not mirror the files, and it does not
record a reference to it either. A reference would be a promise the replica
could not keep, because the replica has no copy of that history.

The nested repository keeps its own history, its own remote and its own
uncommitted work. The fleet never writes inside it, and a snapshot taken
around it stays correct.

---
## Talking to a fleet

A client may address the fleet itself instead of one of its members:

```
prime tools call fleet:<fleet-id>.bash '{"command":"ls"}'
```

The call goes to the member that holds the lease - the primary - because
that is the one whose state the fleet agrees on, and the one that may
write. The gateway relays on the caller's behalf, so the caller proves
only that it is a member of the fleet.

The primary is a moving target: when it dies, its lease runs out and
another member takes it over. A call made in the meantime fails and says
so; a call made after that goes to the new primary, with the same state
the old one had.

---
## Failure behaviour

| Situation | Behaviour |
|---|---|
| invite expired | refused, removed from storage |
| invite already used | refused; one code admits once |
| fleet full | refused (cap 32 members) |
| owner leaves | the fleet goes to the member that has been in it the longest |
| last member leaves | the fleet is gone with it |
| the space of a member is deleted | the space leaves the fleet, and the fleet is gone if it was the last one |
| a fleet nobody has touched for a day | any proven device may clean it up; a fleet that is not being run is not worth keeping |
| primary dies | the lease expires; a member that finds no lease takes it, applies the state it is replacing, and only then may publish |
| the space of the primary is stopped | it gives up the lease at once, so another member takes over without waiting for the lease to run out |
| a member comes back with a new key | the fleet learns the new key when it takes its place, and seals the next snapshot for it |
| a replica's workspace is changed by hand | the change is left alone and reported, rather than thrown away by the next pull |
| object storage lost | head and epoch re-read from R2; membership is rebuilt by re-inviting |

## Limits

| Limit | Value | Why |
|---|---|---|
| members per fleet | 32 | each member is a replication target; beyond this the primary's fan-out dominates |
| pending requests | 32 | bounds the approval queue |
| invite lifetime | 10 min default, 1 h max | long enough to walk to another machine, short enough that a leaked code expires |
| fleet id | 1-32 chars, `[a-z0-9-]` | readable, unambiguous, no path tricks |