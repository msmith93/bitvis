# Cassandra Cluster Visualizer

An interactive, single-page teaching tool that shows how a **Dynamo-lineage
NoSQL store — Apache Cassandra** — replicates and stores data across a
leaderless cluster. Put a key/value, pick your consistency levels, and scrub
step-by-step through the write path — watch the key hash onto the consistent
hashing ring, the coordinator walk the ring for 3 replicas (skipping repeat
vnodes), the write fan out to *all* of them, and the client get acked once
**W** replicas respond. Then read it back at **R**, crash a node to see hinted
handoff, bring it back for hint replay, and run a Merkle-tree repair.

Everything is **simulated client-side** — no backend, no storage. It's built to
be screen-recorded and stepped through, not to be a configurable cluster.

**Live demo:** [cassandravis.bitsculpt.top](https://cassandravis.bitsculpt.top/)

## What it teaches

The whole point is to make the distinctions that usually get glossed over
*visible and steppable*:

- **The ring & vnodes** — `hash(key) → token`, then a clockwise walk collects
  the first N *distinct physical* nodes; a vnode of an already-chosen node is
  visibly skipped.
- **Leaderless writes** — there is no primary. The write goes to **all N
  replicas, always**; W is only how many acks the coordinator *waits for*.
- **Tunable consistency** — `W + R > N` is why QUORUM/QUORUM reads see the
  latest write, and ONE/ONE can legitimately return stale data. Try both.
- **Hinted handoff** — a write to a down replica becomes a *hint* on the
  coordinator; hints don't count toward W, and they replay on recovery.
- **Read repair & LWW** — reads compare replica responses by timestamp
  (last-write-wins) and write the winner back to stale copies.
- **The LSM tree** — every replica has its own commit log, memtable, and
  immutable SSTables; flush creates SSTables, compaction merges them and
  reclaims tombstones; bloom filters let reads skip SSTables.
- **Deletes are writes** — a delete writes a tombstone that must out-timestamp
  the value everywhere; the space comes back only at compaction.
- **Anti-entropy repair** — replicas compare Merkle trees per token range and
  stream only the divergent entries.

## Cluster topology

A **64-position token ring** with **4 nodes × 2 vnodes** and **replication
factor N = 3** (SimpleStrategy):

| Node   | Tokens   |
|--------|----------|
| node-1 | 0, 34    |
| node-2 | 8, 42    |
| node-3 | 16, 50   |
| node-4 | 24, 58   |

node-1 is the coordinator by default (any node could be — it's a peer, not a
leader). Consistency levels for N=3: ONE (1) · QUORUM (2) · ALL (3), picked
independently for writes and reads.

## Running it

```bash
npm install
npm run dev      # start the Vite dev server
```

Then step through: **Put → Get → Flush → Compact**, and use the *simulate* bar
to **crash a node → Put (watch the hint) → recover it (watch the replay) →
Repair**. Use the bottom stepper (Prev / Next / Play / Pause) to scrub any
operation forwards and backwards.

Other scripts:

```bash
npm run build    # production build to dist/
npm run preview  # serve the built dist/ locally
```

## Tech

React + Vite, with [Framer Motion](https://www.framer.com/motion/) driving the
stage animations. The core pattern is a **pure derivation of visible state from
`(cluster, op)`**, which is what lets the stepper scrub each operation in both
directions. See [`SPEC.md`](SPEC.md) for the authoritative behavior spec and
the Cassandra-accuracy guardrails, and [`CLAUDE.md`](CLAUDE.md) for an
architecture overview.

## Honest simplifications

This is a teaching POC, so a few things stand in for the real thing (all
documented in [`SPEC.md`](SPEC.md)):

- 64-token ring and a logical-counter timestamp stand in for the real 2^63
  token range and microsecond clocks.
- The "bloom filter" is exact membership (never a false positive); the blurbs
  explain real false positives.
- Reads are full reads from R replicas (real Cassandra: one data read +
  digest reads); read repair is always synchronous.
- Tombstones are reclaimed at the first compaction (`gc_grace_seconds` elided).
- Gossip converges in one step; the coordinator is fixed to node-1.

## Authorship

The vast majority of this project — the simulation model, the step-by-step
operation derivation, the UI, and the animations — was developed by **Claude**
(Anthropic) via Claude Code.
