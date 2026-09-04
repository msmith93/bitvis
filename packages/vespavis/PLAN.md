# vespavis — plan

What exists today, and what to build next. Ordered by how much each item adds
per unit of work.

---

## Where it got to

The app models Vespa at the level of **whole components**: two tiers, four
content nodes, buckets placed by the ideal-state algorithm, Proton's three
sub-databases, and the four ranking phases with the network hops between them.

The subject is retrieval and ranking as a computation. A content node's body is
a **funnel** whose bars are the ranking phases scaled against the documents that
node was active for, so the narrowing is the shape of the picture rather than a
claim in the text. Storage is a click away and stays there.

**Two use cases.** *Product search* runs four query modes — text, vector, hybrid
and filtered — whose rank profiles change the number of steps in the footer.
*Recommendation* reads a user's profile tensor out of a `user` document and
searches with it; engaging with a result writes a new tensor into one attribute
cell, moves the arrow in the vector-space panel, and changes the next answer,
with no index touched.

**The schema is live.** `buildProductSchema(config)` and each rank profile are
generated from the same config object the model reads, so toggling
`attribute: fast-search`, dragging the first-phase lexical weight, or changing
`targetHits` and the rerank counts changes both the text on screen and what the
next query does.

**The vector space is drawn.** The embedding model is 2-D specifically so the
whole space fits on a circle: documents as dots, the query and the user profile
as arrows, `nearestNeighbor`'s returns ringed.

It answers, correctly and visibly:

- Where does a document go, and who decided? (bucket → ideal state → replicas)
- Why does a redundancy-2 cluster not return everything twice? (active copies)
- How can two document types share the same nodes and buckets and never collide?
- When does a write become queryable, and why is that the same moment it lands?
- What are flush and fusion for, and why does nobody press them?
- Why is a partial update to an attribute nearly free, and to an index field not?
- Where does each ranking phase run, over how many documents, and what crosses
  the wire between them?
- Why does hybrid retrieval beat either half of it — and where in the pipeline
  each decision got made?
- Why does one line of schema decide whether a filtered vector search wastes
  most of its work?
- Why can a system personalize per click without re-indexing anything?

What it does **not** do is open anything up. Every box is still a box: the
storage panel is a list, not a zoom, and the vector space is a plot, not a walk.
That is the gap the top of this plan closes.

---

## Tier 1 — the zoom levels

These turn a diagram into a visualizer. Each is one close-up module plus a
registry entry, following the pattern this repo has already proven elsewhere: a
pure model producing a **replayable trace**, and a stage that folds the trace
into a view rather than animating imperatively. Porting that shell (~800 lines)
is the up-front cost, and item 1 is what makes it worth paying.

### 1. Walk a real HNSW graph

The biggest single win, and the thing people most want to see. Today
`nearestNeighbor` is computed exactly and truncated to `targetHits`, which gets
the right answer for the wrong reason — the whole point of HNSW is that it does
not look at everything.

Build a real (small) HNSW over the corpus vectors on each node: hierarchical
layers, `max-links-per-node` neighbour lists, greedy descent from the entry point
on the top layer, then a beam search on layer 0 sized by
`targetHits + hnsw.exploreAdditionalHits`. Emit a trace of visited nodes,
evaluated distances and the candidate heap at each step.

Then the close-up shows what no diagram can: **14 documents, 5 distance
computations**. And the schema's HNSW parameters stop being decoration — raising
`max-links-per-node` visibly costs memory and improves recall; lowering
`exploreAdditionalHits` visibly misses a true neighbour. They join the live
schema config the moment the walk is real.

**The vector-space panel is already the canvas for this.** The graph's edges can
be drawn on the same circle the documents already sit on, and the walk animated
along them — no second visual metaphor needed.

Pair it with the filter, which is where it gets genuinely interesting. The app
already models pre-filter and post-filter as outcomes; the walk shows the
mechanism:

- **pre-filter**: the graph with filtered-out nodes struck through and the walk
  routing around them — including the case where a selective filter disconnects
  the graph and the walk has to fall back to exact search.
- **post-filter**: the walk spends its whole budget, then most of what it found
  is discarded. The app currently reports that as a number; here you would watch
  it happen.

### 2. Zoom into a content node: matching and the ranking heap

Click a node's funnel and land inside Proton:

- the query tree as Vespa builds it (`weakAnd` over terms, ORed with a
  `nearestNeighbor` operator, ANDed with an attribute filter);
- hit estimation per operator and the query-tree optimization that reorders them
  cheapest-first;
- documents flowing through `first-phase` one at a time into a bounded heap;
- the `second-phase` re-scoring, with the heap visibly reordering.

This is the funnel's own mechanism, one level down, and it is where
`total-rerank-count`, `rank-score-drop-limit` and the `match-phase` degradation
controls become concrete rather than configuration trivia.

### 3. Zoom into the container: merge, `global-phase`, fill

The mirror image, and what makes the two-tier split pay off:

- four sorted lists arriving and being merged;
- `normalize_linear` visibly rescaling across hits from different nodes —
  something no content node could have done;
- the late-interaction scoring, with the passage vectors that arrived as
  `match-features` shown next to the pooled vector they refine;
- the fill request going back out for exactly the winners, and nothing else.

### 4. `weakAnd`, properly

Today `weakAnd` is modelled as an OR, and `SPEC.md` flags it. The real thing is
why Vespa can serve a many-term query without scoring the union: it keeps a heap
of the current top-k and skips any document whose best achievable score cannot
reach the threshold. Model the upper bounds, the moving threshold and the
documents skipped, and the funnel's "matched" bar stops being the union size.

---

## Tier 2 — the remaining named use cases

### 5. RAG

Vespa's fastest-growing workload and its second headline use case. The retrieval
half already exists; what is missing is the container component that takes the
top-k, assembles a prompt with citations, and streams an answer back.

Doable without a real model: a template that visibly assembles the retrieved
passages is enough to show the shape. The lesson it teaches is one the app is
already set up for — **a generator can only cite what retrieval handed it**, so
the reranking phases matter more here than anywhere else. Running the same
question through the text, vector and hybrid modes and watching the assembled
context change would make that unmissable.

Sits naturally as a third use case beside search and recommendation, reusing the
whole query pipeline and adding one container-side step after the fill.

### 6. Grouping and aggregation

`select=all(group(category) each(output(count(), avg(popularity))))`. The
e-commerce browse use case, and genuinely different from everything modelled so
far: grouping runs as **extra protocol phases**, each content node groups its own
slice, the container merges the group trees, and `precision` controls how many
groups each node returns before merging — which is why a `max()`-limited grouping
can be *approximately* wrong. Showing an approximate count and then showing
precision fix it would teach the whole feature in two steps.

The corpus already has a `category` attribute and a numeric `popularity`, so the
model work is small; the cost is a new panel and two extra query steps. It also
extends the funnel naturally — a grouping phase is another bar.

### 7. Multi-vector documents and per-passage retrieval

The schema already declares a `tensor<float>(p{}, x[2])` passages field and
`global-phase` already scores against it. The next step is making it a
*retrieval* structure rather than only a reranking one: HNSW over a mapped
dimension, where one document contributes several points to the graph and a hit
is a `(document, passage)` pair folded up to its document. This is the honest
answer to "why did the pooled vector miss it", and on the vector-space panel it
is literally visible — one document becoming two dots.

### 8. Streaming search

For personal-data workloads, Vespa can skip the index entirely and stream over a
**selected bucket** using the `g=` grouping modifier in the document id. Same
query language, completely different cost model: no index to maintain, cost
proportional to one user's data rather than the corpus. The app already models
document ids, buckets and a `user` document type, so this needs a mode toggle and
a different match step — cheap, and it retroactively explains why the modifier
exists.

---

## Tier 3 — the cluster as a living thing

### 9. Elasticity: add and remove a node, live

The ideal-state algorithm is already implemented and already correct. What is
missing is the button. Add a node and watch a minority of buckets change owner,
with the bucket-move job copying data and the "buckets not at ideal state" count
draining to zero. Remove one — or **retire** it, the graceful version — and watch
secondary replicas become active.

This is the payoff for having modelled buckets rather than a fixed partitioning,
and today that payoff is asserted in a code comment nobody reads. Probably the
best value-per-line item in this plan.

### 10. Node failure, cluster state, and the cluster controller

Kill a node mid-query. The cluster controller notices, generates a new cluster
state, broadcasts it, and the distributors reroute. Coverage drops below 100% and
the response says so — Vespa returns degraded results rather than an error, and
`coverage` in the response is how you find out. That behaviour is invisible today
because the admin tier is three inert labels.

### 11. Consistency: bucket merges and why tombstones exist

Two replicas diverge (one node was down for a write). The distributor's checksum
comparison notices, a bucket merge runs, and the tombstone in the Removed
sub-database is what stops the merge from resurrecting a deleted document. The
tombstone is already modelled and the step copy already explains it in words;
showing it would be much better than saying it.

### 12. Grouped distribution

Today the cluster is flat: every query goes to every node. Real deployments use
**groups**, each holding a complete copy of the corpus, dispatching a query to
one group at a time — which is how you scale throughput linearly instead of
latency. Showing flat and grouped side by side, with the same query, is the
clearest possible statement of what the two topologies buy.

---

## Tier 4 — polish and pedagogy

### 13. Guided scenarios

The walkthrough engine used elsewhere in this repo spotlights a real control and
advances when the reader actually uses it. It ports over almost unchanged, and
this app has five scenarios waiting:

1. **The write path.** Feed a document and query for it immediately.
2. **Why hybrid.** Run `waterproof jacket` in all three retrieval modes and
   watch the bluetooth speaker rise and fall.
3. **One line of schema.** Run the filtered mode, turn off `fast-search`, run it
   again, and read the wasted work.
4. **Attributes vs index fields.** Update `popularity`, then `title`, and watch
   the footer grow by two steps.
5. **Personalization.** Recommend, engage, recommend again — with the vector
   panel open.

### 14. Query-time controls as first-class inputs

`hits`, `timeout`, `ranking.profile`, `ranking.matching.numThreadsPerSearch`.
The schema config already proves the pattern; these are the request-level twin
of it, and the distinction between "what the application declares" and "what the
caller asks for" is itself worth drawing.

### 15. Tensor expressions, shown as tensors

The app declares tensors and computes with them, but never *shows* one. A small
panel rendering `query(q)`, `attribute(passages)` and the reduce that combines
them — with the actual numbers — would make Vespa's type system concrete. This
is the one remaining place where the app says "tensor" and shows a float.

### 16. The document store and the summary phase

The fill step says "fetch summaries" and draws a flight. Underneath is a
compressed blob store with chunked reads, a bloat factor and a compaction job.
Worth a small close-up eventually, mostly because it explains why
`summary: dynamic` and attribute summaries exist.

### 17. Deployment and the application package

Vespa's configuration model — one package, deployed once, containing schemas,
`services.xml`, models and components — is unusual and is currently only implied
by the schema panel. A short "deploy" animation showing the config server
deriving config for every node would make the admin tier mean something, and it
is the natural home for the fact that changing an `indexing` statement triggers
a reindex.

---

## Known rough edges

Small, honest, and worth fixing before any of the above:

- **The corpus is unevenly distributed.** With 8 buckets and 14 products, one
  node is the active replica for very few of them, so its funnel is dull. Real
  clusters have thousands of buckets per node and this averages out. Either
  raise the bucket count and the corpus size together, or say so in the UI
  rather than only in `SPEC.md`.
- **The layout assumes a tall viewport.** The left column scrolls on a short
  window. Now that Flush lost its button the rail is shorter, but the Documents
  section grew chips; worth another pass.
- **The `indexing:` line in the schema panel needs horizontal scrolling.** Real
  Vespa syntax, genuinely that long; the block form would wrap but reads worse.
- **No close-up affordance exists**, so nothing on screen invites the reader
  deeper. Even before item 1 lands, a magnifying glass on the funnel would set
  the expectation.
- **The recommendation profile update is unlearned.** `normalize(profile + 0.5 ·
  engaged)` is the right *shape* and `SPEC.md` flags it, but a decay term and a
  short engagement history would cost little and be more honest.
