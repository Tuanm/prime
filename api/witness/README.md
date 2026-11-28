# prime-witness

A small second Worker that holds the newest signed checkpoint of each fleet member, outside the gateway, so a
member can notice when the gateway shows it an older history than another member saw. It keeps no secret and has
no login. Deploy it apart from the gateway: `cd api && wrangler deploy -c witness/wrangler.toml`. Tests: `bun test witness/test`.

**Deploying:** set `OWNER_KEYS` in `witness/wrangler.toml` to the owner public key(s) of the fleets it serves (the key
`prime fleets roster init` generates; it is public) **before the first deploy**. Empty means none: the witness holds no
fleet until it is set, so it is never open by accident; `"*"` allows any owner, which lets anyone fill the witness with
fleets of their own making. A fleet whose owner is no longer listed is refused at once and deleted by the daily alarm.
`MAX_FLEETS` (1000) and `FLEET_CREATES_PER_HOUR` (10 per address) bound what is left.

## Exact forms (the contract for the roster and the client)

Everything below is hashed or signed over **`JSON.stringify` of the value as a parsed JavaScript array**, so every
party must re-serialise the array itself, never hash stored or pretty-printed text.

- A roster entry is a 13-element array `["prime-roster-v1", fleet, incarnation, n, prevHash, at, op, device, xpub, spub, role, seqAt, extra]`.
  Every element is a string of at most 256 characters, a safe integer, or `null`; nothing else (no objects, no floats).
  `fleet` and `incarnation` are `[A-Za-z0-9._~:+=/-]{1,128}`. Signatures are Ed25519 over `utf8(JSON.stringify(entry))`.
- **Public keys are base64url (no padding) of the raw 32 bytes**, not SPKI and not PEM: the genesis entry's `extra`, and
  every entry's `spub` (index 9). Signatures are base64url of the raw 64 bytes.
- **`fleetKey` = base64url(sha256(utf8(JSON.stringify(genesis entry))))**: the entry alone, without its signature (unlike
  `prevHash`, which covers entry and signature). 43 characters. Only someone who holds the genesis can name a fleet.
- The genesis entry has `n` = 0, `op` = `"genesis"`, and the owner's public key in `extra`.
- The witness reads only `fleet` (1), `incarnation` (2), `n` (3), `op` (6), `device` (7), `spub` (9), `extra` (12) of an entry.
  `device` is a token (`[A-Za-z0-9._~:+=/-]{1,128}`) on every `add`, `rotate`, `rotate-self` and `remove` entry that is used as proof.

## Wire

**`POST /w/<fleetKey>`**, at most 4 KiB:

```
{ "cp":    ["prime-cp-v1", fleetKey, fleet, incarnation, seq, manifestHash, rosterN|null, ts],
  "sig":   base64url Ed25519 signature by spub over utf8(JSON.stringify(cp)),
  "spub":  base64url raw 32-byte Ed25519 key of the member,
  "proof": optional, see below }
```

`manifestHash` is a token as above; `seq` and `rosterN` are non-negative integers; `ts` is milliseconds, at most 10 minutes
ahead of the witness. `fleetKey` inside `cp` must equal the one in the URL, so a checkpoint cannot be replayed into another
fleet; `fleet` and `incarnation` must equal the genesis entry's.

**Proof** of membership, `{genesis, entry, sig}`: `entry` is a roster entry (`op` `add` or `rotate`) that names the signer as
its `spub` and a `device`, signed by the genesis owner; `genesis` is the genesis entry (the witness checks its hash against
the fleetKey, so the poster cannot choose the owner). Or `{entry, sig, by}`: a `rotate-self` entry signed by `by`, the key
that holds the device's slot here. A proven member sends the proof once (and again when its key changes) and omits it after.
The first checkpoint of a fleet must carry an owner proof, and the genesis owner must be in `OWNER_KEYS`.

**`POST /w/<fleetKey>/remove`**, `{genesis, entry, sig}` with a `remove` entry the owner signed (it is public in the
roster chain, so anyone may post it): frees the device's slot and retires its key.

**`GET /w/<fleetKey>`** → `{v: 2, now, checkpoints: [{cp, sig, spub, tier, at}]}`, newest post first; 404 for a fleet the witness
does not hold. `tier` is `proven`, `unproven` or `retired`. **`GET /status`** → `{fleets, max, refused, lastRefusedAt}`;
`refused` > 0 means the witness is turning fleets away (alert on it).

Answers: 400 malformed or not for this fleet (with `"reason": "proof-required"` when the fleet is not held and the post carried no
owner proof: **resend the checkpoint with the proof**, which happens when the fleet was deleted after a year idle, and is what
a client must do on that 400), 401 a signature does not verify, 403 owner not in `OWNER_KEYS` (also for a held fleet whose owner no longer is), 409 the key was
replaced or removed, or a later roster entry for its device was seen, or a rotation vouched for by a key without the slot,
413 body too big, 429 rate limit or creation quota (`retry-after`), 503 the limiter is down and a new fleet cannot be made now,
507 a tier or the witness is full.

## What it keeps

- **Slots are per device.** The roster's owner-signed entries name a `device` and a key. Up to 64 live devices per fleet
  hold a **proven** slot for their current key; a later `add`/`rotate`/`rotate-self` for the same device takes that device's slot
  (the older key keeps its newest checkpoint as `retired` history for 30 days, and never posts again, not even as unproven, unless the owner adds it back with a later entry; up to 1024 such keys are remembered), so key changes never use up
  slots; an owner-signed `remove` frees one. The `n` of the entry orders them: an entry for a device with a lower `n` than one
  already seen is refused, so replaying an old entry from the public chain undoes nothing.
- **Unproven** signers (no proof): up to 8, a separate quota, dropped after 30 days without anything new. Proven signers are
  never displaced by them, and a full tier answers 507; nobody is evicted to make room. Treat a 507 as an alert.
- Rows are (signer, manifest hash): the highest seq seen for each. A signer keeps its latest 32 rows (8 unproven) and a tier
  512 (32), so one busy signer cannot push another's history out; every signer's newest checkpoint always stays. Two signed
  checkpoints for one seq with different hashes stay visible as a fork for as long as that history lasts: 32 posts of the
  signers involved. At one post per 10 s, that is about 5 minutes for a busy signer, so a client that reads once a minute sees it.
- A checkpoint older than its signer's newest (lower seq) is acknowledged with `stored:false` and ignored; an identical repost
  changes nothing.
- A fleet with nothing new for a year is deleted and forgotten (daily alarm). At most `MAX_FLEETS` fleets.

## What a client must do

- Judge staleness by the **signed `ts`** of a checkpoint, never by `at` and never by list order: neither is signed.
- Post on every new head seq that the member publishes or takes in, at most one post per 10 seconds per member (the latest
  supersedes the skipped ones); a sample every 5 minutes can miss two members' equal-seq pair, an every-seq post cannot.
- Read at most once a minute and on each head change. The per-address limit is 60 a minute, shared by everyone behind one
  address, and counted per /64 for IPv6.
- Verify every returned `sig`, and judge the `spub` against its own roster chain: the witness checks signatures and the owner's
  proof, not the chain's whole history. **Ignore a checkpoint signed by a key that the verified chain has removed, when its
  `seq` is above the `seqAt` of the `remove` entry**; the witness cannot tell that a removed key's later checkpoints are not
  genuine unless someone posts the `remove` to `/remove`. Posting it there is the operator CLI's job when it signs the remove.
- Unreachable witness means "unwitnessed" and never blocks. A 507 or 429 on creation is not "unwitnessed": report it.

## Limits and known limitations

- 60 requests a minute per address (the `LIMITER` binding, plus a bounded per-isolate counter). If the binding itself fails,
  reads and posts to fleets the witness already holds continue; creating a fleet is refused with 503 until it recovers.
- A fleet the witness holds is remembered by each isolate for 5 minutes, so a request for it skips the registry.
- **Owner key rotation is not followed.** Proofs are checked against the genesis owner only. After an `owner-rotate`, members
  the new owner adds can post only as unproven (8 slots), which a party that can name the fleet may fill; re-init (a new
  genesis, a new fleetKey) is the route. Accepting an owner-rotate chain inside `proof` can be added later without breaking the
  wire.
- A `remove` the witness has not been sent is invisible to it: the removed key keeps its device's slot until a later entry for
  the device or a posted `remove` replaces it.
