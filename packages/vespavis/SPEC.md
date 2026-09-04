# vespavis — specification and accuracy guardrails

This file is the authoritative description of what the app is supposed to do,
**and** the list of Vespa facts the model is not allowed to get wrong. Read it
before changing anything in `src/cluster.js`, `src/ranking.js`, `src/schema.js`,
`src/vectors.js` or `src/ops/`. `npm run check` enforces the parts of it that
are arithmetic or invariance; the rest is enforced by reading.

---

## 1 · What the app is

A single-page React (Vite) app that shows how Vespa serves the workloads it is
actually used for: text search, vector search, hybrid retrieval with multi-phase
ranking, filtered vector search, and real-time personalization. Everything is
simulated client-side — no backend, no localStorage, all state in React.

Its subject is **retrieval and ranking as a computation** — a candidate set
narrowing through phases that are each allowed to cost more than the last, over
data whose schema decides what any of it costs. Storage is modelled honestly and
is one click away on every node, but it is not the subject: it is one click away
precisely so that it cannot become the subject.

### The rule about framing

**Vespa is explained on its own terms, never by contrast with another search
engine.** No source file, no step blurb and no document may name one; the list
of names lives in `scripts/check-models.mjs`, which fails the build if one
appears.

This is not stylistic. An earlier version of this app organized itself around
the comparison — its headline lesson was "there is no refresh", which is a fact
about a system the reader may never have used — and the framing quietly chose
the whole design: it put storage at the centre of every node card, gave two
maintenance jobs top-level buttons, and left ranking, tensors and the vector
space undrawn. A negative lesson teaches nothing to a reader who does not know
what is being negated, and it steers the author toward the wrong subject. The
positive statement of the same fact is better in every way:

> Vespa is a real-time engine. A write lands in the structures a query reads —
> the attribute columns, the memory index, the HNSW graph — so a document is
> queryable a few milliseconds after the ack.

---

## 2 · Accuracy guardrails

These are correctness requirements, not stylistic preferences. Each one is
something Vespa genuinely does, and each one is something a plausible-looking
change could quietly break.

### 2.1 Two tiers, and they are not interchangeable

The **stateless container cluster** parses and rewrites queries, runs the
indexing chain on writes, runs application logic, merges results, runs
`global-phase`, and fetches summaries. The **content cluster** stores data and
does matching and the content-node ranking phases. They scale independently and
the picture must keep them visibly separate.

The container tier is touched **at both ends** of a query — and for a
recommendation, a third time before either, to fetch the user document.

### 2.2 Documents live in buckets, placed by an algorithm

A document id is hashed to a **location**; the leading bits of the location name
a **bucket**. Buckets are placed on nodes by the **ideal state** algorithm, a
variant of CRUSH: each node gets a pseudo-random draw per bucket, the nodes are
ranked by their draw, and the top `redundancy` of them store it. Nothing keeps a
per-document placement table anywhere in the system.

The consequence that must survive any change: **removing a node must not change
the relative ranking of the remaining nodes for any bucket.** That is the whole
reason to use this algorithm rather than a hash-modulo, and `npm run check`
asserts it over a 3-node recomputation rather than a filter of the 4-node
answer.

Real Vespa also **splits and joins** buckets as they grow and shrink; this app
fixes the split level (`BUCKET_BITS = 3`, eight buckets). See §4.

### 2.3 Exactly one replica of each bucket is ACTIVE

Every content node participates in every query, but a node may only return
documents from buckets it is the **active** replica of. Drop that rule and a
redundancy-2 cluster returns every document twice. `activeReadyDocs` in
`src/cluster.js` is the single place this is enforced, and the app draws
non-active copies dimmed so the distinction is visible rather than asserted.

### 2.4 One document database per document type

Proton keeps a separate document database per document type, and the container
rewrites a query into one per type. So the `user` documents in this app share the
same nodes and the same buckets as the products — same hash, same ideal state,
same replicas — and are still invisible to a product query. `activeReadyDocs`
takes a `type` for exactly this reason; it is not a modelling convenience.

### 2.5 Proton has three sub-databases

- **Ready** — indexed and searchable. Attributes in memory, index-field postings
  in the memory index or a disk index.
- **Not Ready** — stored but not indexed. Only populated when
  `searchable-copies` is lower than `redundancy`, which this app does not
  configure, so it is always empty and is drawn as such.
- **Removed** — tombstones: id plus timestamp. They exist so that a bucket merge
  between replicas cannot resurrect a document one replica has already deleted.
  Deleting the tombstone eagerly would be a correctness bug in a real cluster,
  and the app must not draw removal as if it were free.

A document with no index fields — a `user`, whose whole content is attributes —
is in Ready and in **no index at all**. `hasIndexFields` in `src/cluster.js` is
what keeps it out of the disk indexes, and that follows from its schema.

### 2.6 A document is queryable the moment the write is acknowledged

The feed path writes into the memory index, the attribute columns and the HNSW
graph. All three are mutable, all three are read live by queries, so the document
is findable a few milliseconds after the client's 200. Making it findable is not
a separate job — it is what the write already did.

`npm run check` verifies this directly: it feeds a document and queries for it
with no intervening flush.

### 2.7 Flush and fusion are maintenance jobs, not APIs

- **Flush** writes the memory index out as a new disk index and flushes the
  attribute vectors. It buys back RAM and lets the transaction log be pruned up
  to the flushed serial.
- **Fusion** merges several disk indexes into one, and is the only thing that
  physically reclaims the space a removed document used (a disk index is
  immutable and cannot have entries taken out of it).

Neither changes what a query can find, and `npm run check` runs the same query
either side of both and asserts the hit list, its order and every score are
byte-identical.

**Neither is triggered by a person.** Proton's flush engine runs a flush when the
memory index passes the flush strategy's budget (`maxmemorygain`,
`diskbloatfactor`, `maxage`). The app models this as a threshold on each node's
memory index (`FLUSH_MAXMEMORYGAIN`), drawn as a gauge, and **starts the flush op
itself** when it is crossed. Do not give flush a button: it would misrepresent
who does what. The one `Force fusion` control exists so the op stays scrubbable
and is labelled as forcing what proton would do anyway.

### 2.8 Attributes are updated in place; index fields are not

An attribute is an in-memory column. Assigning one writes a value at the
document's local id: no posting list changes, no document-store read, no rewrite.
That is what "write at memory speed" means, and it is why real-time signals
belong in attributes.

Updating an **index** field is a read-modify-write against the document store
followed by re-indexing, and it leaves the old postings in a disk index for a
fusion to reclaim.

Both paths are modelled, and `ops/update.js` chooses its **step list** from the
field — so which path you took is visible in the footer before you read a word.
`npm run check` asserts that the attribute path leaves every memory index and
every disk index byte-identical, that the index path writes a new memory-index
entry, and that the index path has more steps.

### 2.9 The ranking phases, and where each one runs

| phase | runs on | sees |
| --- | --- | --- |
| match | content node | the Ready sub-database, active buckets, one document type |
| `first-phase` | content node | every matched document |
| `second-phase` | content node | that node's top `rerank-count` |
| `global-phase` | **container** | the merged top `rerank-count`, from all nodes |

This progression is the app's primary visual: each content node's body is a
funnel whose bars are these phases, scaled against the documents the node was
active for. Three rules follow and must not be broken:

- **`first-phase` cannot normalize.** It runs per document and has no idea what
  the other documents scored. A hybrid `first-phase` is a weighted sum with a
  tuned constant (`config.lexicalWeight`). Cross-hit normalization is
  `normalize_linear`, and it is a `global-phase` feature precisely because the
  container is the first place in the system that has seen every node's hits.
  An earlier draft used `normalize(lexical)` in `first-phase`; that is not
  Vespa, and it produced a per-node artifact that promoted a document purely
  because it was the only hit on a sparse node.
- **`second-phase` reorders the head, it does not truncate the tail.**
  Documents below the rerank cut keep their first-phase score and are still
  returned.
- Hits outside `global-phase`'s `rerank-count` keep the content-node score and
  are ordered **after** the reranked ones. The two groups came out of different
  expressions and their scores are not comparable, so interleaving them by value
  would be comparing numbers that do not mean the same thing.

### 2.10 What crosses the network, and when

The first protocol phase returns **ids, relevance scores and declared
match-features**. No field values. The second phase — the **summary fill** —
fetches document summaries for the hits that made the final list. This is the
entire reason there are two phases, so the two return flights are drawn as
visibly different kinds of traffic (hollow chips for ids, filled for documents).

### 2.11 BM25 statistics are per content node

Document frequency and average field length are computed from the documents on
the node, not cluster-wide, so the same document can score slightly differently
on two nodes. The app reproduces this rather than averaging it away.
`bm25` defaults: `k1 = 1.2`, `b = 0.75`.

### 2.12 `closeness` and the vector path

- `closeness(field, name) = 1 / (1 + distance)`, in `[0, 1]`, 1 being a perfect
  match. Asserted by `npm run check`.
- `{targetHits: N}nearestNeighbor(field, q)` exposes at most N neighbours to
  `first-phase` **per content node**, not per cluster. Asserted.
- The HNSW index is **mutable and real-time**: one graph per tensor field per
  content node, updated live, with no second graph to merge in later.
- **A tensor attribute without an `index` has no graph.** Nothing can
  nearest-neighbour-search it — and nothing needs to, for a user profile — so
  writing a new value is one assignment to one cell. This is exactly why
  per-user, per-click personalization is affordable, and `npm run check` asserts
  that the `user` schema declares no HNSW on `profile`.

### 2.13 Pre-filter and post-filter are decided by the schema

A structured filter combined with `nearestNeighbor` is evaluated **before** the
graph walk when the filtered attribute has `fast-search`: the walk is restricted
to documents already known to pass, and every neighbour returned is one that
matches. Without `fast-search` the filter cannot be evaluated cheaply up front,
so the walk runs unrestricted and the filter is applied to what comes back —
throwing away hits the cluster paid to find, and returning fewer than
`targetHits`.

This is modelled both ways, driven by `config.categoryFastSearch`, and it is the
clearest demonstration in the app that a schema line is a performance decision.

### 2.14 The indexing chain runs in the container, once

Vespa analyzes, embeds and extracts attributes in the container's indexing chain
and ships the **result** to the content nodes. The replicas do not each redo the
work — which is why an expensive embedding model costs one inference per
document rather than one per copy.

### 2.15 The schema is the application

There is no mapping API and no index-settings endpoint: behaviour follows from
the deployed package. So `buildProductSchema(config)` and each mode's
`profile(config)` are generated from the **same config object `runQuery` reads**.
Keep them on one object. If the panel is ever built from a different source than
the model, the schema on screen will drift from the behaviour beside it and the
app will be lying in the most damaging possible place.

---

## 3 · Model architecture

A pure derivation of visible state from `(cluster, op)`.

- `cluster` is committed state: `{ nodes, docs }`.
- `op = { type, step, payload }`.
- `deriveCluster(cluster, op)` returns how the cluster should *look* at the
  current step. `applyOp` = derive at the last step, and folds.
- `opExtra(cluster, op)` returns transient per-step information.

An op module may export **`stepsFor(payload)`** instead of a fixed `steps`, and
both `query` and `update` do. Which phases a query runs is a property of its rank
profile; whether an update is cheap is a property of the field's indexing
statement. In both cases the footer changes shape, which is the cheapest way to
make that visible. `lastStep` therefore takes the whole op, not its type.

---

## 4 · Flagged simplifications

Every one of these is a place the app is knowingly not Vespa. They are listed so
that nobody has to reverse-engineer whether a difference is a bug.

| what | the app | real Vespa |
| --- | --- | --- |
| **the embedding model** | a 2-dimensional lexicon: each known word sits at an angle, head nouns weighted 5, modifiers 1; a text is the normalized weighted sum | a real bi-encoder producing 384–1536 dimensions. The two dimensions are what make the vector-space panel possible, and that panel is worth the simplification |
| **HNSW** | `nearestNeighbor` is computed exactly, then truncated to `targetHits` | a hierarchical graph walk visiting a small fraction of the corpus. Same results, sub-linear cost. See PLAN.md item 1 |
| **the term dictionary** | postings are a list of document ids per index | a prefix-compressed on-disk dictionary over position-based posting lists, with bitvectors for frequent terms |
| **`global-phase` model** | the best per-passage closeness — late interaction over the vectors the pooled document embedding averaged away | an ONNX cross-encoder, or a ColBERT MaxSim profile. The app's version is the same *shape* of computation |
| **angular distance** | `1 − cos θ` | a monotone function of the angle. Any monotone transform gives the same ranking, which is all the app reads it for |
| **the profile update** | `normalize(profile + 0.5 · engaged)` | a learned update with decay, or a periodically retrained embedding. The shape — the profile moves toward what you engaged with, by one attribute assignment — is right |
| **bucket split level** | fixed at 3 bits, 8 buckets | buckets split and join continuously as they grow; the "used bits" of a bucket id changes |
| **rerank counts** | `second-phase` 3, `global-phase` 5, `hits` 5 | 100 and 100 by default. The app badges its own numbers wherever it shows them |
| **flush strategy** | a document count per node (`FLUSH_MAXMEMORYGAIN`) | a memory budget in bytes, plus disk-bloat and age triggers |
| **cluster size** | 4 content nodes, 2 containers, 8 buckets, 14 products, 2 users | thousands of buckets per node, so the placement imbalance visible here averages out |
| **`weakAnd`** | modelled as an OR over query terms | `weakAnd` is an OR that skips documents whose best possible score cannot reach the current heap threshold. See PLAN.md item 4 |
| **analysis** | lowercase + split on non-alphanumeric | language detection, tokenizing, normalizing, stemming |
| **the user fetch** | one step in the query op | two separate client queries in Vespa's own tutorial, or a custom Searcher in production. Either way it is application logic in the stateless tier, which is what the step shows |
| **`searchable-copies`** | equals `redundancy`, so Not Ready is always empty | configurable; a lower value is how you trade memory for failover speed |
| **grouping, RAG, streaming search, multi-region** | not modelled | see PLAN.md |

---

## 5 · Things that were tried and removed

Recorded so they do not get rebuilt.

- **The comparison with other search engines.** The first version of this app
  taught Vespa by contrast, and its headline lesson was the absence of a concept
  from a system the reader may never have used. See §1. It is gone, `npm run check` keeps it gone,
  and the reason is that it produced a worse app, not merely a differently
  worded one: the comparison chose the subject, and the subject it chose was
  storage.

- **`normalize(lexical)` in `first-phase`.** It made the hybrid demo produce a
  believable, wrong answer: a content node holding a single active document
  normalized that document's BM25 to 1.0 and promoted it above documents that
  genuinely scored better elsewhere. Vespa has no such feature, and the fix was
  to move normalization to `global-phase`, where Vespa actually puts it. See
  §2.9.

- **Flush and fusion as top-level buttons.** They are jobs proton schedules from
  the flush strategy, and giving them buttons implied an API that does not
  exist while spending a third of the control rail on them. Replaced by the
  per-node gauge and an automatic trigger. See §2.7.

- **A native `<select>` for the update/remove target.** It could not be driven
  from a screenshot-based agent, so that half of the write path had no
  end-to-end UI verification, and it hid the corpus behind a click for no
  benefit. Replaced by chips.
