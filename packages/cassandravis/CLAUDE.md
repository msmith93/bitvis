# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this package.

> This app is `packages/cassandravis` in the **bitvis** monorepo (npm
> workspaces). Run `npm install` once at the repo root. Deploy infra lives at
> the repo root (`infra/`, `scripts/`); deploy this site with
> `../../scripts/deploy.sh CassandravisStack`.

## Commands

- `npm run dev` — start the Vite dev server (the primary way to run/verify).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` locally.

There is no test runner, linter, or formatter configured. The deliverable is a
screen-recordable proof-of-concept (see `SPEC.md`), so "verify" means running
`npm run dev` and stepping through put → get → flush → compact → crash →
recover → repair, scrubbing Prev/Next across step boundaries.

## What this app is

A single-page React (Vite) app that teaches how a Dynamo-lineage NoSQL store —
concretely Apache Cassandra — replicates and stores data across a leaderless
cluster: consistent-hashing ring with vnodes, tunable consistency (W/R against
N=3), hinted handoff, read repair, Merkle-tree anti-entropy, gossip failure
detection, and each node's LSM-tree storage engine. Everything is simulated
client-side — no backend, no localStorage, all state in React. `SPEC.md` is
the authoritative description of intended behavior AND the Cassandra-accuracy
guardrails (leaderless — never a primary; writes go to ALL N replicas and W is
only the ack count awaited; hints don't count toward W; LWW by timestamp;
SSTables immutable; deletes are tombstone writes; bloom filters only skip
SSTables). Treat those guardrails as correctness requirements — read `SPEC.md`
before changing the model.

## Architecture

Same core pattern as the sibling `opensearchvis`/`kubevis` packages: a **pure
derivation of visible state from `(cluster, op)`**, which lets the stepper
scrub any operation forwards and backwards.

- **`cluster`** (`src/cluster.js`) is the committed state:
  `{ nodes, keys, coordinator }`. Ring tokens live IN cluster state
  (`nodes[id].tokens`) so a joining node can re-slice the ring, node liveness
  is dynamic (`nodes[id].up`), and the coordinator is dynamic too (starts at
  node-1; the `coordCrash` scenario moves it — ops read it from their payload
  as `p.coord`, captured at start()). Each node
  carries its own LSM storage: `memtable` (`key → {value, ts, tombstone}`),
  immutable `sstables` (`[{ id, entries }]`), a `commitLog` count, and a
  `hints` tray. `hashKey` is the deterministic partitioner stand-in;
  **`replicasFor(cluster, key)`** is the core placement function (clockwise
  walk from the key's token over DISTINCT physical nodes, skipping repeat
  vnodes — the Ring component animates exactly this walk, so keep them in
  sync); `readValue(node, key)` is the local read path (memtable, then
  SSTables newest-first via bloom check) returning a trace the UI renders.
  `cloneCluster` deep-clones per-node storage, so `derive` must REPLACE
  objects (spread), never mutate them.

- **`op`** = `{ type, step, payload }` (held by `useOpLifecycle`). Each op
  type (`put`, `get`, `del`, `flush`, `compact`, `nodeCrash`, `recoverNode`,
  `repair`) is one module in `src/ops/` declaring
  `{ type, label, steps | stepsFor(payload), derive?, extra?, duration? }`.
  **`steps` may be a function of the payload** (unlike the sibling apps):
  put/get legitimately grow steps when the hint or read-repair branch applies.
  The payload is fixed at `start()` time, so steps are static per op instance
  and scrubbing stays deterministic. Payloads precompute everything impure —
  the LWW timestamp (`ts` from App's logical-clock ref), replica sets, which
  replicas are down, whether read repair fires — so `derive` is pure.
  Adding an op type = one new module + a registry entry in `src/ops/index.js`.

- **Derivation** (dispatched by `src/ops/index.js`):
  - `deriveCluster(cluster, op)` returns how the cluster should *look* at the
    current `op.step` — always clones, applies the module's partial effect of
    steps `<= op.step`. Single source of the rendered cluster.
  - `opExtra(cluster, op)` returns transient step info: `focus` (which nodes
    glow), `flights` (chip flights between `data-fly`-tagged elements),
    `ring` (the walk/hash marker state for the Ring), and op-specific panels
    (per-replica read responses, quorum math, Merkle comparison).
  - `applyOp(cluster, op)` = `deriveCluster` at the last step; folds a
    finished op into committed state (no-op for ops without `derive`).
    `start()` folds the previous finished op before beginning a new one.

- **`src/useOpLifecycle.js`** owns the op state machine (ported from
  opensearchvis): `cluster`/`op`/`opDone`/`playing`, the auto-play clock,
  memoized `derived`/`extra`, `start`/`step`/`play`/`pause`/`resetTo`, and
  the `has*` capability flags. **`App.jsx`** keeps UI state (key/value
  inputs, W/R consistency picks, the logical-clock and naming refs) and
  builds op payloads.

- **`src/timing.js`** holds every animation-scheduling constant (flight
  stagger/travel/pad) so step budgets (`flightAwareDuration` in
  `src/ops/shared.js`) and framer transitions stay in sync.

- **Components** (`src/components/`) are presentational, driven by the
  derived cluster + `opExtra`: `Ring` (the SVG ring — token ticks, range
  arcs, hash marker, animated replica walk), `ClusterStage` (the 4
  `NodeCard`s: memtable, commit log, SSTable stack with bloom chips, hints
  tray, DOWN overlay), `ChipFlight` (viewport-coordinate chip flights between
  `data-fly` elements, ported from kubevis), `ReadResultsPanel` (per-replica
  responses + LWW winner + quorum math), `ConsistencyPicker` (ONE/QUORUM/ALL
  with the `W+R>N` badge), `MerkleView` (repair comparison), `ScenarioBar`,
  `Stepper`, `Walkthrough`. Framer Motion drives the stage animations.
