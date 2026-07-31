# Build: Interactive Elasticsearch Cluster Visualizer (Proof of Concept)

## Goal
A single-page React app that teaches how Elasticsearch (Lucene) indexes and searches
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
   on all nodes. **With a routing key this is the exception**: `hash(_routing)`
   names the single shard that can hold the data, so only that shard is asked and
   the others stay idle. Routing must be supplied at index time AND query time.
3. **Local search** — each contacted shard searches its own segments' inverted
   indexes, scores matches, returns its local top hits (doc ids + scores only).
4. **Gather + merge + sort** — coordinator merges all shards' hits and ranks.
5. **Fetch phase** — coordinator fetches full `_source` for the winning ids.
6. **Return to client** — merged, ranked results returned. Buffered and
   tombstoned docs never appear.

### Wildcard queries (term-dictionary cost)
A segment's term dictionary is SORTED, which is the whole reason wildcards differ
so much in price. Model both paths and keep the distinction visible:
1. **A pattern with a literal prefix** (`sc*` — what Elasticsearch calls a *prefix
   query*) is resolved by SEEKING to where that prefix belongs and then reading
   forward only while the prefix still holds, stopping at the first term that
   doesn't. The rest of the dictionary is never touched.
2. **A leading wildcard** (`*search`) has no prefix to seek to — a match can sit
   anywhere — so EVERY term in the dictionary is read and tested. Per segment,
   per shard.
3. **Expansion** — the matched terms are collected and the query becomes a
   boolean OR over them. The expensive part was the dictionary work, not the
   matching, and the cost multiplies by segments × shards.

## Inverted index view
Each shard has its OWN inverted index (term → posting list of doc ids) built from
its searchable segments. Show these per shard. A search unions posting lists
across shards — a term shared by docs on different shards shows up from multiple
shards in the gathered results. This cross-shard union is the key "aha."

## On-disk anatomy (the deepest zoom — KEEP THESE ACCURATE)
The flat two-column table above is a drawing, not a layout. A fourth zoom level
(reached by the 🔍 on a segment's column heads, inside the shard close-up) shows
what one segment's structures actually are. Three separate zooms, three models:

### Term dictionary — `.tip` + `.tim` (`src/blocktree.js`)
1. **`.tip` is an FST**: a minimized automaton, held in MEMORY, whose arcs are
   single characters and whose states can carry a `.tim` file pointer. It maps a
   term PREFIX to the one block that could hold it.
2. **`.tim` is blocks** of 25–48 entries; an entry is either a term or a pointer
   to a SUB-BLOCK, so the dictionary is a tree. A prefix that outgrows one block
   is split into FLOOR BLOCKS, and the FST output for that prefix then has to name
   the leading byte + pointer of each floor block so the seek can choose.
3. **Prefix compression**: a block stores its shared prefix ONCE and only the
   suffix each term adds ("search"/"searchable"/"searching" → "arch"/"archable"/
   "arching" under "se").
4. **A seek costs one in-RAM FST walk plus exactly ONE disk read**, regardless of
   dictionary size. That is the number to teach, against the ~log₂(n) scattered
   probes the flat binary search one level up needs.
5. A term outside the field's min/max term is rejected with **zero** disk reads.
6. Per-term metadata is `docFreq` plus pointers into `.doc`/`.pos`/`.pay`.

### Postings — `.doc` — deliberately NOT modelled
A zoom existed for this (segment-local ordinals, delta encoding, bit-packed
blocks, VInt tail, skip lists, `nextDoc`/`advance`/leapfrog) and was **removed**.
Don't rebuild it. The reasons, so the decision isn't re-litigated:

- **The concept is already taught one level up.** The shard inspector's "Walk the
  posting lists" step says what a posting list is — which documents contain a
  term. The zoom only added on-disk *encoding*, which is not what a reader needs
  to understand search.
- **This dataset cannot demonstrate it.** On the merged shard-0 segment (24
  terms): **22 of 24 terms have no skip data at all**, **22 of 24 have ≤1 packed
  block**, and the best case (`search`) is 4 postings in 2 blocks with no VInt
  tail — 2 bytes against 16. More than half the zoom rendered "there isn't one
  here". Fixing that means enlarging the sample set, which would perturb the
  tuned `search` ×4/×3/×2/×1 counts the top-k eviction demo depends on.
- **It read as mechanism without purpose** — every step titled after a technique
  rather than a reason, and reached with no narrative bridge.

What survives: the `.tip → .tim → .doc → .fdt` chain (so `.doc` is still visibly
"which documents", distinct from `.fdt`, "the text"), the dictionary zoom's
closing line naming the `.doc` pointer, and one clause in the shard inspector
noting Lucene writes no skip data below 128 documents.

### Wildcards — the same picture, driven by a pattern (`src/automaton.js`)
A wildcard is **not a separate zoom**. A plain term is the degenerate case of a
pattern — one path through the FST, one block read — so the dictionary zoom
serves both and the query decides how the walk behaves. They were two close-ups
drawing the same two structures; that duplication is why they were merged.

1. The pattern compiles to an NFA, then is **determinized** (Lucene caps this at
   `maxDeterminizedStates` = 10000).
2. The automaton is run against the `.tip` arcs in lockstep. An arc it has no live
   transition for is **pruned** — every term behind it is skipped unread.
3. A **leading wildcard's start state accepts any character**, so no arc can ever
   be pruned and every block loads. The cost difference is therefore STRUCTURAL,
   not a heuristic. Both numbers must be derived by running the two automata,
   never written into the copy.
4. **Do not rebuild the DFA transition table.** It was rendered and removed: for
   `sc*` it was 3 rows × 16 columns of mostly em-dashes, and because `maxCols`
   truncated at 14 while the segment had 19 distinct characters, `s` — the one
   transition that explains the pattern — fell off the end, leaving the start row
   entirely blank. The FST already shows the consequence directly and in colour.
   One line stating what the pattern accepts (from `startAcceptsAnything`) carries
   everything the table did.

### How this level must be PRESENTED
The structures above are only half the job. Two earlier builds modelled them
correctly and still failed: the first was illegible, the second was legible but
read as a slide deck about an inverted index rather than a picture of one
working. These are requirements, not polish:

- **The dictionary zoom is about the FST, and it is ONE PICTURE.** The term index
  on the left under "in memory", the blocks it indexes on the right under "on
  disk", both on screen for **every** step. A step may only change what is lit up
  — the walk, then the single block that gets read. Never swap the content area
  per step; that is what made it a slideshow. `stages/coordMerge.jsx` is the
  in-repo precedent for a persistent stage.
- **The lesson is the memory footprint**, and the layout carries it: a small graph
  that stays resident, a dictionary that does not, and exactly one block crossing
  between them. Blocks not read must be visibly dimmed rather than absent.
- **State the memory claim with its caveat.** The FST indexes BLOCKS, not terms —
  that is what holds at any scale. But our toy blocks hold 4 entries, so the
  on-screen ratio (~2×) badly understates Lucene's ~30× at 25–48 terms per block.
  Show the derived counts, name the real block size, and say the demo understates
  it. Never quote the toy ratio as the saving.
- **Label FST states with the prefix that reaches them**, not their id.
  Minimization renumbers by post-order DFS, so the start state gets the HIGHEST
  id and a raw-id walk appears to run 9 → 7 → 6. Use `statePrefixes()`, which
  returns null for any state several prefixes reach so the label can fall back
  honestly.
- **Keep the four-hop chain on screen.** `.tip` (which block) → `.tim` (which
  term) → `.doc` (which documents) → `.fdt` (the text). Collapsing the first and
  last hop — reading `.tip` as "points at the document" — is the natural mistake
  when the chain isn't drawn, and it was the first thing a reader got wrong.
- **Depth that isn't the lesson belongs elsewhere.** The block tree, prefix
  compression and the terms→blocks mapping are all true and all modelled, but as
  steps they buried the FST. The tree survives only in the automaton zoom
  (`BlockTree`, for its "never read" step); blocks appear in the dictionary zoom
  only as the compact column being pointed at.

Still true of the model even though the dictionary zoom no longer draws it:
**blocks are NOT contiguous slices of the sorted term list.** An inner block holds
a mix of terms and sub-block pointers, so a byte-group too small to earn its own
block stays inlined in the parent and interleaves with the blocks around it. Any
future view that draws the term list must not imply otherwise.

### Accuracy guardrails for this level
- This app models **text** fields only. Numeric and geo fields are indexed by a
  different structure entirely and are out of scope — don't teach them here, and
  don't contrast against them either.
- Every number rendered must come from the model, not from prose. If a step
  asserts a count, a reader must be able to find it in the trace.
- When the data can't demonstrate something (no VInt tail, no second skip level),
  say so and explain the threshold. Never imply a structure that isn't there.

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
  Merge / Reset); the sample-data loaders; search box + example queries + the
  optional routing key; and a "Delete a document" button that opens the document
  list (each doc's routed shard and a delete/tombstone toggle) as a scrollable
  overlay — it lives behind a button so a dozen sample docs can't crowd out the
  controls above it.
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

## Flagged simplifications of the Elasticsearch model
Documented so reviewers can verify the teaching stays honest:
- Routing is a deterministic string hash standing in for murmur3 `_routing`.
- **Toy constants in the on-disk zooms.** The real algorithms run, but scaled so
  the structure fits on one screen: `.tim` blocks hold 2–4 entries instead of
  Lucene's 25–48. Every panel that shrinks a constant renders a badge naming both
  values, and the memory claim must say the toy ratio understates the real one.
  This is the ONLY simplification at that level — the FST, the block tree, floor
  blocks, prefix compression and the DFA intersection are all modeled for real.
- The SHARD-level view (one zoom up) still models a term lookup as a binary
  search over a flat sorted array, and wildcard matching as a regex over the
  segment's terms. That is deliberate: it teaches the cost story in one picture,
  and the on-disk zoom beneath it shows what really happens. The two agree on
  which terms match — `src/automaton.js`'s intersection is checked against
  `expandTerms` — so the levels can't drift apart.
- A segment this small can't demonstrate a second skip level (that needs 4096
  docs in Lucene), and a term whose docFreq is an exact multiple of the block size
  has no VInt tail. Those steps say so and give the threshold rather than faking
  a structure.
- FST minimization is implemented and correct but rarely merges anything at this
  scale, because each block has a distinct file pointer. The panel reports what it
  actually saved rather than claiming a payoff it didn't get.
- Primary + replica are modeled as one logical shard rendered on two nodes (no
  replica lag; replica merges shown in lockstep with the primary).
- Relevance score is term-frequency, a stand-in for BM25.
- Replica selection during scatter is deterministic, not adaptive replica
  selection.
- Coordinator fixed to node-1; single index with 3 shards / 1 replica; no
  shard/replica/merge tuning exposed.
