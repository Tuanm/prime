# Fleets

A fleet is a named group of spaces that hold the same work and can take
over for each other. Exactly one member is **primary** (may write); the rest
are **replicas** (read-only, mirroring the primary).

A fleet is also a device: it answers to its own name, and the operator gives
it a token, so a client reaches the fleet as a whole without being a member
of it.

This document covers what a fleet is made of, how a space joins one, what a
client sees, and what happens when a member stops.

## How it fits together

Three objects and a bucket. The Worker proves every credential; the objects
hold the state; the bucket holds the snapshots.

```
                      prime CLI, or an MCP client
                                  |
              (gateway token, a device token, or the fleet's own token)
                                  |
                                  v
          +----------------------- Worker (api/) -------------------------+
          |  proves the credential, then decides what the caller may do   |
          +-------+---------------------+---------------------+----------+
                  |                     |                     |
          +-------v--------+    +-------v-------+    +--------v--------+
          | RegistryDO     |    | FleetDO       |    | DeviceDO        |
          | device ids and |    | one per fleet |    | one per device  |
          | tokens, which  |    | members,      |    | the tunnel, the |
          | are connected, |    | lease, head,  |    | pending relayed |
          | fleet ids      |    | invites       |    | requests        |
          +----------------+    +-------+-------+    +--------+--------+
                                        |                     |
                                        | the lease names     | the tunnel
                                        | the primary         | of one space
                                        v                     v
                                +-------------------------------+
                                | R2: pack + manifest per head  |
                                | (sealed for the members)      |
                                +-------------------------------+
```

The Worker never opens a snapshot: the packs are sealed for the members'
keys, and the gateway stores ciphertext it cannot read. The registry is the
one place that says which device is which, so every request starts there.

### How a change travels

The primary watches its work tree, builds a pack of what changed, seals it
for the members, and advances the head. A replica polls the head and pulls
what it is missing.

```
   primary space                gateway                 replica space
        |                          |                          |
   change in the work tree        |                          |
        |-- POST /fleets/:f/snapshot ---> R2: pack + manifest |
        |   (one round trip)       |--- head advanced ------->|
        |                          |<-- GET /fleets/:f/head --|
        |                          |--- the head ------------>|
        |                          |<-- GET /fleets/:f/pack --|
        |                          |    (thin delta pack)     |
        |                          |--- the pack ------------>|
        |                          |      apply, then report  |
```

## The admin interface

The operator runs the fleets from `/admin`, at the top of the page:

- **+** makes a fleet. Only the operator can, and the name is free again
  when the fleet is deleted.
- **Invite** mints a single-use code for a space that wants to join.
- Each fleet is a card. Under it is the tree of its spaces: the one that
  holds the lease - the primary - is at the top with a green border, and
  the mirrors are under it.
- A space that asked to join waits under the card, with **Admit** and
  **Decline**.
- The fleet's menu carries **Save** (a name to read, beside the id),
  **Deactivate/Activate**, **Invite** and **Delete**. Deleting a fleet does
  not touch its spaces.

The card's mark says whether a client can reach the fleet:

| mark | means |
|---|---|
| cloud, filled | there is a token, the fleet is not paused, and a space holds the lease |
| cloud, outline | one of those is missing: no way in |
| space with a green border | that space holds the lease |
| space with a red ring | that space is not connected |
| space drawn grey | the operator switched it off |

Below, in **Buddies**, each fleet has a row of its own: the cloud, its name -
which is the id a client uses - and its token, masked. **Refresh token** makes
a new one and shows it once, in a dialog with a copy button. The menu carries
the actions a buddy has: **View**, **Tools** and **Clients** through the space
that holds the lease, and **Deactivate/Activate**.

A space that is switched off is out of the running at once: it gives up the
lease, its tunnel is dropped, and the next member that asks takes over. It is
still a member - **Remove** is what takes it out of the fleet.

## Roles

| Role | Who | Can do |
|---|---|---|
| operator | holder of the gateway token | create a fleet, mint invites, approve and remove members |
| owner | the device that created the fleet | everything the operator can, through its own device token |
| member | any admitted device | read sync state, hold the lease |
| primary | the member holding the lease | publish snapshots |
| replica | every other member | fetch snapshots, never write |
| client | holder of the fleet's own token | reach the fleet, and nothing else: it cannot join, admit, remove or publish |

The operator role exists because a fleet sometimes has to be administered
from a machine that is not itself a member. The client role exists for the
same reason from the other side: work that has to run against the fleet, from
somewhere that is not one of its spaces.

## Three credentials, three jobs

- **Gateway token** proves operator authority. It is per-deployment, never
  leaves the operator's machine, and is only used for administration.
- **Device token** proves the identity of one device. It is per-device, is
  minted when the device registers, and is the only thing that can speak for
  that device.
- **Fleet token** proves the right to reach one fleet as a whole. It is set
  by the operator, belongs to the fleet rather than to any space, and is what
  a client that is not a member presents.

The fleet's token is kept beside the device tokens, in the registry, because
that is where the gateway looks when it is deciding who is calling. A fleet
that has none cannot be reached at all: the name falls through to the device
route, which has no tunnel behind it.

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

The operator creates a fleet, in the admin interface, and the first member
it admits owns it. The owner mints the invites, removes members and
deletes the fleet, using its own credential. The gateway token still
works, and is the way in when the owner is gone.

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

A fleet is made by the operator - from the admin interface, or with
`prime fleets create` where the gateway token is at hand - and nowhere else:
a device cannot bring one into being. The spaces join it, and the operator
admits them.

```
operator                      gateway                       new device
   |                             |                              |
   |-- POST /admin/api/fleets/:f >|  creates the fleet           |
   |-- POST .../:f/invite ------>|  mints a single-use code     |
   |                             |                              |
   |          (code handed over out of band) ------------------>|
   |                             |                              |
   |                             |<-- POST /fleets/:f/join -----|
   |                             |    (device token + code)     |
   |                             |                              |
   |<-- GET /admin/api/fleets ----|  the request waits           |
   |-- POST .../:f/approve ----->|                              |
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

There is no way to admit a device without the operator seeing it: the
approval is the point. A space that asks to join waits for it, and the
agent keeps trying until it is let in.

The operator's view is the admin interface, where each fleet is a card
with the spaces that are in it: the one that holds the lease is the
primary, and the spaces that asked to join are waiting to be admitted.


Knowing the fleet name is never enough. A leaked code admits at most one
device, for at most an hour, and only to the pending list unless the operator
approves.

### Why identity is not a shared secret

A secret every member holds means every member can act as every other member,
and revoking one member means rotating for all of them. Per-device identity
gives per-member leases, per-member revocation, and an audit trail that names
one device.

The fleet's own token is not that: no member ever uses it, and it proves
nothing about a member. It is a way in for a client that is not one, and it
carries exactly one right - talking to the fleet. It cannot join, admit,
remove or publish, and a caller that presents it is not a member of anything.

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
| `members` | deviceId to role, addedAt, pubkey, and the name the operator reads |
| `invites` | invite hash to expiry and who minted it |
| `pending` | deviceId to requestedAt and a cosmetic label |
| `lease` | holder, epoch, expiry |
| `head` | sequence, manifest key, manifest hash, epoch |
| `meta` | the operator's own decision: a name to read, and whether the fleet is paused |
| `applied` | how far each member has got, so the object can refuse a publisher that is behind |

The fleet's token is not here: it lives in the registry, with the device
tokens, because that is where the Worker looks when it decides who is
calling. The registry also keeps the list of fleets, because the objects
cannot be enumerated.

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

A fleet is reached under its own name, with its own token:

```
prime tools call --device <fleet-id> --token <fleet-token> bash '{"command":"ls"}'
```

A member may also address the fleet explicitly, which is how the fleet is
reached from inside one of its own spaces:

```
prime tools call fleet:<fleet-id>.bash '{"command":"ls"}'
```

Whichever way in, the call goes to the member that holds the lease, because
that is the one whose state the fleet agrees on, and the one that may write:

```
   client                 Worker             FleetDO          primary space
     |                      |                  |                   |
     | 1. /mcp/<fleet-id>   |                  |                   |
     |    + the fleet's     |                  |                   |
     |    own token         |                  |                   |
     |--------------------->|                  |                   |
     |                      | 2. that token    |                   |
     |                      |    belongs to a  |                   |
     |                      |    fleet, not a  |                   |
     |                      |    device        |                   |
     |                      |-- 3. /fleet/primary --------------->|
     |                      |<-- 4. the holder is <device id> ----|
     |                      | 5. relay, with the holder's token   |
     |                      |------------------------------------>|
     |                      |                  |  6. MCP over the  |
     |                      |                  |     primary's own |
     |                      |                  |     tunnel        |
     |<---------------------|                  |                   |
```

The gateway relays on the primary's behalf, so it uses the primary's own
credential for the last hop. A caller that is a member rather than the fleet's
token proves its membership instead, and the object is asked whether the
caller is in the fleet.

The primary is a moving target: when it stops, its lease runs out and another
member takes it over. A call made in the meantime fails and says so, naming
the member it could not reach; a call made after that goes to the new primary,
with the same state the old one had.

### Only the primary is entered

`prime spaces enter` works on any space that is not in a fleet. For a space
that is in one, it works only on the primary: a fleet is several copies of one
piece of work, and an edit made in a replica is thrown away the next time it
mirrors. The answer comes from the fleet, not from the configuration, so a
space that has just taken over the lease can be entered at once.

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
| the primary's tunnel goes away | the next ask for a place finds the holder not connected, takes it out of the running on the spot, and the waiting member takes over: a second or two, not a lease |
| a member renews its lease | the agent does it every five seconds, against a fifteen-second lease, so two lost rounds are still a live primary |
| the space of the primary is stopped | it gives up the lease at once, so another member takes over without waiting for the lease to run out |
| the operator switches a space off | the same: the lease goes back at once, its tunnel is dropped, and the next member that asks takes it. It stays a member until it is removed |
| the operator pauses a fleet | nothing joins it, nobody takes a place in it, and nothing is published to it; the leases and the members stay |
| no member holds the lease | the fleet has no primary, so there is nowhere to send a call: it answers that it has none, and the card says so |
| a fleet has no token | no client can reach it; a member still can, and the spaces keep syncing |
| a device already has the name a fleet wants | the fleet is refused: a fleet is reached under its own name, so the two names must not collide (and `anon-` is reserved for the anonymous devices) |
| two spaces of one fleet would share a name | the second one is refused when it asks to join, and told to pass `--name`; a space that takes over an identity keeps the name it already had. Names are compared without case: `alpha` and `Alpha` are one name |
| a member comes back with a new key | the fleet learns the new key when it takes its place, and seals the next snapshot for it |
| a space is renamed, or an identity is taken over by another space | the name the operator reads is corrected on the next round of the agent, because the space says what it is called every time it takes its place |
| a replica's workspace is changed by hand | the change is left alone and reported, rather than thrown away by the next pull |
| object storage lost | head and epoch re-read from R2; membership is rebuilt by re-inviting |

## Limits

| Limit | Value | Why |
|---|---|---|
| members per fleet | 32 | each member is a replication target; beyond this the primary's fan-out dominates |
| pending requests | 32 | bounds the approval queue |
| invite lifetime | 10 min default, 1 h max | long enough to walk to another machine, short enough that a leaked code expires |
| fleet token | 8 to 256 printable characters | long enough to be a secret, short enough to be pasted |
| fleet id | `[a-z0-9][a-z0-9-]`, up to 32, not starting `anon-` | it is also the id a client uses, so it must be one the gateway gives out to nothing else |