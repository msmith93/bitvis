# Build: Interactive OpenSearch Cluster Visualizer (Proof of Concept)

## Goal
A single-page React app that teaches how OpenSearch (Lucene) indexes and searches
documents **across a distributed cluster**. The user types a document, clicks
"Index," and scrubs step-by-step through the write path — watching the document
route to a shard, replicate to a second node, land in an in-memory buffer, and
(on refresh) become an immutable, searchable segment. They can index multiple
documents, refresh the buffers into multi-document segments, flush, merge
segments, and run a **search** that scatters across all nodes and is gathered by
a coordinator into a ranked response. Auto-play is available so each operation
can also run on its own.

## Tech
- React (Vite, single page). No backend — everything simulated client-side.
- Discrete boxes/badges/arrows whose state is animated; this is a teaching tool,
  not high-perf. Framer Motion for stage animations (routing, replication,
  segment writes, merges, scatter-gather).
- No localStorage/sessionStorage. All state in React state.

## Cluster topology (fixed)
A single index with **3 primary shards** and **1 replica each**, spread across
**3 nodes**. A replica is never placed on the same node as its primary, so every
shard's data lives on two different nodes:

| Shard | Primary | Replica |
|-------|---------|---------|
| 0     | node-1  | node-2  |
| 1     | node-2  | node-3  |
| 2     | node-3  | node-1  |

- Balanced: each node holds one primary + one replica (`node-1: P0,R2` ·
  `node-2: P1,R0` · `node-3: P2,R1`).
- **Coordinator:** node-1 by default (the node the client connects to). Any node
  can coordinate; fixed for a clear, repeatable demo.
- **Routing:** `route(_id) -> shard` decides which shard a document lands on,
  then it replicates to that shard's replica.

## Core interaction
1. User enters a small document (`title` + `body`). Provide 3–4 preset docs that
   share terms, plus a few example search queries.
2. **Index document** → walks the write path for that one doc and drops it in the
   routed shard's buffer (repeatable to accumulate docs).
3. **Refresh** → turns each shard's buffered docs into one new segment.
4. **Flush** → commits segments to disk and clears the translog.
5. **Merge** → consolidates a shard's segments into one.
6. **Search** → scatter-gather across the cluster, ranked and returned.
7. A stepper UI (Prev / Next / Play / Pause) controls and scrubs whichever
   operation is active. Each step shows a short explanation panel.

## Operations to model (KEEP THESE ACCURATE)
Model these as distinct, separately-viewable steps. Do not collapse them — the
distinctions are the whole pedagogical point.

### Index (write path), per document
1. **Coordinator receives the request** — client sends the doc to a coordinator.
2. **Route to the primary shard** — `shard = hash(_id) % number_of_shards`; the
   coordinator forwards the doc to that shard's PRIMARY copy on one node.
3. **Analysis** — the analyzer tokenizes + normalizes (lowercase, split on
   whitespace/punctuation) on the primary. The user sees THEIR words become terms.
4. **Primary buffer + translog** — added to the in-memory buffer and translog.
   NOT searchable yet. Make "not searchable" visually explicit.
5. **Replicate to the replica** — the primary forwards the doc to its replica on
   a DIFFERENT node, which buffers + logs it too; only then is the client acked.
   Data now lives on two nodes.

### Refresh
1. **Buffers → new segments** — each shard's buffered docs are written into ONE
   new, IMMUTABLE segment (multiple buffered docs ⇒ a multi-doc segment).
   Existing segments are never modified.
2. **Searchable** — new segments become searchable; buffers cleared; translog
   retained until flush.

### Flush / commit
1. **Commit to disk** — segments fsynced durably. Refresh ≠ flush: refresh made
   docs searchable; flush makes them durable.
2. **Translog cleared** — safe because data now lives in committed segments.

### Merge
1. **Select segments** — on each shard with several small segments, pick them to
   combine; identify tombstoned (deleted) docs to reclaim.
2. **One merged segment** — small segments replaced by one larger segment; old
   ones discarded; deleted docs physically dropped. Both copies merge.

### Search (scatter-gather, query-then-fetch)
1. **Coordinator receives the query** — query string analyzed into terms.
2. **Scatter (query phase)** — coordinator fans the query out to ONE copy of
   every shard (primary or replica), spread across nodes. This is why search runs
   on all nodes.
3. **Local search** — each contacted shard searches its own segments' inverted
   indexes, scores matches, returns its local top hits (doc ids + scores only).
4. **Gather + merge + sort** — coordinator merges all shards' hits and ranks.
5. **Fetch phase** — coordinator fetches full `_source` for the winning ids.
6. **Return to client** — merged, ranked results returned. Buffered and
   tombstoned docs never appear.

## Inverted index view
Each shard has its OWN inverted index (term → posting list of doc ids) built from
its searchable segments. Show these per shard. A search unions posting lists
across shards — a term shared by docs on different shards shows up from multiple
shards in the gathered results. This cross-shard union is the key "aha."

## Accuracy guardrails (don't get these wrong)
- Segments are IMMUTABLE. Writes create new segments; never edit existing ones.
- A document is NOT searchable until refresh creates its segment.
- Refresh ≠ flush. Refresh makes docs searchable (new segment); flush makes them
  durable and clears the translog. Keep these separate.
- A replica is always on a different node than its primary.
- Search is scatter-then-gather, coordinated by one node; two-phase
  query-then-fetch.
- Updates = new doc + tombstone on old; deletes = tombstone, reclaimed at merge.
- Don't expose analyzer config, shard/replica counts, or merge-policy tuning.
  This is a guided POC, not a configurable simulator. Keep the surface small.

## UI layout
- Left: document input + presets + Index; lifecycle buttons (Refresh / Flush /
  Merge / Reset); search box + example queries; document list (with each doc's
  routed shard and a delete/tombstone toggle).
- Center: the cluster — a coordinator/request bar on top, then 3 node columns,
  each showing its shard copies (primary/replica badges) with buffer, translog,
  and a stack of immutable segments. Highlights + animation follow the active op.
- Right: explanation panel for the current step + a context-sensitive inspector —
  per-shard inverted index during writes, or the scatter-gather results
  (per-shard local hits → coordinator's merged ranking) during search.
- Bottom: stepper (op label, Prev / Next / Play / Pause, step pips, count).

## Deliverable for this POC
- Working `npm run dev` Vite app.
- Index → full step-through with routing + replication works.
- Refresh → buffered docs become multi-doc immutable segments on both copies.
- Flush → segments committed, translog cleared.
- Merge → two segments become one; tombstoned docs reclaimed.
- Search → scatters to all shards, gathers a ranked response.
- Clean enough to screen-record. Don't over-engineer; it's a proof of concept.

## Flagged simplifications of the OpenSearch model
Documented so reviewers can verify the teaching stays honest:
- Routing is a deterministic string hash standing in for murmur3 `_routing`.
- Primary + replica are modeled as one logical shard rendered on two nodes (no
  replica lag; replica merges shown in lockstep with the primary).
- Relevance score is term-frequency, a stand-in for BM25.
- Replica selection during scatter is deterministic, not adaptive replica
  selection.
- Coordinator fixed to node-1; single index with 3 shards / 1 replica; no
  shard/replica/merge tuning exposed.
