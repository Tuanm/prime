# Fleets

A fleet is a small team of spaces that hold the same work and can take over for
each other. One of them is in charge at any moment - it holds what the fleet
calls the **lease**. The others keep an identical copy and wait their turn.

A fleet is also a device: it answers to its own name, and the operator gives it a
token, so a client can reach the whole fleet without being one of its spaces.

```mermaid
flowchart LR
  client[Client] --> gw[Gateway]
  spaces[Space, in charge] --> gw
  mirror[Space, a copy] --> gw
  gw --> fleet[Fleet]
  fleet --> r2[(Snapshots)]
```

## Why a fleet

A machine goes to sleep, a laptop closes, a container is recycled. A fleet is how
one piece of work survives that: it is in several places at once, and the place
that is answering changes without anybody having to redirect a call.

The work is not copied by hand. Whatever is written in the space that is in
charge is packed, sealed, and carried to the others.

## One is in charge

At any moment exactly one space holds the lease. That one writes. The others are
**replicas**: they keep a copy ready, and they never write.

The lease is short - forty-five seconds - and the one holding it renews every fifteen
(a third of it), on a beat of its own, whatever its rounds are doing: a primary whose
snapshots keep failing (a file it cannot read, a pack the gateway refuses) still holds its
place. A renewal that is lost on the way is tried again two seconds later, and a request for
the place is cut off after ten seconds, so even two failures - each as slow as it may be -
leave a third attempt before the place is gone. A renewal the gateway answered with a refusal
(too many requests, over budget) is not hammered: it is asked again when the gateway said to
(`retry-after`), and in any case within a third of the lease. A space that goes quiet loses
the lease quickly rather than locking the fleet: when it runs out the fleet tells every member
over its socket, and a replica that is current takes over in the rest of the lease plus a few
seconds - about a minute from the holder's last renewal. A request that fails while a replica
is taking over is asked again after a short wait that doubles (three seconds, six, twelve, ...),
not after the replica's usual rest, so one failure costs seconds; a replica that is behind first
has to catch up (see below).

```mermaid
sequenceDiagram
  participant A as alpha
  participant F as fleet
  participant B as beta
  A->>F: take the lease
  F-->>A: yours, epoch 3
  loop every fifteen seconds
    A->>F: renew (still epoch 3)
  end
  Note over A: alpha stops answering
  Note over F: forty-five seconds after its last renewal the lease runs out
  F-->>B: the lease is free (over the socket)
  B->>F: take the lease (beta has applied the head)
  F-->>B: yours, epoch 4
```

The **epoch** goes up every time the lease changes hands. A space acts only under
the epoch it was given, so a slow publisher from before the change is refused
instead of writing over the state the fleet has moved to.

## What a change does

The space in charge watches its work tree. When something changes it builds a
pack of what is different, seals it for the members' keys, and advances the head.
A replica is told that the head moved, and fetches what it is missing into its own
store in the background (see "A replica does not mirror all the time" below).

```mermaid
sequenceDiagram
  participant P as the space in charge
  participant G as gateway
  participant R as a replica
  P->>G: here is what changed
  G-->>P: head is now 41
  R->>G: what is the head?
  G-->>R: 41
  R->>G: send me what I am missing
  G-->>R: the pack
  Note over R: decrypt, apply, report where it got to
```

The gateway never opens a pack. It is sealed for the members' own keys, so the
gateway carries boxes it cannot read. Nor does a member take its word for what a
box is: see "What the gateway can still do" below.

### A replica does not mirror all the time

A replica does not write what the fleet publishes into its work tree as it arrives.
When the head moves it **fetches**: it downloads the new snapshots, opens them with
its own key, checks each against its manifest and keeps them in prime's object store
beside the work tree. The work tree is written out - once, for however many snapshots
it is behind - only when it has to be:

- when the replica is about to **take over** (the fleet only gives the lease to a
  member that has applied the head), so a replica that is promoted is current before
  it accepts a write;
- when a person runs **`prime fleets sync --space <name>`**, which fetches what is
  missing and applies it;
- the first time, so a member that joins has files to start from.

**A lazy replica's work directory may be behind the fleet, and it is stale by design.**
What it holds is always a snapshot the fleet really had (the last one applied), never
a half-written mix. If something reads a replica's directory and must see the
newest state, run `prime fleets sync`, or set `PRIME_FLEET_REPLICA=mirror` for the
agent: it then writes every snapshot as it is fetched, as replicas did before. The setting is
passed to the agent and written down in its directory (`fleet-agent/settings.json`), so an agent
started by the login service, or restarted after a crash, has it; `prime fleets agent status` says
which mode it is in. See "The agent's settings" below for how they are set, changed and cleared.

The member's state file records both positions (the agent and `prime fleets sync` both write it, under a lock, and neither position is ever written back to an earlier snapshot than the file already holds; and they write the work tree one at a time, each recording what it wrote before the next starts, so a sync that planned to an older head than the agent has since applied writes nothing instead of putting the older snapshot over the newer): `seq`, `base` and `tree` are what the
work tree holds, and `fetchedSeq`, `fetchedCommit` and `fetchedTree` the newest snapshot
in the store, never behind it. `prime fleets agent status` shows what the agent last did
("fetched 41", "applied 41", "took over at 41").

Fetching is cheap: a replica that is up to date asks nothing, a socket that says "the
head moved" starts one fetch, and the route to the head is the cheapest the replica can
find (see "A replica that fell behind"). A replica takes its place in the fleet when the
agent starts, when the fleet says the lease is free, and as a safety: every fifteen seconds
without a socket (the answer says where the head is, so it asks for nothing else), every five
minutes with one. It does not renew a lease it does not hold.

When the lease is free, replicas that are behind each need to write their work tree to take
it, and only one can. The first to ask is told to catch up and holds a claim on doing so for
thirty seconds (renewed whenever it asks again, but a claim lasts sixty seconds in all); the
others are told to wait, write nothing, and ask again when the claim runs out - and are kept
in the order they asked: when a claim ends the next is given to the one that has waited
longest, and one that asks every second does not overtake one that was told to ask in thirty.
A claimant that died half way costs the others that wait. One that is alive and cannot catch up
- nothing is sealed for it yet, it has lost its key, its work tree cannot be written - has the
claim for its sixty seconds, then goes to the back of the line, and takes it again only if nobody
is waiting; a current client in that state also stops asking for the lease until something
changes. So a replica that can catch up takes over after the claims of the replicas that were
waiting before it: about a minute for each of them that is stuck (measured on the gateway's own
code with a stuck replica ahead of a healthy one: 65 seconds with one stuck, about three minutes
with three), not however many there are. Who actually gets the lease is decided as ever: a
member that has applied the head - a replica that finishes catching up after its claim ended
still takes it.

### What a replica keeps

The fleet carries the files in the primary's work tree, except what git ignores
(`.gitignore`) and except nested git repositories - directories that have their
own `.git`. Those two are never sent, and a directory that was synced and then
became a repository is no longer published (the copies other replicas already
have stay where they are).

When a snapshot arrives, the replica writes the files it has and removes the
files the *previous* snapshot had and this one does not: the ones the primary
deleted. A removal stays inside the work tree (a directory turned into a symlink
is not followed) and only takes a file whose name matches exactly, so a rename
that changes only the case keeps its file on a file system that folds case.

A name is carried as git stores it. On macOS a folder written with a decomposed
accent (`Cafe` plus U+0301, the form HFS+ and some tools produce) reaches the
replicas as the composed `Café` (U+00E9): git's `core.precomposeunicode` makes
that choice for every name it records. Nothing is lost (the files and their
content arrive, in one folder), but the name's bytes on a replica are not always the primary's.

What the fleet never carried is not removed by an apply: git-ignored files
(`.env`, `node_modules`, build output) and nested repositories are untouched.
Two things are not "left alone", and they are not deleted either:

- a file that is not ignored and that the fleet did not give the replica (a note
  someone wrote in the mirror) is a local change, like an edit to a file the fleet
  carries. Before the replica is brought up to date, the changed paths - only
  those - are moved into `local-change-<time>` beside the work tree. A lazy replica does
  that when it is brought up to date (promotion or `prime fleets sync`), not on every head;
- if the fleet turns a directory into a file, git cannot keep both: the ignored
  files inside that directory go with it.

The first snapshot a replica applies has no previous one to compare with. It
removes nothing: a stray file is better than a lost one, and from the second
snapshot on the replica knows exactly what the fleet put there.

### Taking over

A member that has not caught up cannot be promoted: a new space in charge applies
every snapshot up to the head before it accepts a single write. A space in charge
that starts behind the head would fork the fleet, and the fleet refuses it rather
than trusting it.

### A replica that fell behind

Most snapshots carry only what changed. Every 32nd carries the whole tree, as an
anchor - the tree's own files, not the history before it, so its size follows the
tree. A replica that was away starts from the newest whole tree and applies the
changes after it, at most 32 snapshots, however far behind it is. How far behind
one replica is changes nothing for the others: the space in charge goes on
publishing small changes. The gateway keeps the last 64 snapshots, twice the
interval, so the newest whole tree and every change after it are there.

Each snapshot names the head it was built on, whoever published it, so the chain
a replica walks stays whole when the space in charge changes hands. A snapshot
can only be opened by the members it was sealed for; if the chain starts before a
member joined (or before it came back with a new key), it waits for a snapshot
sealed for it - the next change of members, or the next whole tree.

The chain is downloaded and opened before the first step is applied, and each step
is recorded as it is applied. A catch-up that fails part-way leaves a state that
still describes the work tree, so nothing the fleet wrote is taken for a local
change.

A whole tree is also published when a member is added or comes back with a new key (a
swap of one space for another counts), because a snapshot can only be opened by the
members it was sealed for. Each wrapped key says which of the member's keys it is for, so a
member that came back with a new key is routed round the snapshots sealed for its old one. A
member that only left needs no whole tree: the next snapshot is not sealed for it, which is
what keeps it out. A member that has just joined, with nothing yet sealed for it, is told so
after one request and waits for the primary to notice.

**The route a replica takes is the cheapest it can find**: either all the changes since
what it holds, or a whole tree at some checkpoint and the changes after it. Each step
counts its pack's bytes and 24 KB more (two round trips, a manifest, two git processes), so
forty changes of a few hundred bytes are not worth forty round trips when the whole tree is
14 KB, while thirty-nine of 1.5 KB against 1.9 MB are.
A checkpoint carries both - the whole tree, for a newcomer, and the change since the
snapshot before it, sealed with the same key, for everyone who is up to date - so a
replica that follows every snapshot never downloads a whole tree again. The gateway keeps
an index of its snapshots (which are whole trees, how big the packs are), so a replica
works the route out in one request, then fetches the manifests of the snapshots on it
side by side; a gateway without an index is walked manifest by manifest. Older members
ignore the second pack and take the whole tree, as before.

### What the gateway can still do

The gateway stores every manifest in the clear, and decides which one is the head.
So a member does not believe a manifest because the gateway served it. A snapshot is
checked, as it is opened, in three ways (`cli/src/fleet-trust.ts`):

1. **The seal.** The publisher makes a tag (an HMAC, derived from the snapshot key) over the
   fleet, the sequence, the snapshot it follows (the hash its manifest is stored under), the
   commit, the tree, whether the pack is a whole tree, the hash of each sealed pack, its own
   key, the roster and which fleet of that name it is (an id the gateway makes when a fleet is
   created; a fleet that is deleted frees its name, and a sealed snapshot of the earlier one that
   is replayed into a new fleet of the same name names the other id), and puts it in the manifest
   (`seal`). Only a holder of the snapshot
   key can make it, and the snapshot key is only ever wrapped for members. A replica checks
   the manifest against it after it opens the pack, and the pack against the hash in it. A
   manifest the gateway edited, an old snapshot shown under a newer sequence, a tree or pack
   of another snapshot, a snapshot of another fleet: none match, and the snapshot is refused
   before anything is written. (Sizes are not sealed: they only choose the route.) A manifest
   is also read by the hash it is stored under, so the one that comes back is the one that was named.
2. **The sender.** The seal proves "someone who holds this snapshot's key", and every member that
   ever held it - one that has since been removed too - can make it. So each member's entry of
   `wrapped` also carries a tag (`mac`) over the same fields, made with the secret that only the
   sender and that member can derive (the Diffie-Hellman of their two keys). A replica checks it
   against the key the manifest names as the sender's: a removed member that kept an old snapshot
   key cannot put a current member's name on a snapshot, because it cannot make the tag for any
   other member. (It is an added manifest field: older replicas ignore it.)
   And the key the snapshot was made with has to be one the roster lists. The roster is read once for
   a catch-up and kept in `<space>.key.trust.json` beside the key file, each key with the highest
   sequence of a snapshot that was checked with it while it was on the roster: nothing credits a key
   for snapshots that were not looked at. A member that leaves is remembered by the fleet with the
   sequence the head was at when it did (the roster lists it as `left`, with `until`; a key a member
   replaces on joining again is listed the same way), so a member that was away while the primary
   published and then left still takes in what it made, and takes over; and the key is trusted for no
   snapshot after that sequence. A member that is removed while its own publish is in flight has that
   snapshot covered too: the fleet raises `until` to it when the write lands. Up to 256 such keys are
   kept, and one is dropped once the snapshots it could have made are out of the retained history. So a removed member cannot publish with
   its own key, provided the gateway was honest about the roster while it was a member. Otherwise the
   gateway could make a key pair of its own, wrap a snapshot key of its own for each member and seal
   its forgery itself.
3. **No going back.** Publishers older than this have no seal (or, for the tag above, no tag), and
   their snapshots are still accepted - but once a member has taken in a snapshot with a seal (in
   order, and only once it is taken in: not one that was merely downloaded ahead), an unsealed one at
   or above the lowest sealed sequence it has taken in is refused, and likewise for a snapshot that has
   a seal and no tag for this member. The lowest of each is kept in the same file (`sealedFrom`,
   `macFrom`). A snapshot that is refused this way is gone around, not waited for: the
   replica plans its route again from the next whole tree, and a publisher that finds an
   unsealed head publishes a whole tree for that reason.

Whose word this rests on: **the roster**. The operator admits the members, and the
roster says which key each has. The checks hold against anyone who can read and write what
the gateway stores - a bucket, a backup, a replay of old storage, a bug - against a gateway
that edits or reorders manifests, and against a removed member that is helped by the gateway
to serve what it makes - provided the gateway was honest about the roster, and about when a member
left, while that member was in the fleet. They do not hold against a gateway that also lies about the roster:
one that adds a key of its own to the list it serves, or swaps a member's key for its own, can then
author snapshots (for the members that read that roster). That is visible only to someone who compares:
`prime fleets members` prints a fingerprint of each member's key (the KEY column), and a swapped key
keeps the device and changes only that. The fingerprint has to be checked outside the gateway
(against what the member's own `prime fleets members` shows) to mean anything; the admin page
shows it too, in the tooltip of each space (with how far the member says it has applied and fetched:
informational, the gateway decides nothing from `fetched`), and it is the gateway's own page, so
it is no more than the roster is. A member that was removed and that the gateway
helps can still read what it was sent before it was removed, as it always could.

What the gateway can still do, whatever a member checks:

- **Stop the fleet**: not serve, not store, not move the head.
- **Show an older head** (a rollback): a member sees a snapshot that is real and was the
  head once. It cannot be shown as newer, so a member that holds a higher sequence ignores it,
  but a member that has never seen the newer ones cannot know they exist.
- **Show different members different histories**: each is a real chain; the members
  find out when they take over and publish on a head the others do not have.
- **Roll out slowly**: until every publisher has the seal, a replica that has not yet seen a
  sealed snapshot takes unsealed ones, so an unsealed old snapshot of an old publisher can be
  shown as a new one to a member that never saw a sealed one. Once the fleet has a sealed snapshot,
  the gateway does not move the head to one without a seal ("this fleet's snapshots are sealed: upgrade
  prime on this member"): an old member that was promoted is told so, its lease goes to another member
  (an upgraded one takes it), and it carries on as a replica, which it can, since older builds read
  sealed snapshots. (Deploy the gateway before the members.) That is a rule of the gateway about
  availability, not a check a member relies on: a member that has seen a sealed snapshot refuses an
  unsealed one at or above it whatever the gateway lets through ("it carries no seal ..."), and goes
  around it by the next whole tree. The bar that keeps the old member from the lease again lasts ten
  minutes, and ends when it asks for its place as a build that seals (the bootstrap says so); a sealed
  fleet whose only members are old builds does not move until one is upgraded.
  A gateway with the gate says so (`/role`), and then a snapshot without a seal is reported as
  tampering: an old member cannot have published it through that gateway, except for a head that
  was written before the gateway had the gate (it reads the sealed tip's manifest once if the index
  did not say, so only a tip that was not sealed at all escapes). Either way the refusal names the
  manifest's hash, and what the manifest itself says of when it was made and with which key (the
  fingerprint `prime fleets members` prints, to compare with the KEY of the member that is gone; with no
  seal nothing proves it, so it is something to check, not a check), and when that member was lost and no upgraded member can take over (the catch-up
  to that head is what is refused), the operator of the member that cannot go on may run
  `prime fleets trust accept <fleet> --space <name> --manifest <hash>`. **That trusts the gateway for
  that one snapshot**: the member cannot tell it from an old snapshot the gateway made up (a rollback
  of the whole fleet to it), and if the member is promoted its next publish, a whole tree, republishes
  it to everyone. There is nothing here to compare the hash with once the publisher is gone: it is
  the operator's call. It lowers nothing the member has seen, and it only takes a snapshot without a
  seal: a snapshot with a seal and no sender's tag, or no mark of its fleet, after ones that had them
  is refused as tampering, and there is no command to take it.
  **Builds from before this was released**: members built from the intermediate fleet test builds
  (the ones that already sealed the incarnation, with a `v1:` seal, or no tag at all) are not all
  interoperable with a release: a seal over the incarnation is read under either prefix, but a build
  without the sender's tag in an entry is refused as tampering once a member has seen one. They are to
  be upgraded together. Released builds (without a seal) are read as always.
  Older replicas read sealed snapshots as they did before (the packs are unchanged; the tag is
  an added manifest field), so mixed fleets keep working in that direction.
- **Know who is in the fleet, how big the work tree is, and when it changes.**

## Joining

The operator makes the fleet - from `/admin`, or with `prime fleets create` where
the gateway token is at hand. Nowhere else: a space cannot bring a fleet into
being. The spaces join, and the operator admits them.

```bash
prime fleets create acme              # the operator makes it
prime fleets invite acme              # a code that works once, for ten minutes
prime fleets join acme --code p1_...  # a space asks to join
prime fleets pending acme             # who is waiting
prime fleets approve acme --member <id>   # let it in
prime fleets members acme             # the roster
```

The invite makes the admission deliberate:

- **one code, one device**, whether or not approval follows;
- **ten minutes** by default, an hour at most;
- **stored as a hash**, so a dump of the store yields no usable code;
- **an invitation, not an identity** - it says somebody was asked, not who is
  holding it. That is why the operator sees the request and approves it.

A space that asks to join waits. Its agent keeps asking until it is let in.

## Use cases

- **A repository that follows you.** A fleet of three spaces on three machines,
  all holding the same checkout. Start a long job on any of them; when that
  machine stops, the next one carries on from the same point.
- **A workspace that survives a laptop.** The desktop holds the lease, the laptop
  and the space on a server keep copies. Close the lid, keep working.
- **One address for a whole team of machines.** Give the fleet a token, and a
  client that knows nothing about its spaces can run a tool on the fleet as if it
  were one machine.

## Talking to a fleet

The fleet is a device with its own name, so a client reaches it the way it
reaches any device:

```bash
prime tools call --device acme --token <fleet-token> bash '{"command":"ls"}'
prime tools call fleet:acme.bash '{"command":"ls"}'    # from inside a space of the fleet
```

The call goes to whichever space holds the lease, and the answer comes back the
same way. Nobody has to know which machine ran it.

A **member** may also address the fleet through its own device token: the fleet
checks membership instead of the fleet token. And a space that has stopped its
agent stops holding the lease, so a call made in the gap fails with a plain
"no primary right now" rather than hanging.

### Only the space in charge is entered

`prime spaces enter` works on any space that is not in a fleet. In a fleet it
works only on the space in charge: a fleet is several copies of one piece of
work, and an edit made in a replica is moved aside the next time it is brought up to date.

The answer comes from the fleet, not from the configuration file, so a space that
has just taken over can be entered at once.

## In the admin page

Each fleet is a card, with its spaces under it. The marks say what is going on:

| mark | means |
|---|---|
| cloud filled | a token, not paused, and a space holds the lease |
| cloud outline | one of those is missing: no way in |
| green border | that space holds the lease |
| red ring | that space is not connected |
| grey card | the operator switched it off |
| dashed card | a space asking to join, with Admit and Decline |

Beside the fleet tree, **Buddies** carries a row for the fleet itself: its name -
the id a client uses - and its token, masked, with a short fingerprint of it in
the tooltip. The gateway keeps only that fingerprint, never the token.
**Refresh token** makes a new one and shows it once, because there is no second
chance.

## Three credentials, three jobs

| Credential | Belongs to | Can do |
|---|---|---|
| gateway token | the operator | create fleets, mint invites, admit and remove |
| device token | one device | speak for that device: join, sync, take the lease |
| fleet token | one fleet | reach the fleet and nothing else: it cannot join, admit or publish |

The fleet's token belongs to the fleet, not to any space. No member ever uses it.
It is what a client that is not a member presents, and it carries exactly one
right: talking to the fleet.

A secret every member shares would mean every member could act as every other,
and revoking one would rotate it for all. Per-device tokens give per-member
leases, per-member revocation, and a name to look at when something went wrong.

## What happens when it goes wrong

| Situation | What the fleet does |
|---|---|
| the space in charge stops | it gives up the lease at once; the next member that asks takes over |
| its tunnel goes away | the next ask finds the holder not connected and takes it out of the running; a waiting member asks every fifteen seconds without a socket, every five minutes with one, so it is the lease running out (and the socket telling everyone) that usually decides - within a minute |
| the operator switches a space off | the same, at once; it stays a member until it is removed |
| the operator pauses the fleet | nothing joins, nobody takes a place, nothing is published; members stay, the lease runs out. The agents are told over their socket and stop asking, so a paused fleet costs the gateway nothing until it is resumed |
| the operator resumes it | the agents are told at once and a primary is back in about a second |
| the agent's socket drops, or the gateway has none | the agent falls back to asking, as it always did; it looks for the socket again by itself |
| no member holds the lease | the next member whose agent asks takes it; a call in that gap is refused with "no primary right now" |
| the holder's agent stops | its place lapses when the lease runs out (forty-five seconds after its last renewal); the fleet tells the members over their socket, and one takes it a few seconds later |
| the holder's machine reboots | the same, and the reason the agent belongs in a service: `prime fleets agent install` |
| a fleet has no token | no client can reach it; members still sync |
| the invite expired or was used | the request is refused, and the code is gone |
| the fleet is full | refused, at thirty-two members |
| the owner leaves | the fleet goes to the member that has been in it longest, and is gone with the last one |
| a fleet nobody has touched for a day | any proven device may clean it up |
| the name a fleet wants is a device's | refused: a fleet is reached under its own name, so the two must not collide |
| two spaces would share a name | the second is refused when it asks to join, and told to pass `--name`; names are compared without case |
| a member comes back with a new key | the fleet learns it when the member takes its place, and seals the next snapshot for it |
| a replica's work tree was edited locally | the paths that differ from what the fleet gave it - and only those; ignored files and nested repositories are not touched - are moved aside into `local-change-<time>` beside the work tree when the replica is next brought up to date (a promotion, `prime fleets sync`, or every head in `mirror` mode): a replica that cannot catch up is a fleet that cannot promote it |
| no member can be promoted | every member is behind the head (each one was edited and could not sync); the move above is what lets them catch up again |

## The agent belongs in a service

The agent renews this machine's place in the fleet every fifteen seconds while it holds
the lease, and keeps a replica's copy fetched. It is what keeps the fleet alive: while
it runs, the space holds the lease or has a copy ready to take it; while it does not,
the place lapses and the fleet waits for someone else to take it.

So it has to outlive the terminal that started it, and the reboot:

```bash
prime fleets agent install      # a login service: starts at login, restarts if it stops
prime fleets agent status       # rounds, the last thing it did, and whether it is a service
```

The lease and the heartbeat are two numbers that have to agree. The heartbeat is
a third of the lease the fleet reports, a renewal that is lost is tried again after two
seconds, and one the gateway refused after the time it named (never more than a third of the
lease later), so more than one can fail before the place is gone - and a fleet keeps
answering its clients meanwhile. The beat does not wait for the rounds: it renews even when
the rounds are failing.

### The agent's settings

Four things can be set for the agent, in the shell that runs `prime fleets agent start`
(or `install`): `PRIME_FLEET_REPLICA` (`lazy` or `mirror`), `PRIME_FLEET_CACHE_MB`,
`PRIME_FLEET_POLL_MS` and `PRIME_FLEET_HEARTBEAT_MS`. They are written down in
`fleet-agent/settings.json`, so the login service, and an agent restarted after a crash, run
with the same.

- A value that means nothing (`sideways`, `-3`) is ignored.
- A clean shell changes nothing: what was saved stands. To go back to a default, name the
  variable empty (`PRIME_FLEET_REPLICA= prime fleets agent start`), or forget everything with
  `prime fleets agent reset`.
- `agent start` with a setting that differs from the one the running agent has restarts it. Several
  `agent start`s at the same time are fine: each writes its own temporary file, the lock lets one
  agent through, and the ones that lose it exit at once (they are started without waiting for the lock).
  Commands that only need an agent running, like `prime spaces create`, neither save what their
  shell exports nor restart it *for that*; they do restart it when the saved settings differ from
  the running agent's (for example right after `agent install` saved new ones).
- There is one login service per machine, and it runs the one configuration it was installed
  with (`--config`; `prime fleets agent status` prints it, and `status --json` has a `service`
  object). For that configuration (macOS, Linux), when its manager answers, the manager is what
  starts the agent: `agent start`, `spaces create` and a settings change ask it to start or
  restart it, and no agent is spawned beside it. An agent that was started by hand and is running
  when the service is installed (or is found beside it later) is stopped first, and `agent install`
  does the same, except for the service's own agent, which the manager replaces. If the manager
  cannot be reached (no login session on a headless machine, no user bus, a service file left by an
  install that failed) the service counts for nothing: the agent is handled directly, as if it
  were not installed - except that a settings change is refused while an agent is running (it may be
  the service's own, and a spawned one would make the manager's restarts collide with it): the settings
  are saved, the command says so, and they apply when the service restarts or from a shell that can
  reach the manager. If the manager answers and will not restart a running agent, the command
  says so and the agent keeps the settings it has.
  `agent stop` goes through the manager too: signalling the process of a service only has the manager
  start another a few seconds later, so it asks the manager to stop the service (`systemctl --user stop`,
  `launchctl bootout`). The service stays installed and stays stopped: `agent start` starts it now,
  and otherwise it starts again at the next login on macOS, and on Linux the next time the user's
  manager starts (a reboot, or the end of the last session when lingering is off), not at the next login
  while the manager keeps running. That is done only for the agent that is the service's: an agent
  started by hand beside the service is stopped itself, and the service is stopped as well when its
  manager holds it (it would start its own the moment the lock is free). If the manager holds the
  service and will not stop it, the process is stopped and the command says that the service starts
  another (`agent uninstall` removes the service).
  For any other configuration (`--config`, `PRIME_CONFIG`) the service is not its own: its agent
  is started, stopped and restarted directly, `agent status` says which configuration the service
  runs, `agent install` is refused while it runs another, and `agent uninstall` is refused too
  unless `--force` is given (remove the service from the configuration it runs, or force it).
  A definition that does not say (a hand-edited unit, a binary plist) is taken for the default
  configuration's.
  A systemd drop-in (`prime-fleet-agent.service.d/*.conf`) that sets `ExecStart=` is read the way
  systemd merges it: from the user's directory and the machine's (`/etc/systemd/user`, `/run`,
  `/usr/lib`, in systemd's order of priority, by file name, a file of the same name in a higher
  directory replacing the lower one), so `systemctl --user edit` and an administrator's drop-in are
  both followed. Not read: the directories named by `$XDG_CONFIG_DIRS` beyond `/etc/xdg` and by
  `$XDG_DATA_DIRS`, generator output, and the drop-ins that systemd applies to a whole type
  (`service.d/`) or a name prefix (`prime-.service.d/`); an `ExecStart=` set there is not seen, and the
  service is then taken for the default configuration's.
- One agent runs per configuration: a second one that is started exits, saying who holds the
  lock (`fleet-agent/agent.lock`, which the running agent touches every few seconds). A stopping
  agent is given ten seconds to let go. The lock names its holder, and where the process list
  cannot say what a pid is (Windows, or where neither `/proc` nor `ps` can see the process), a fresh lock that names the pid, or
  for an agent of a build from before the lock a fresh `state.json` that names it, is what counts.
  So the upgrade is: `prime fleets agent stop` (it stops an old agent too), then start the new one;
  `agent install` does the stop for you.

A member holds its place only while the gateway can see its device tunnel: a holder whose
device is not connected is taken out of the running the next time anyone asks. Spaces always
have a tunnel (`prime code-mcp --gateway ...`); an agent started on its own, without one, will
find the lease moving between members every few seconds. Run it beside a tunnel, or not at all.

## What it costs

A fleet is the expensive part of the gateway: its agents send a request every
few seconds, and each one is a request to an object, so the bill is mostly
object requests. An object is billed for its time only while it is working; one
that waits on a hibernated socket costs nothing.

An agent that can **listen** does not ask. It keeps one socket to its fleet, and the
fleet says when something happens: a new snapshot, the lease free, a pause, a resume.
The ping that keeps the socket honest is answered by the runtime without waking the
fleet, and an object with nothing to say is allowed to sleep. So while a fleet is
**paused** the gateway sees no request at all from its members, apart from one now and
then to renew the socket. Measured against a live gateway, three spaces over ninety
seconds:

| | requests to the Worker | requests to objects |
|---|---|---|
| paused, agents that ask (before) | 114 | 200 |
| paused, agents that listen | 4 | 0 |

A running fleet still sends the requests that are its work: the primary renews the
lease (every fifteen seconds) and publishes, the others fetch what was published. An idle
replica that does not mirror sends almost none: with a socket it asks for its place every
five minutes and looks at the head every ten (about 430 requests a day, where it was about
11,500); without a socket it asks for its place every fifteen seconds and the answer carries
the head (about 5,700, where it was about 132,000). A replica that mirrors, and so wants a
fresh work tree, looks at the head every round without a socket (about 63,000) and every
thirty seconds with one (about 3,100).

What a snapshot costs on the wire (2,000 files, 3.9 MB, one file edited per snapshot, a
replica that follows every one):

| | before | now |
|---|---|---|
| a snapshot, up | 2.0 KB | 2.0 KB |
| the checkpoint (every 32nd), up | 1.91 MB | 1.88 MB tree + 2 KB change |
| the checkpoint, a replica that is up to date, down | 1.91 MB | 2.8 KB |
| a snapshot while one member is far behind, up | 1.92 MB, each time | 2.0 KB |
| a member 39 snapshots behind catches up, down | 1.92 MB, 4 requests | 62 KB, 81 requests |

The gateway counts what it does - requests, how long each object was busy
serving them, the objects stored and read - and prices them at Cloudflare's list prices with
the free allowances taken off. `/admin` shows the month, the cost and what it is
made of.

The ceiling is `FLEET_MONTHLY_BUDGET_USD`, twenty dollars by default. At the
ceiling the fleet routes answer **402** and say so. The admin page keeps working,
because the operator has to be able to see the number that stopped it and raise
it, and so does everything that is not a fleet.

## Limits

| | |
|---|---|
| members per fleet | 32 |
| invite lifetime | ten minutes by default, one hour at most |
| lease | forty-five seconds, renewed every fifteen |
| snapshot | a thin delta pack per head; a whole tree every 32nd, and when the members change; one upload is at most 32 MiB, whole snapshot or change pack (the Worker holds a body about three times over while it hashes and stores it, in 128 MB; the member is told the limit and says so before it uploads anything, and the gateway answers 413 with the size too). A work tree whose whole tree is bigger than that stops the fleet at its next whole tree - every 32nd snapshot, and whenever the members change - and nothing more is published until the tree is smaller, so keep what is not the work's out of it with `.gitignore`; the members keep what they have |
| snapshots kept | the last 64 |
| a member's object store | collected the first time it passes 32 MB or `PRIME_FLEET_CACHE_MB` (512 by default), and again after it has grown by 64 MB or by half of what the last collection left; it keeps the snapshot the work tree holds, the newest fetched and what its indexes name, so a work tree bigger than the cap leaves it over the cap |
| `PRIME_FLEET_REPLICA` | `lazy` (the default: fetch ahead, apply when needed) or `mirror` (apply every snapshot as it is fetched) |
| `PRIME_FLEET_POLL_MS`, `PRIME_FLEET_HEARTBEAT_MS` | how often a replica looks at the head (1500 ms) and how long the primary waits between renewals at most (15000 ms; the fleet's own lease can lower it); saved like the others |
| a fleet nobody touches | cleaned up after a day |

## Known limitations

What is deliberately not done, so that nobody has to find it out:

- **The roster is the trust anchor, and the first one is taken on trust.** A gateway that lies about who
  the members are (adds a key of its own, or swaps a member's) can author snapshots, and a member that
  reads the roster for the first time has nothing of its own to compare it with. Only a fingerprint checked
  outside the gateway (`prime fleets members` on each machine prints it; the admin page shows the same
  one) would close it, and nothing in the product can check it for the operator.
- **Rollback and split views are not detected.** A member cannot know about a newer head it was never
  shown, and two members shown two different (each real) histories find out only when one of them
  publishes on a head the other does not have. Telling them apart would take a record that the members
  share outside the gateway (a witness, or a counter the members sign and keep), and the gateway is
  the only channel they have. Sizes in a manifest (`packBytes`) are not sealed: they steer the route,
  not the content.
- **The sequence a member left at is the gateway's word.** A replica trusts the key of a member that
  has left for the snapshots up to where the fleet says the head was when it did. A gateway that was
  malicious while that member was in the fleet can say a later sequence, as it can say the roster is
  anything; nothing here checks it outside the gateway.
- **Which fleet of a name it is is the gateway's word, taken on first use.** A member learns the id
  from the gateway when its space is set up, once it is admitted (`prime spaces create`: a first `prime
  fleets join` always waits for the operator, so the id is learnt there and not at the join; a member of
  before that was recorded learns it the first time it checks a snapshot), and keeps it: a replay of an older
  fleet's snapshot from storage (a bucket, a backup) is refused from then on. A gateway that lies about
  it once, to a member that has not yet learnt it - at the moment of joining - is believed, and
  nothing a member holds at that moment can say otherwise. A member that joins forgets what an
  earlier membership under the name left beside its key, once the join has been made (a join that
  failed changes nothing). It does not take a new key pair for the new membership, so snapshots sealed
  for its old key are still ones it could open. A gateway that does not say leaves the check out (and is
  asked again after a minute). Joining again as a member that already is one is not a new membership:
  what it has learnt stays.
- **Unsealed snapshots are taken until a sealed one has been taken in.** The check that a snapshot has
  not lost the seal its predecessors had needs a sealed snapshot that this member has taken in (applied,
  or fetched, in order: not one that was merely downloaded ahead). Until then there is nothing to compare
  with, and a gateway that withholds the pack of the first sealed snapshot (or fails it) while it shows an
  older, unsealed one as the head is a gateway the member cannot tell from a fleet that has never been
  sealed: the unsealed snapshot is accepted. The window closes with the first sealed snapshot the member
  does take in. After that a replica that has seen a sealed one refuses an unsealed one at or above it, so
  an old member that is promoted stalls the new replicas on the snapshot before it, until an upgraded
  member publishes (a whole tree) or the operator accepts that snapshot (`prime fleets trust accept`).
  The trust file (`<space>.key.trust.json`) is not tamper-evident: it is a file of the member's own
  user, and deleting it opens the same window again.
- **A member that was recorded before the fleet had an id learns it late.** A member whose trust file was
  made by a build without the id learns which fleet of the name it is the first time it checks a sealed
  snapshot, from the gateway, the same trust on first use as at a join (the window is longer).
- **`fetched` is informational.** It is how far a member says it has fetched; the gateway keeps it and the
  admin page shows it, and nothing decides on it (only `applied` gates the lease), so a member that
  reports it wrongly misleads nobody but the operator who reads it.
- **Objects can still be left in storage** when a publisher dies after uploading a checkpoint's change
  pack and before the snapshot request, or when the gateway itself fails between storing and asking
  the fleet object. A publish the fleet refuses removes what it stored, except a checkpoint's change
  pack when the publish is refused for its size by a gateway that does not say its limit (one before
  the limit was told to members): it stays, and each retry stores another.
- **A work tree that git cannot write fails inside git**, with a plain error and not an errno: it is
  retried with back-off, and is not recognised as "cannot be written" (which would stop the claim).
- **Names that differ only in case** (`README` and `readme`) from a case-sensitive member arrive as one
  file on a case-folding one; the member that takes over then publishes the other's deletion.
- **Two agents can overlap** for up to one touch of the lock (five seconds) plus one round when a lock is
  taken over at the same moment by two starters; the one that finds its lock gone stops. Breaking a stale
  lock (the agent's, or the one around a work tree's apply) is a rename, and a rename onto a directory that
  happens to be empty replaces it: with a stale lock and three starters at the same instant, one can
  think it holds a lock it has just lost. The window is microseconds, and the holder checks its own token
  before it lets go.
- **Windows** has no service-manager restart and no process list for the agent lock: it falls back to
  the lock's and state file's freshness (so an agent that does more than half a minute of work without
  touching its lock can lose it there). `prime fleets agent install` registers its own Scheduled Task
  (`\prime\prime-fleet-agent`), apart from the buddy's (`\prime\code-mcp`); Task Scheduler is not asked to
  restart it on a settings change, so a change there stops the agent and starts another. A machine whose
  agent was installed by a build before that has it under the buddy's name, `\prime\code-mcp`:
  `agent status` reports it there, and `agent install` and `agent uninstall` remove it (only when what it
  runs is `__fleet-agent`, never the buddy's `code-mcp --service`, and the `--config` it names is this
  configuration) and the agent process of that configuration, so installing again moves it. It is looked
  up by the task's action, so a task of that name that runs something else is left alone, and so is the
  agent task of another configuration: `agent status` names that configuration, and the command that
  moves it is `agent install` with its `--config`. There is one agent task per machine, as on the other
  platforms: `agent install` for a configuration is refused while `\prime\prime-fleet-agent` runs another
  (`agent uninstall` first, or `--force` on the uninstall of that one), and the task's own `--config` is
  what says which. The scripts' output is read as UTF-8, so a profile path with non-ASCII characters
  is compared as it is.

## Upgrading

What changes for a fleet and a machine that already run an earlier build.

- **Uploads are capped at 32 MiB** (it was not capped, and anything near 100 MB died inside the
  gateway). A fleet whose whole tree is bigger than that stops at its next whole tree: the 32nd
  snapshot, or the next time the members change. Until then the changes (deltas) go on being
  published; at that point the primary's round fails and nothing more is published. Every member
  keeps what it has. It is reported where the primary runs: `prime fleets agent status` shows the
  failure (`this snapshot is NN MB, and the gateway takes at most 32 MB for one ...`), and the snapshot is
  tried again every round, so it goes on by itself once the tree fits. To go on, make the work tree smaller (keep build output,
  dependencies and caches out of it with `.gitignore`) until its sealed whole tree is under the limit.
  Deploy the gateway first: upgraded members are then told the limit and refuse before uploading;
  members that are not upgraded yet are refused by the gateway, with its message (it follows "the fleet
  head moved while publishing:" in what they print), and leave the checkpoint's change pack behind on
  each attempt.
- **A sealed fleet does not go back to unsealed snapshots.** Once a fleet has a sealed snapshot, the
  gateway refuses a publish without a seal from an old build (it says to upgrade, the member carries on
  as a replica and the lease goes to a member that seals). Upgrade every member that may become the
  primary; a fleet whose members are all old builds does not move until one is upgraded. Deploy the
  gateway first (see "Roll out slowly" above).
- **The intermediate fleet test builds** (the ones that already sealed the incarnation or tagged the
  entries) are not all interoperable with this release: a member that has seen the sender's tag in an
  entry refuses a snapshot without it. Upgrade all of them together. Builds of the released line, which
  do not seal, are read as before.
- **On Windows**, an agent installed by an earlier build is registered under the buddy's task name,
  `\prime\code-mcp`. `prime fleets agent install` (or `uninstall`) for the configuration it runs finds
  it by what it runs, removes it and registers `\prime\prime-fleet-agent` in its place; `agent status`
  reports it meanwhile. The buddy's own task is never touched.
- **`prime fleets agent stop` now stops the service.** With a login service installed, signalling the
  agent's process only had the service manager start another a few seconds later. It now asks the
  manager to stop the service (`systemctl --user stop`, `launchctl bootout`); the service stays
  installed and stays stopped until `prime fleets agent start`, or until its manager starts it of itself
  (the next login on macOS, the next start of the user's manager on Linux). A machine that relied on
  `stop` being followed by a restart should use `agent start` (or `agent install`, which also stops an
  older agent first).

## Where to read more

- [Join](https://prime.tuanm.workers.dev/join) - the same story with a picture
- [The gateway](../api/README.md) - how a call travels, and what the endpoints are
- [The CLI](../cli/README.md) - every fleet command
