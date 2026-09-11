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
5. **Replicate to the replica** — the primary forwards the OPERATION (the
   document) to its replica on a DIFFERENT node; the replica performs that
   indexing operation LOCALLY — analyzing the document itself — then buffers +
   logs it. Only then is the client acked. Data now lives on two nodes.
   **Show the analysis happening a second time, at the replica.** Terms must
   never be drawn crossing between the two copies: what travels is the document.

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
   No stored field is opened to do this.
4. **Gather + merge + sort** — coordinator merges all shards' hits and ranks.
5. **Fetch phase** — coordinator fetches full `_source` for the winning ids.
   Each shard holding a winner maps the id back to a segment + ordinal and reads
   that row of the segment's stored fields; the fetch-step 🔍 shows it.
6. **Return to client** — merged, ranked results returned. Buffered and
   tombstoned docs never appear.

**A search must be runnable with nothing searchable** — an empty cluster, or one
whose every document is still sitting in a buffer. It is a first-class lesson,
not an edge case: the scatter still goes out, every shard answers "no local
hits", and zero results is the proof that "buffered ≠ searchable" from the index
path is real. The Search button is therefore gated only on a non-empty query and
on no op being in flight — never on there being a searchable segment.

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

### Fuzzy queries (edit distance — KEEP THIS ACCURATE)
`serch~`, `serch~1`, `serch~2`. A fuzzy is the same shape of problem as a
wildcard, and must be modeled with the same machinery rather than as a special
case:
1. **The distance is Damerau-Levenshtein**, a transposition counting as ONE edit
   (Lucene's `transpositions: true` default), capped at **2**
   (`LevenshteinAutomata.MAXIMUM_SUPPORTED_DISTANCE`).
2. **A bare `~` means `Fuzziness.AUTO`** with Elasticsearch's `AUTO:3,6`
   defaults — 0 edits below 3 characters, 1 up to 5, 2 beyond. A `~0` is an exact
   term, not a fuzzy, and must be called one.
3. **The edit budget is the cost story.** One more edit multiplies the states in
   the machine, removes its ability to reject arcs, and pushes the walk into
   blocks it could previously skip — for the same word against the same
   dictionary. The dictionary zoom carries those numbers in its walk readout —
   arcs pruned, blocks read, terms examined — and every one must come from a
   trace, never be written into the copy. (The deep zoom deliberately ends at the
   `.tim` strip: an earlier build drew per-step cost lines, a term-entry /
   expansion block and a side-by-side contrast table running BOTH automata below
   it; all were removed as clutter. The expansion list still shows in the shard
   zoom and the results panel.)
4. **Fuzzy matches spelling, not meaning.** `store~1` expands to `score` as well
   as `store` and `stores`. That is not a defect to hide — it is the honest cost,
   and the app must show it.
5. The expansion is a boolean OR over the matched terms, exactly like a wildcard's.
6. **`prefix_length` is modeled but deliberately NOT exposed.** `parsePattern`
   accepts it, `buildLevenshteinNfa` honours it, and `npm run check` exercises
   it, because it is real Lucene semantics and it is what keeps `seekPrefix`
   meaning the same thing for every pattern kind. It has no UI control and no
   scenario: it used to exist only because the old dataset could not prune
   without it (see below), and a knob that exists to paper over a dataset is a
   knob that should not exist.
7. **A default fuzzy query MUST visibly prune.** This is a property of the
   DATASET, not of the algorithm, and it is the whole payoff of the fuzzy
   scenario. `SAMPLE_DOCS` therefore has a job beyond being readable: each shard
   must hold enough DISTINCT vocabulary that block prefixes discriminate and the
   `.tip` FST is at least three arcs deep. The original fourteen documents gave
   24–43 terms per shard, mostly inflections of the same few stems, an FST two
   arcs deep, and `serch~` pruned **zero** arcs on shard 0 while reading 100% of
   it. `npm run check` guards this on every shard; if it fails, add vocabulary
   rather than reintroducing a knob.

## Inverted index view
Each shard has its OWN inverted index (term → posting list of doc ids) built from
its searchable segments. Show these per shard. A search unions posting lists
across shards — a term shared by docs on different shards shows up from multiple
shards in the gathered results. This cross-shard union is the key "aha."

## The document model — `object` vs `nested` (KEEP THIS ACCURATE)

A segment does not store Elasticsearch documents. It stores **Lucene documents**,
addressed by a **segment-local ordinal** `0..maxDoc-1`, and the posting lists hold
those ordinals. `_id` is just a stored field. The app models this directly:
`seg.docIds` is the segment's Lucene docs **in ordinal order**, and the ordinal
**is the array index** — which is why a merge renumbers them for free, and why
`src/ops/merge.js` must never sort or regroup that array.

One Elasticsearch document occupies a contiguous **block** of that array, with
its root written **LAST**:

```
ordinal  id                 kind    fields
   0     doc-2.variants#0   child   variants.color: red   variants.size: S
   1     doc-2.variants#1   child   variants.color: blue  variants.size: XL
   2     doc-2              root    name: Trail Runner
```

`src/mapping.js` is the whole difference, and it is one file:

1. **`object` (the default) FLATTENS.** The array of sub-objects disappears and
   its leaves become multi-valued fields on the parent — `variants.color:
   [red, blue]`. One Lucene doc. **The pairing is not stored anywhere**, because
   there is nowhere left to store it, so `color:red AND size:XL` matches a
   product that has a red S and a blue XL. That false positive is not a bug in
   the app; it is the thing being taught.
2. **`nested` writes each sub-object as its own Lucene doc**, root last, as one
   contiguous block.
2b. **The flattened fields must be VISIBLE.** An object-mapped document once
   rendered as nothing but its name, which hid the only thing the mapping does.
   The shard close-up now draws each multi-valued field as its own list —
   `variants.color [red] [blue] [black]` over `variants.size [S] [XL] [M]` —
   stacked and aligned, so the lists are plainly the same length with nothing
   linking them. That absence is the lesson, so keep them aligned.
   **The shard close-up shows the INDEXED form only** — drawing the original JSON
   beside it, in that same column, was built and REMOVED: two representations plus
   a caption was more than the column could carry.
   **The search RESPONSE shows `_source`.** The block root carries `source` (the
   original JSON verbatim, stashed by `buildBlock`), and `SearchResultsOverlay`
   renders it. It is IDENTICAL under `object` and `nested` — sub-objects paired
   either way — because that is what Elasticsearch actually returns: `_source` is
   untouched by the mapping. An object-mapped product therefore comes back from a
   search looking perfectly correct, pairing intact, even though the query that
   found it matched the flattened form; that gap is why the false positive is so
   hard to spot in practice, and the response is now the place it shows. Do not
   reconstruct the sub-objects from the child Lucene docs — read `source`.
3. **A block is ATOMIC.** Lucene cannot update or delete one child, so a delete
   tombstones the whole block and an update rewrites all of it. This is where
   update amplification comes from, and it is why `toggleDelete` in
   `src/useOpLifecycle.js` flips every doc sharing a root.
4. **The join.** A nested query matches children, then has to report the
   DOCUMENTS that own them. Lucene does this by walking a cached per-segment
   bitset of "which docs are roots" (`BitSetProducer`) forward from each match —
   which is the reason the root is written last, and a cost paid per segment per
   query, cold again after every refresh. **The app does not model that walk**:
   `docRootId` answers the same question directly and there is no ordinal
   arithmetic here for a bitset to make cheaper. A `parentBitset` / `nextSetBit`
   pair and a diagram of them existed and were REMOVED — see the simplifications
   below. The join is SHOWN on the stored `_source` rows, which are the only
   place a Lucene doc appears with its content, and `npm run check` asserts it
   against `computeShardSearch`, the function the close-up actually renders.
5. **Lucene docs vs Elasticsearch documents.** Nested mapping is the gap between
   them — 12 products become 44 Lucene docs — and it is paid on storage, on every
   merge and on every query. It is stated in words and in the segment stack's own
   chips, not as a `maxDoc`/`numDocs` badge: that badge existed and was removed
   as unexplained Lucene vocabulary.

**A document with no nested field is a block of exactly ONE Lucene doc whose id
is its `_id`.** That degeneration is a correctness requirement, not a
convenience: it is what keeps every flat dataset, every other scenario and every
pre-existing `npm run check` invariant byte-for-byte unchanged. `npm run check`
guards it.

### Queries: fielded and conjunctive
`parseQuery` accepts Lucene query-string `field:value` and an UPPERCASE `AND`,
and nothing else. Both halves are prerequisites, not decoration: the object
failure is only visible when two clauses that name **fields** must **both** match,
and a query using neither parses exactly as it always did. Uppercase-only `AND`
is what stops a document containing the word "and" from being read as an operator.

A conjunctive query scores 0 unless every clause matched **the same Lucene doc**.
That single rule is the whole lesson: under `object` the whole document is one
Lucene doc, so clauses agree across sub-objects that were never together; under
`nested` they must agree within one child. It is deliberately one code path.

### Choosing the mapping at index time
The index form carries a collapsed **Advanced** section: an array of sub-objects
under `variants`, and a radio for whether that path is `object` or `nested`. It
exists so the mapping decision is made by the reader and **priced before it is
committed** — a live line reads "writes 1 Lucene doc" or "writes 4 Lucene docs"
off the same `buildBlock` the write path uses, so the preview can never disagree
with what lands in the buffer. This is a first-class feature, not scenario
scaffolding: any document can carry sub-objects, either way.

The nested scenario's first two acts index ONE product by hand, once each way,
because one product is enough to produce the false positive and much clearer
than a dataset that arrives fully formed. Between the two runs it CLEARS the
index — a mapping cannot be changed in place, and pretending one index holds
both mappings would be a lie the rest of the app doesn't tell.

### The catalog dataset
Twelve products, seeded twice (`catalog-object` / `catalog-nested`). Switching
mapping is a **REINDEX**, because a mapping cannot be changed in place in
Elasticsearch — so it is two entries in the Load-docs menu, never a toggle.
Three invariants, all asserted by `npm run check`:

- **No product has a variant that is both red AND XL.** If one did, the trap
  query would be a true positive and the lesson would evaporate.
- **Exactly one product (doc-2, Trail Runner) holds red and XL on different
  variants**, so the false positive is a single pointable document.
- **doc-2/5/8/11 route to shard 0 with 3/4/3/3 variants**, so shard 0 holds 4
  Lucene docs under `object` and 17 under `nested`. That 4-vs-17 is what the
  segment stack shows with no new UI.

The control query is `variants.color:brown AND variants.size:M`, not a red pair:
brown appears on exactly one variant in the catalog, so no product holds brown
and M on different variants and the two mappings MUST agree. A red+S control
would not work — several products carry red and S on different variants, so
object over-matches there too and the contrast stops being clean.

## On-disk anatomy (the deepest zoom — KEEP THESE ACCURATE)
The flat two-column table above is a drawing, not a layout. A fourth zoom level
(reached by the 🔍 by a segment's name, inside the shard close-up) shows what one
segment's structures actually are: **four tiles** — the term index (`.tip`), the
term blocks (`.tim`), the postings (`.doc`) and the stored fields (`.fdt`) — and
a tour that dives into them in the order a query reads them. See "Inside a
segment — the four tiles" below for how it is presented; the models first:

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
3b. **The in-block scan is LINEAR WITH AN EARLY EXIT, not a full read of the
   block.** Entries are sorted, so the scan walks them in order and stops at the
   first one that equals the term or sorts past it — Lucene's
   `SegmentTermsEnumFrame.scanToTermLeaf`, and `blockScan` in `blocktree.js`
   does the same. Rows after the stop are never compared, which is why
   `entriesRead` can honestly be 1 in a block of four. The opened block says so
   in one line whenever it stopped early: without it the greyed rows read as
   "these were checked too", which the row count beneath them contradicts.
4. **A seek costs one in-RAM FST walk plus exactly ONE disk read**, regardless of
   dictionary size. That is the number to teach, against the ~log₂(n) scattered
   probes the flat binary search one level up needs.
5. A term outside the field's min/max term is rejected with **zero** disk reads.
6. Per-term metadata is `docFreq` plus pointers into `.doc`/`.pos`/`.pay`.

### Postings — `.doc` (`src/postings.js`) — the concept, never the encoding
A posting list is modelled as what it IS to a query: for one term, the
segment-local **ordinals** of the Lucene docs that contain it, each with the
term's **frequency** there, read forwards. Three things the tile exists to make
visible, and `npm run check` asserts the first two against the levels above:
1. A posting is an ordinal — the doc's index in `seg.docIds` — not an `_id`.
   The chip beside it is the reader's bridge to the level above, where the same
   doc was a coloured id; the number is what the file holds.
2. The frequency is the count `scoreDoc` uses. The scorer never sees text.
3. The ordinal is also the row address of the stored-fields file. The four-hop
   chain (`.tip` → `.tim` → `.doc` → `.fdt`) is the whole lesson, and the
   postings tile is the hop that turns a term into numbers.

The on-disk ENCODING (delta-coded ordinals, bit-packed blocks, a VInt tail, skip
lists, `nextDoc`/`advance`/leapfrog) had a zoom of its own and was **removed**;
that stays removed. The reasons still hold and are the boundary of this tile:
- The concept is what a reader needs to understand search; the encoding is not.
- **This dataset cannot demonstrate it.** On the merged shard-0 segment, 22 of
  24 terms had no skip data and at most one packed block; more than half of
  that zoom rendered "there isn't one here". Enlarging the sample set would
  perturb the tuned `search` ×4/×3/×2/×1 counts the top-k eviction demo depends
  on.
- It read as mechanism without purpose. The postings tile is reached the way
  Lucene reaches a posting list — from the term row's `.doc` pointer, after the
  index and the block — which is the narrative bridge the old zoom lacked.

`.pos` (positions) and `.pay` are not modelled; the term row names only its
`.doc` pointer and `docFreq`. The shard inspector keeps its one clause noting
Lucene writes no skip data below 128 documents.

### Stored fields — `.fdx` + `.fdt` (`src/storedFields.js`) — read in the FETCH phase
Stored fields are addressed by ordinal and hold, in Elasticsearch, `_id` and
`_source` — the original JSON verbatim — because mapped fields are indexed, not
stored. `.fdt` is written in compressed chunks and `.fdx` is the index that says
which chunk holds an ordinal; reading one document is one `.fdx` lookup and one
chunk decompressed. Chunks are toy-scaled (`FDT_CHUNK_MAX` docs per chunk, not
Lucene's byte-sized chunks) so a chunk boundary can be seen — the one
simplification here, listed with the block sizes below.

**The fact this file exists to place correctly: a query never opens it.** The
query phase returns ordinals and scores; the stored fields are read in the fetch
phase, in a separate request, for the winners of the coordinator's cut and no one
else. So the query-phase tour marks this tile "later" and does not dive into it,
and the shard close-up no longer lights "stored _source" on its return step
(it used to, and that taught the wrong phase). The fetch step of the search op
has its own 🔍 on each shard holding a winner: a fetch close-up
(`stages/shardFetch.jsx`) turns each id back into a segment + ordinal — which is
what a shard's reader really has to do with a hit before it can open anything —
and a 🔍 per segment opens the same four-tile view with the three query-phase
tiles dimmed and the camera going straight to the stored fields.

**Both shard close-ups draw the SAME segment anatomy** (`src/closeups/anatomy.jsx`,
shared by `shardLocal` and `shardFetch`), and that is a requirement rather than
a saving: it is the same shard and the same segments, so a reader must see the
second phase reach into the part of them the first phase left alone. The query
phase lights the term dictionary and then the postings and never lights the
stored `_source`; the fetch phase lights only the `_source`, flags the rows it
was sent for, and leaves the dictionary and postings visibly untouched above
them. Drawing the fetch phase without that card — as an id-to-ordinal list
alone — was tried and was wrong: it hid the whole contrast the two phases exist
to teach.

A block root carries `_source`. A nested child carries **no stored fields**:
Elasticsearch indexes the parent's `_id` on it (so a delete removes the whole
block) but does not store it, and a child has no `_source` — the document's
`_source` lives on its root. The tile draws a child's row as "nothing stored",
which is the honest picture and one more reason the root is written last.

Doc values are out of scope: a match query sorted by score never reads them, and
`text` fields have none. The segment view has four tiles, not five.

### Patterns — the same picture, driven by a query (`src/automaton.js`)
A wildcard is **not a separate zoom**. A plain term is the degenerate case of a
pattern — one path through the FST, one block read — so the dictionary zoom
serves both and the query decides how the walk behaves. They were two close-ups
drawing the same two structures; that duplication is why they were merged.

The **only** thing a pattern's kind may decide is which NFA gets built — a glob
for `*`/`?`, a Levenshtein grid for `~`. Determinization, the FST walk, pruning
and floor selection are shared, because to Lucene both are just an
`AutomatonQuery`. Adding a third kind of pattern must not add a third walk.

Checked against Lucene's own source (`IntersectTermsEnum`, `LevenshteinAutomata`)
rather than from memory, because the guided walk now narrates each decision and a
wrong mental model would be stated confidently to the reader:
- Real Lucene runs the automaton over **BYTES** (`ByteRunnable.step`, a
  `ByteRunAutomaton`) and picks arcs using sorted **transition RANGES**
  (`currentTransition.min/max`) to skip labels no transition can accept. We test
  characters arc by arc, which is the same set of follows and prunes said out
  loud — the toy alphabet is ASCII, so bytes and characters coincide here.
- **A node is not scanned to find an arc, and the picture must not say it is.**
  `FST.findTargetArc(label, …)` reads a node-flags byte and dispatches on how
  that node's arcs were written:
  `ARCS_FOR_DIRECT_ADDRESSING` (fixed-length arcs over a label range plus a
  presence bitset — `label - firstLabel`, one `BitTable.isBitSet`, a handful of
  popcounts in `countBitsUpTo`, and **no label comparison at all**),
  `ARCS_FOR_CONTINUOUS` (the range is dense, so the bitset is dropped and
  `readArc` does not even read the label), `ARCS_FOR_BINARY_SEARCH` (~log₂n
  label probes), and only as a fallback a variable-length arc list scanned
  linearly with an early exit on `label > labelToMatch`.
  `FSTCompiler.shouldExpandNodeWithFixedLengthArcs` gives the array forms to any
  node at depth ≤ `FIXED_LENGTH_ARC_SHALLOW_DEPTH` (3) with ≥
  `FIXED_LENGTH_ARC_SHALLOW_NUM_ARCS` (5) arcs, or ≥
  `FIXED_LENGTH_ARC_DEEP_NUM_ARCS` (10) arcs anywhere — so the bushy nodes a
  walk would appear to sweep are exactly the ones that are indexed, and the
  linear path is left to nodes holding one to three arcs. Lucene **deleted** its
  explicit root-arc cache in 8.4 (LUCENE-9049, *"redundant with labels indexed by
  bitset"*), which is the project saying in its own words that root lookup is
  already an array index. Hence the seek/consider rule below.
- The genuine one-at-a-time comparison is one level DOWN, in
  `SegmentTermsEnumFrame.scanToTermLeaf`: `Arrays.compareUnsigned` over the
  block's suffixes, up to `maxItemsInBlock` (48), with an early exit once the
  scan passes the target. This app already animates that, as the `.tim` row
  reveal — and the FST's whole job is to keep that scan short.
- Two simplifications worth stating plainly. In the DEFAULT codec
  `IntersectTermsEnum` does not intersect the automaton with FST arcs at all: it
  merge-joins `currentTransition.min/max` against the **block suffix bytes**, and
  touches the FST only through `findTargetArc` in `pushFrame`, to recover
  floor-block metadata. Arc-level intersection is real, but it lives in the
  non-default `FSTTermsReader` (`readFirstRealTargetArc`/`readNextRealArc` for
  siblings, `Util.readCeilArc` to seek). And as of Lucene 10.3 the default terms
  index is no longer an FST at all — `TrieBuilder`/`TrieReader` replaced it — but
  its `ChildSaveStrategy` makes the SAME choice, `BITS` before `ARRAY`, with no
  linear-scan strategy at all. The lesson this zoom teaches survives both.
- `pushFrame` → `frame.load(node)` means a frame IS a block read: an intersect
  reads the root block and each sub-block it descends into. That is why term
  mode keeps `seekTrace` for its cost (see above) — the two APIs genuinely read
  a different number of blocks.
- Lucene builds the Levenshtein DFA directly from Schulz & Mihov parametric
  descriptions (max distance 2, optional transpositions). We build the textbook
  `(i, e)` NFA and determinize it, which is the derivation those precomputed
  tables encode — and it is the only form in which the grid can be DRAWN, which
  is the whole point of the panel.

1. The pattern compiles to an NFA, then is **determinized** (Lucene caps this at
   `maxDeterminizedStates` = 10000, which this app enforces).
2. The automaton is run against the `.tip` arcs in lockstep, and **what it can
   accept at a node decides how the walk moves there**. Exactly one live label
   and the walk **seeks**: one indexed jump, the siblings never examined (drawn
   grey, their subtrees dimmed, and counted as skipped). Many live labels or an
   ANY fallback and there is nothing to jump to, so the arcs are considered one
   by one: followed, or **pruned** — every term behind a prune skipped unread.
   This is ONE rule for every mode, keyed on the query's state at that node and
   never on the query's kind, so it does not reintroduce a per-kind walk.
   A plain term is determinate everywhere, so it is a pure chain of seeks;
   `sc*` seeks until the `*`; a fuzzy is determinate only once its budget is
   spent, because until then an insertion buys any character.
3. A **leading wildcard's start state accepts any character**, so no arc can ever
   be pruned and every block loads. The cost difference is therefore STRUCTURAL,
   not a heuristic. Both numbers must be derived by running the two automata,
   never written into the copy.
4. **A node may be marked with what its BLOCK held, never with a term of its
   own.** Nothing in the picture used to connect the walk to the answer, so a
   state whose `.tim` block turned out to contain a matching term now gets a halo
   and the matched word(s) hung BESIDE the bubble. The distinction is not
   cosmetic: a state's bubble is a block ADDRESS, 34 states index 89 terms here,
   one leaf points at a block of seven, and minimization merges states that two
   different prefixes reach — so labelling a node *as* a word would be false.
   "The walk through here paid off, and this is what was found" is true. The
   label only appears from the READ step onwards, because before the blocks are
   fetched the walk genuinely does not know. It is set to the RIGHT of the
   bubble, not under it: rows are 46px apart and columns 108px, so a label below
   collides with the next node down, and `ArcGraph` widens its canvas to fit a
   label that lands on the last column.
5. **Do not rebuild the DFA transition table.** It was rendered and removed: for
   `sc*` it was 3 rows × 16 columns of mostly em-dashes, and because `maxCols`
   truncated at 14 while the segment had 19 distinct characters, `s` — the one
   transition that explains the pattern — fell off the end, leaving the start row
   entirely blank. The FST already shows the consequence directly and in colour.
   One line stating what the pattern accepts (from `startAcceptsAnything`) carries
   everything the table did.

### The Levenshtein automaton, when it is DRAWN (fuzzy only)
A glob's interesting question is which arcs survived, and the FST alone answers
it. An edit-distance machine's interesting question is which `(characters
matched, edits spent)` states are still alive — a SET, changing every character,
that nothing in the FST can show. So for a fuzzy pattern, and only for a fuzzy
pattern, the dictionary zoom draws the automaton beside the term index.

- **The layout changes with the MODE, never with the step.** The split holds
  what is IN MEMORY and the `.tim` block column is a full-width strip beneath it
  — in every mode, so the geometry does not move when the query changes. Fuzzy
  is the only mode with a second thing in memory to put in that split (the
  compiled query beside the term index); a term or a glob leaves the FST the
  full width. That is a property of the query, so the one-picture rule above
  still holds within a mode: a step may still only change what is lit. The
  strip starts below the fold on a tall dictionary, so the stage scrolls each
  step's subject into view the same way `ArcGraph` pans to its cursor —
  instantly, and only when the step changes, so it never fights the reader.
- **The intersection is walked BY THE READER, not past them.** Auto-play spends
  260ms per decision, which is fine for "watch it go" and useless for "see how
  it works" — a walk is 30-odd decisions and the interesting ones are the
  prunes. So the panel's Prev/Next scrub one decision at a time, and the fuzzy
  scenario freezes the panel (`holdPanel`) and hands it over: press Next, one
  arc of the index and one character of the machine, both panels moving
  together, until a red arrow lands and the grid goes empty. The steps clear on
  the reader's own progress (`closeUpSub`), and `npm run check` asserts a prune
  is actually on screen by the decision each step clears at — otherwise the tip
  that says "watch one turn RED" would clear before one had.
- **Each step says WHY, from the trace** (`ctx.narrate` + `liveNarration`). The
  reader is told which character the index offered, which readings were waiting
  for it (free) and which had to spend an edit, or — for a prune — that every
  live reading is out of edits and what each was waiting for instead. It is
  folded out of `explainDecision` in `src/automaton.js`, so no sentence asserts
  anything the machine did not do. Two facts it leans on:
  - **An arc can only die once every live reading has spent its last edit.** A
    reading with budget can always buy the next character as an INSERTION (cost
    1, consumes anything), so pruning cannot begin above the depth where the
    budget runs out. `npm run check` asserts it over every prune.
  - **The walk is DEPTH-FIRST and backtracks**, so the live set jumps back to an
    ancestor's when a subtree finishes. Unsaid, that reads as the machine losing
    progress; the narration calls it out whenever the visit's prefix is not
    where the previous one left off.
- **Those steps do NOT dim the app** (`noDim`), and they carry their own step
  button (`panelNext`). Both follow from what the step is for. The spotlight's
  usual job is to make one control the only thing worth looking at; here the
  lesson is two structures moving together with a readout underneath tying them
  to each other, so darkening everything outside one panel would hide most of
  what the reader was just told to watch. The dim rects stay in the DOM (the
  ring and the layout maths are unchanged) but go transparent and
  click-through, and the tip goes translucent and sits in the margin BESIDE the
  close-up — never over the FST panel, which is the other half of the picture.
  Because nothing is blocked any more, every such step needs an `advanceOn`
  that survives the reader wandering off, or closing the panel strands the tour.
- **The picture's coordinates come from the model.** `buildLevenshteinNfa`
  returns a `grid` of nodes carrying their own `(i, e)`; a view may never
  reverse-engineer a position out of a state id, and the states it lights come
  straight from `dfa.states[...].nfaSet`. `npm run check` asserts the two address
  the same states, because otherwise the picture is a decoration that happens to
  move in time with something.
- **The arc walk CANNOT accept, and the picture must not pretend otherwise.**
  The `.tip` FST indexes BLOCKS, so its arcs are block prefixes — one to three
  characters on this data. Walking them advances the automaton by at most three
  positions out of five, which means no accepting state is ever reached during
  the walk; the match is decided afterwards, by `matchTerm`, when a block is
  read and its terms are completed. A picture that stops at the arc walk leaves
  the grid stuck partway across with no explanation, which is exactly how it
  read before. Step 4 therefore replays the winning term's COMPLETION —
  `termPath` in `automaton.js` runs the DFA over the rest of the word — so the
  machine visibly reaches the right-hand column and accepts. `termPath.accepts`
  must agree with `matchTerm` for every term tested; `npm run check` asserts it.
- **Pan to the arc being DECIDED, not to the cursor.** They differ precisely
  where it matters: a pruned arc is reported from the node the walk is standing
  on, so for `sc*` the cursor sits on the root through sixteen consecutive
  rejections while arcs die all over the graph. The pan follows the arc's far
  end (`fstTo`), and it is instant rather than smooth — one decision is a 260ms
  tick, and a smooth scroll would still be travelling when the next one lands.
- **Draw the SET, never a single cursor.** After part of a word the machine
  genuinely cannot tell which reading will pay off, and one glowing node would
  misrepresent that.
- **Skipped work is drawn, for every kind of pattern — but red is a VERDICT,
  never a claim that the arc was inspected.** An earlier version animated a glob's follows only,
  on the grounds that drawing skipped work wasted the step; that was backwards,
  because it made the cheapest pattern look identical to the most expensive one.
  A later version over-corrected the other way and reddened every sibling at
  every node, for every query — which claimed Lucene compares a node's arcs one
  at a time, and it does not (see the `findTargetArc` bullet above). There is now
  ONE replay with one set of rules, keyed on the seek/consider test: a followed
  or sought arc is green, an arc no live transition accepts is red, the subtree
  behind EITHER a prune or a seek's untouched siblings is dimmed (that is where
  the cost lesson lives), and the cursor pans to the decision being made.
  The wording matters, and the verdict strip says `no live transition — PRUNE`
  rather than the old `refused on sight`: `IntersectTermsEnum` leapfrogs sorted
  transition ranges and **never runs the automaton on a label it rejects**, so
  "refused on sight" claimed a test that does not happen. What a prune honestly
  reports is that nothing live accepts the arc and everything behind it goes
  unread — which is true, and is the lesson. Measured on this data, of the 128
  prunes drawn, 83 sit below the first live range and 38 in a gap between
  ranges — entries Lucene's catch-up scan genuinely walks past — and only 7
  (5.5%) sit beyond the last live range, where Lucene pops the frame and never
  arrives. So the picture depicts the right amount of WORK; it was only the verb
  that overclaimed. Greying the reds out entirely would be more literal and less
  true: it would erase the fuzzy panel's central lesson (the automaton
  eliminates whole subtrees) to fix a verb. Arcs and block entries are not the
  same unit, so that census is an analogy-level check, not an exact mapping.
  The consequence is that on this data red appears **only in fuzzy mode**, which
  is the honest answer: an exact term and an anchored glob both know which byte
  they want, and `*search` — the expensive case — refuses nothing precisely
  because it can rule nothing out. The contrast the wildcard scenario rests on is
  now two indexed jumps into one corner of the dictionary versus every arrow
  taken, and it reads more sharply than sixteen dying arcs did. The only thing a
  query's kind still decides is whether the automaton panel appears beside the
  index, because a glob has no `(i, e)` grid to draw.
  **A plain term runs that same replay**, because it is the degenerate pattern:
  its automaton names one character at every node, so a term walk is a short
  chain of seeks. Term mode used to have a visual language of its own (green
  node FILLS, and a dashed red stub with a ✗ for the arc it ran out of) which
  put two opposite meanings on red in one picture — the stub fires on SUCCESSFUL
  lookups, since `.tip` arcs are block prefixes and the arrows always run out
  before the word does. The stub is gone and the fact lives in the copy and the
  walk readout instead; for the same reason a seek that finds no arc emits no
  visit at all and simply ends the walk. What term mode does NOT share is its
  COST model: it keeps `seekTrace`, because `TermsEnum.intersect` loads a block at every
  output-carrying state on the way down (three for `search` here) where
  `seekExact` carries the last output and reads exactly ONE — and one read is
  the number this zoom exists to teach. The intersection drives the picture;
  the seek drives the numbers.
- **The walk readout is one strip for every mode.** Where the cursor is, what
  the query can still accept, and the verdict on the character just consumed —
  fuzzy fills its "what the machine can be" cell with the live `(i, e)` set, a
  glob with what its start state accepts, a term with the block address it is
  carrying. Once the walk is over the strip totals up instead of leaving a
  stale per-character verdict standing above a good result.
- **The pinned prefix is shown as missing edges, not as a caption.** Inside
  `prefix_length` the model emits no edit edges at all; the band names what the
  reader can already see is absent. Nothing in the UI can currently set a
  prefix length (see above), so this branch is unreachable in practice — it is
  kept because the model still supports the parameter, and a picture that
  silently ignored it would be lying about what ran.
- **A tour step that only asks to be READ freezes the panel.** `CloseUp` takes a
  `held` prop (App sets it for any step with a `cta` and no `advanceOn`) which
  stops the auto-play clock without clearing `active` — `active` must stay true,
  because stages read it to park their own timers and `useReveal` JUMPS TO THE
  END when it goes false, which would finish the very animation being held.
  Without this the walk plays out behind the tooltip describing it, and the
  reader dismisses the tip to find the thing already over.
- **The FST panel is BOUNDED and PANS.** `fstLayout` puts depth on x and stacks
  siblings on y, and the .tip FST is bushy rather than deep — a hundred-term
  dictionary is a graph two thousand pixels tall. `.cu-fst` is capped and
  `ArcGraph` scrolls the current cursor into view on every revealed step, so the
  panel's size is independent of the dictionary's and the eye follows the walk
  instead of hunting for it.

### Inside a segment — the four tiles (`src/closeups/stages/segment.jsx`)
The segment close-up opens on a 2×2 grid of tiles — `.tip` term index (in
memory), `.tim` term blocks, `.doc` postings, `.fdt` stored fields (on disk) —
each with a glyph, its name, where it lives, and a status line that advances
with the tour ("walked · carrying 0x7C0", "1 of 42 read · “search” → 0x958",
"4 postings read → ordinals 0, 1, 2, 3", "not read in the query phase"). The
tour then dives into one tile at a time: overview → term index (the arc walk) →
term blocks (the scan, then the found row with its `.doc` pointer) → postings
(the list, one ordinal at a time) → back to the grid, with the stored-fields
tile saying "not yet — read in the fetch phase". A fuzzy query's found step
dives back into the term-index tile, because its payoff (the machine finishing
the word) lives in the automaton grid drawn there.

- **The zoom looks like the zoom.** Diving into a tile is the choreography App
  uses to dive into a shard: the grid rushes toward the tile and fades (the
  `.layout` tween, transform-origin at the tile's quadrant) while the tile's
  panel springs out of it (the `CloseUp` entrance spring). Zooming back is the
  tween reversed, and between two tiles the grid is HELD for a beat so the
  hand-off can be read off the status lines — the address the walk carried is
  what the blocks tile is opened at; the `.doc` pointer on the found row is what
  the postings tile is opened at. This is a CAMERA inside one close-up panel,
  not a stack of nested panels: one clock, one stepper, and Prev/Next scrub
  across a tile boundary (a backward step or a manual scrub moves the camera
  straight there, without the grid beat — that beat is for watching, not
  navigating). Replays start only once the camera has landed.
- **The tiles are the four-hop chain.** A "you are here" strip listing
  `.tip → .tim → .doc → .fdt` used to sit above the dictionary zoom and was
  removed as clutter. The grid is that strip done properly: it is the persistent
  picture the camera returns to, and each hop is a tile with a status line
  saying what it handed to the next.
- **The one-picture rule now holds PER TILE.** Every tile is mounted for every
  step; a step only changes which tile the camera is on and what is lit inside
  it, never a tile's content. Within the term-index and term-blocks tiles the
  rules below are unchanged — they used to share one scroller and now sit in
  two tiles, which is the only thing that moved.

### How this level must be PRESENTED
The structures above are only half the job. Two earlier builds modelled them
correctly and still failed: the first was illegible, the second was legible but
read as a slide deck about an inverted index rather than a picture of one
working. These are requirements, not polish:

- **The dictionary tiles are about the FST, and each is ONE PICTURE.** The term
  index under "in memory", the blocks it indexes under "on disk", each drawn in
  full for **every** step it is on screen. A step may only change what is lit up
  — the walk, then the single block that gets read. Never swap the content area
  per step; that is what made it a slideshow. `stages/coordMerge.jsx` is the
  in-repo precedent for a persistent stage, and the tile grid above follows it.
- **The lesson is the memory footprint**, and the layout carries it: a small graph
  that stays resident, a dictionary that does not, and exactly one block crossing
  between them. Blocks not read must be visibly dimmed rather than absent.
- **State the memory claim honestly.** The FST indexes BLOCKS, not terms — that
  is what holds at any scale, and the step blurb makes that point. But our toy
  blocks hold 2–4 entries, so the on-screen ratio (~2×) badly understates
  Lucene's ~30× at 25–48 terms per block. The deep zoom no longer spells this out
  in a cost line — it is kept uncluttered — so nothing in it may quote an
  on-screen count as the saving.
- **Draw the FST by the convention: characters on the ARCS, the output inside
  the state's bubble, and no other label on a state.** Never a raw id —
  minimization renumbers by post-order DFS, so the start state gets the HIGHEST
  id and an id walk appears to run 9 → 7 → 6. And never the prefix that reaches
  the state either: a prefix is a property of the PATH, not the state, and
  minimization can merge states that two different prefixes reach, so there is
  no honest label to give. (An earlier build labelled states with their prefix
  to dodge the id problem; it dodged it by asserting something untrue.) Showing
  the output instead is what the model already implies — we hang outputs on
  STATES rather than arcs, which makes this a Moore machine, and the Moore
  convention is that the output goes in the bubble. Lucene's own `Util.toDot`
  agrees closely enough to settle it: nodes get their binary offset (an
  ADDRESS), or no label at all when `labelStates` is off. A state that carries
  nothing is drawn as an empty circle, which is the honest majority case.
  The prefix is not lost — the walk readout under the graph prints the candidate
  prefix, the character just consumed, and (for a term) the block address the
  walk is carrying, which is what `SpellOut` and `PatternWalk` used to say in
  two mode-specific panels of their own.
- **The four-hop chain** is `.tip` (which block) → `.tim` (which term) → `.doc`
  (which ordinals) → `.fdt` (the text). Collapsing the first and last hop —
  reading `.tip` as "points at the document" — is the natural mistake, and it was
  the first thing a reader got wrong. The tile grid is the answer to it (see
  "Inside a segment" above): every hop is a tile the tour visits in order, and
  the last one is visibly NOT visited until the fetch phase. The expanded block
  rows name each term's real `.doc` address, which is the address the postings
  tile then opens at.
- **Depth that isn't the lesson belongs elsewhere.** The block tree, prefix
  compression and the terms→blocks mapping are all true and all modelled, but as
  steps they buried the FST. Blocks appear in the dictionary zoom only as the
  compact strip being pointed at, opened in place on the read step to show the
  rows that were actually compared.

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
- The arithmetic at this level is checked by `npm run check`
  (`scripts/check-models.mjs`), which is NOT a test suite for the app — the app
  is still verified by running it. It asserts only the things a browser will
  happily animate incorrectly: that the two zoom levels agree on what matched,
  that `editDistance` is really bounded Damerau-Levenshtein, that
  `Fuzziness.AUTO` switches where Elasticsearch says, that the drawn automaton
  describes the one that ran, and that the intersection trace's cursors agree
  with the walk. Add to it when you add arithmetic; don't grow it into a test
  suite for the UI.
- When the data can't demonstrate something (no VInt tail, no second skip level),
  say so and explain the threshold. Never imply a structure that isn't there.

## Accuracy guardrails (don't get these wrong)
- Segments are IMMUTABLE. Writes create new segments; never edit existing ones.
- A document is NOT searchable until refresh creates its segment.
- Refresh ≠ flush. Refresh makes docs searchable (new segment); flush makes them
  durable and clears the translog. Keep these separate.
- A replica is always on a different node than its primary.
- **Replication ships the OPERATION, not the index.** The primary executes the
  write locally first, then forwards the document to each in-sync replica, and
  every copy analyzes and indexes it for itself — so analysis runs once per shard
  copy, not once per cluster. Lucene segment files cross the wire only during
  peer recovery, never on the write path. (Elastic's "Reading and writing
  documents": the primary "forward[s] the operation to each replica in the
  current in-sync copies set", and "each in-sync replica copy performs the
  indexing operation locally so that it has a copy".) The index op's replicate
  step used to fly the primary's analyzed TOKENS to the replica, which taught
  exactly the wrong thing; it now flies the document and replays the analysis
  there. Don't undo that to save a beat of animation.
- Search is scatter-then-gather, coordinated by one node; two-phase
  query-then-fetch.
- Updates = new doc + tombstone on old; deletes = tombstone, reclaimed at merge.
- Posting lists address LUCENE docs (segment-local ordinals), never `_id`s. An
  Elasticsearch document is a contiguous BLOCK of them with the root LAST, and
  the block is atomic — never write, delete or reorder part of one.
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
  Lucene's 25–48, and `.fdt` chunks hold `FDT_CHUNK_MAX` (4) docs instead of
  Lucene's byte-sized chunks. This is documented here rather than surfaced in
  the zoom: the deep panel is kept free of cost lines and badges, so no on-screen
  number in it may be read as a saving ratio (the ~2× on screen badly
  understates Lucene's ~30×). These are the ONLY simplifications at that level —
  the FST, the block tree, floor blocks, prefix compression and the DFA
  intersection — glob and Levenshtein alike — are all modeled for real, and the
  postings tile shows real ordinals and frequencies (only the file ENCODING is
  left out, deliberately — see above). `.doc` and `.fdt` file offsets are
  fake-but-stable, like the `.tim` block pointers.
- **Fuzzy expansion is not blended.** Elasticsearch's default rewrite blends the
  document frequencies of the expanded terms and boosts by edit distance; here
  each matched term is scored on its own frequencies, so a close match and a
  distant one are worth the same. The dictionary cost — which is what these zooms
  are about — is unaffected.
- The SHARD-level view (one zoom up) still models a term lookup as a binary
  search over a flat sorted array, and pattern matching as a direct test against
  each of the segment's terms (a regex for a glob, an edit-distance computation
  for a fuzzy). For a fuzzy the two levels therefore report DIFFERENT costs on
  purpose — a flat sorted list has no prefix to seek to and must read all of it,
  while the real term index prunes. The op note says so explicitly and points at
  the zoom, so the headline number cannot be read as contradicting the picture. That is deliberate: it teaches the cost story in one picture,
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
- **The shard scores EVERY match, then slices; Lucene prunes.** Real Lucene runs
  WAND / Block-Max WAND: an upper bound per term (and per 128-doc block) is
  compared against the priority queue's current lowest score, and documents that
  cannot beat it are skipped without being scored. This app has no such pruning
  and cannot honestly show it — the pruning lives on the GAP between a rare
  term's bound and a common term's, and that gap is IDF, which the
  term-frequency score above does not have. With tf alone the bounds run
  BACKWARDS (a term in every document would carry the highest bound), so drawing
  the algorithm would teach the opposite of the truth. The `topk` step therefore
  names the simplification in its blurb and links Elastic's "Magic WAND" post
  rather than animating it. Related: the `.doc` encoding zoom that would have
  carried `advance`/skip-lists is removed above, and stays removed.
- **A nested block's score SUMS its matching children.** Elasticsearch's nested
  query defaults to `score_mode: avg`; summing is chosen because it leaves a
  one-child block's score exactly what it was, which is what keeps the tuned
  shard-0 4/3/2/1 top-k spread intact. The dictionary and join costs — which is
  what this lesson is about — are unaffected.
- **The parent bitset is described, not modelled or drawn.** A `parentBitset` /
  `nextSetBit` pair in `src/cluster.js` and a "lucene docs · by ordinal" strip in
  the shard close-up were both removed. The strip duplicated the stored `_source`
  column — which already lists every Lucene doc, in ordinal order, children
  before their root, WITH its content and its id — while adding a picture that
  implied posting lists hold integers when the column beside it renders ids. The
  model functions had no caller but the test, so the test was asserting a
  parallel implementation rather than the real path. Don't rebuild either without
  first making the model genuinely walk a bitset.
- **A conjunctive query is modelled as clauses agreeing on one Lucene doc**,
  rather than as Elasticsearch's `bool`/`nested` query DSL. That is what the
  block join really does, but it means a query mixing a root field with a nested
  field finds nothing here, where real Elasticsearch would need an explicit
  `bool` wrapping a `nested` clause to express it at all.
- **Numeric fields index as a single term.** Real Elasticsearch indexes numerics
  as points so ranges work; an exact-value term lookup — the part taught here —
  behaves the same either way.
- The catalog's variant counts (2–4) are small enough to fit a shard card. Real
  nested pain starts in the dozens; the copy gives the real numbers (48 variants
  → 49 docs rewritten per update, `nested_objects.limit` 10 000) rather than
  faking a dataset that would not render.
- Replica selection during scatter is deterministic, not adaptive replica
  selection.
- Coordinator fixed to node-1; single index with 3 shards / 1 replica; no
  shard/replica/merge tuning exposed.
