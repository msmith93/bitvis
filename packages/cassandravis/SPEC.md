# Build: Interactive Cassandra Cluster Visualizer (Proof of Concept)

## Goal
A single-page React app that teaches how a Dynamo-lineage NoSQL store —
concretely, **Apache Cassandra** — replicates and stores data across a
leaderless cluster. The user puts a key/value, picks consistency levels, and
scrubs step-by-step through the write path: the key hashes onto the consistent
hashing **ring**, the coordinator walks the ring to find N replicas (skipping
repeat vnodes), fans the write out to ALL of them, and acks the client once
**W** replicas respond. Reads query **R** replicas, resolve conflicts by
last-write-wins timestamp, and repair stale copies. Each node runs its own
LSM-tree storage engine (memtable → immutable SSTables → compaction). Failure
scenarios show hinted handoff, gossip-based failure detection, and Merkle-tree
anti-entropy repair. Auto-play is available so each operation can run on its
own.

Where Cassandra and the Dynamo paper differ, the app teaches Cassandra and the
blurbs note the difference (LWW timestamps vs vector clocks; strict quorum +
hints vs sloppy quorum).

## Tech
- React (Vite, single page). No backend — everything simulated client-side.
- Discrete boxes/badges/chips whose state is animated; a teaching tool, not
  high-perf. Framer Motion for stage animations (ring walk, replica fan-out,
  flush/compaction, hint replay).
- No localStorage/sessionStorage. All state in React state.

## Cluster topology
- A **64-position token ring** (tokens 0–63), drawn as a circle.
- **4 physical nodes × 2 vnodes each** = 8 tokens, hand-interleaved so a
  clockwise walk quickly yields 3 distinct physical nodes:
  `node-1: [0, 34] · node-2: [8, 42] · node-3: [16, 50] · node-4: [24, 58]`.
- **Replication factor N = 3** (SimpleStrategy: walk clockwise from the key's
  token, take the first N *distinct physical* nodes — a vnode belonging to an
  already-chosen node is skipped).
- **Coordinator:** the node the client's driver is connected to (starts as
  node-1). Any node can coordinate; the coordinator is a peer — it is NOT a
  leader/primary. It lives in cluster state: the "crash the coordinator"
  scenario kills it and the driver reroutes to the next live peer, which
  coordinates from then on (the role does NOT move back on recovery — there is
  no role to win back).
- **Consistency levels** (for N=3): ONE = 1, QUORUM = 2, ALL = 3, chosen
  independently for writes (W) and reads (R).
- Ring tokens live in cluster state (not constants) so a joining node can
  re-slice the ring.

## Per-node storage (the LSM tree)
Every replica stores data through its own full local write path:
- **commit log** — append-only durability log (shown as a count).
- **memtable** — in-memory `key → {value, ts, tombstone}`; where writes land.
- **SSTables** — immutable on-disk tables created ONLY by flushing the
  memtable; removed ONLY by compaction. Each carries a bloom filter.
- **hints tray** — hints this node holds for down replicas (coordinator-side).

## Operations to model (KEEP THESE ACCURATE)

### Put (write path)
1. **Coordinator receives the request** — client sends `put(key, value)` with
   a chosen write CL. A timestamp is assigned to the mutation.
2. **Hash the key onto the ring** — `token = hash(key) mod 64`; the key's
   position appears on the ring.
3. **Walk the ring for N replicas** — clockwise from the token, first N
   distinct physical nodes; a same-node vnode is visibly skipped.
4. **Send to ALL N replicas in parallel** — never "write to only W nodes".
   Each LIVE replica appends to its commit log and writes its memtable.
   *(conditional)* If a replica is DOWN, the coordinator **stores a hint**
   for it instead — hinted handoff.
5. **Count acks vs W** — hints do NOT count toward W. If live acks ≥ W the
   client is acked (even though replication to all N continues in the
   background); otherwise the write FAILS (yet hints/live writes may persist —
   there is no rollback).

### Get (read path)
1. **Coordinator receives the query** — `get(key)` with a chosen read CL.
2. **Hash + ring walk** — same token, same N replicas.
3. **Query R replicas** — each live contacted replica runs its LOCAL read
   path: memtable first, then SSTables newest-first, checking each SSTable's
   bloom filter; returns `{value, ts}` (or a tombstone, or nothing).
4. **Resolve by newest timestamp** — last-write-wins across the R responses.
   *(conditional)* **Read repair**: if responses disagree, the coordinator
   writes the winning version back to the stale replicas.
5. **Return to client** — if live replicas < R, the read FAILS. A tombstone
   winner means "not found".

### Delete
A delete IS a write: it writes a **tombstone** with a fresh timestamp through
the same put path (all N, W acks). The tombstone must out-timestamp older
values on other SSTables and other replicas; the value is only physically
reclaimed at compaction.

### Flush (per node)
1. **Memtable → new SSTable** — the memtable is written out as one new,
   immutable SSTable (with its bloom filter). Existing SSTables are never
   modified.
2. **Memtable cleared, commit log truncated** — safe because the data is now
   durable in the SSTable.

### Compact (per node)
1. **Select SSTables** — a node with ≥2 SSTables merges them.
2. **One merged SSTable** — entries merged per key by newest timestamp;
   shadowed versions dropped; tombstones (and the values they shadow)
   physically reclaimed. (Real Cassandra keeps tombstones for
   `gc_grace_seconds` first; the sim drops them immediately and says so.)

### Node crash (scenario)
1. **The node goes silent** — no announcement; heartbeats just stop.
2. **Gossip spreads the suspicion** — peers exchange heartbeat state; the
   failure detector (phi-accrual, simplified) loses confidence.
3. **Marked DOWN cluster-wide** — the sim converges in one step (flagged);
   the node's data is NOT re-replicated; it is just unavailable.

### Crash the coordinator (scenario)
The leaderless showcase — same crash mechanics, aimed at the one node that
LOOKS special:
1. **The coordinator goes silent** — heartbeats stop, like any node.
2. **Gossip converges on DOWN — and nothing gets elected** — this is the
   moment a leader-based store would detect the loss, run a failover election,
   promote a follower, and stall writes until done. Here nothing starts,
   because the coordinator owned nothing exclusive.
3. **The driver picks the next live peer** — the client's driver already knows
   every node; it opens a connection to another peer, which is now "the
   coordinator" purely by being talked to. Subsequent requests genuinely flow
   through it. The crashed node's replica data heals via hints/repair like any
   crash; on recovery the client keeps its new connection.

### Recover node (scenario)
1. **The node comes back** — gossip marks it UP.
2. **Hint replay** — nodes holding hints for it stream them; the recovered
   node applies each hinted mutation through its normal local write path
   (memtable), catching up on what it missed.

### Repair (anti-entropy)
1. **Build Merkle trees** — for a token range, each replica hashes its data
   into a small tree (2 levels in the sim).
2. **Compare** — roots equal ⇒ in sync, done. Otherwise mismatching leaves
   identify divergent key buckets.
3. **Stream differences** — replicas exchange only the divergent entries;
   newest timestamp wins on both sides. This catches divergence that hints
   and read repair missed.

### Add node (scenario, stretch)
1. **Gossip announces the joiner** — a new node with its own tokens.
2. **Ring re-slices** — arcs re-divide; the new node now owns ranges.
3. **Stream data** — previous owners stream the keys in those ranges to the
   joiner; they stop serving those ranges once streaming completes.

## Accuracy guardrails (don't get these wrong)
- **Leaderless.** No primary/leader/master anywhere. Any node can coordinate
  any request; replicas are peers. Never draw a "primary" badge.
- Writes go to **ALL N replicas, always**. W/R are how many acks the
  coordinator WAITS for, never how many copies are made or contacted-then-stop.
- **Hints do not count toward W** (Cassandra). A write can fail its CL and
  still have landed on some replicas — no rollback. (Dynamo's sloppy quorum
  differs: spill-over writes count; note in blurb.)
- **W+R > N** is what guarantees a read overlaps the latest successful write.
  ONE/ONE (1+1 ≤ 3) can legitimately return stale data — show it, don't hide it.
- Conflict resolution is **last-write-wins by timestamp** (Cassandra), not
  vector clocks (Dynamo). Blurbs say which system does which.
- **SSTables are immutable.** Only a flush creates one; only compaction
  removes them. Writes never touch an SSTable.
- **Deletes are writes** (tombstones). A read that finds a newer tombstone
  returns "not found" even if older SSTables/replicas still hold a value.
- **Bloom filters** can say "maybe" falsely, never "no" falsely. They let the
  read path SKIP SSTables; they never answer a read.
- Local read order: **memtable, then SSTables newest-first**; the newest
  timestamp wins, not the first value found.
- Replica placement: clockwise ring walk over **distinct physical nodes**
  (skip repeat vnodes). SimpleStrategy — no racks/DCs.
- Failure detection is **gossip-based and decentralized** — a DOWN node is a
  peer's converged opinion, not an announcement from anywhere central.
- The coordinator does not store the data it coordinates (unless it happens
  to be one of the N replicas — with 4 nodes and N=3 it often is; the UI must
  distinguish "coordinating" from "replica of this key").

## UI layout
- Left: key/value inputs + presets; W and R consistency pickers with a live
  `W+R>N` badge; op buttons (Put / Get / Delete / Flush / Compact / Repair /
  Reset); the key list (key → token → its 3 replicas, with a stale marker).
- Center: the **ring** (SVG circle, token ticks colored by node, the key's
  hash marker, the animated replica walk) above the **4 node cards**
  (memtable, commit log count, SSTable stack with bloom chips, hints tray,
  DOWN overlay). A scenario bar (crash / recover / add node) sits above.
- Right: explanation panel for the current step + a context panel — per-replica
  read responses with the LWW winner during a get, quorum math during a put,
  Merkle comparison during repair.
- Bottom: stepper (op label, Prev / Next / Play / Pause, step pips, count).

## Deliverable for this POC
- Working `npm run dev` Vite app.
- Put → full step-through with ring walk, replica fan-out, quorum ack math.
- Get → per-replica reads, LWW resolution, read repair on divergence.
- Delete → tombstone through the write path.
- Flush / Compact → memtable → SSTable → merged SSTable with tombstone GC.
- Crash / Recover → hints stored on writes, replayed on recovery.
- Repair → Merkle compare + streaming of divergent entries.
- Clean enough to screen-record. Don't over-engineer; it's a proof of concept.

## Flagged simplifications of the Cassandra model
Documented so reviewers can verify the teaching stays honest:
- 64-position token space; 4 nodes × 2 vnodes fixed (real: 2^63 range,
  num_tokens=16+ per node).
- Timestamps are a logical counter, not microsecond wall clocks.
- The "bloom filter" is exact membership over the SSTable's keys (never a
  false positive); blurbs explain real false positives. Exception: the
  read-path close-up renders a real 16-bit/2-probe filter from the table's
  actual bits, so it can (rarely) show an honest false positive — "maybe → read
  → not here". This never changes the returned value (last-write-wins is
  identical), and the node cards / `readValue` keep the exact-membership
  stand-in.
- Reads contact R replicas with full reads (real Cassandra sends one data
  read + digest reads).
- Read repair is always synchronous when divergence is seen (real: blocking
  only within the CL contact set; historically probabilistic beyond it).
- Tombstones are reclaimed at the first compaction (`gc_grace_seconds`
  elided; blurb explains why it exists — resurrection risk).
- Merkle trees are 2 levels over a handful of key buckets.
- Gossip/failure detection converges in a single step; phi-accrual reduced to
  "heartbeats stopped".
- Coordinator starts at node-1 and moves only via the "crash the coordinator"
  scenario (real drivers spread requests across MANY coordinators, often
  per-request round-robin/token-aware); no partitioner/snitch/rack/DC config.
- Commit-log replay on restart is modeled as the memtable simply surviving
  the crash (the net effect is identical); a recovered node relies on
  hints/repair only for the writes it missed while down.
- A request whose CL is already infeasible (too few replicas up) still
  animates the attempt so the stepper has something to show; real Cassandra
  fails fast with Unavailable — writing nothing and storing no hints — and
  the failure blurbs say so (the shown behavior matches a TIMEOUT failure).
- Hint replay is instant and complete on recovery (real: throttled, and hints
  expire after a window, e.g. 3h).
