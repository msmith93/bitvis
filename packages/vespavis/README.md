# vespavis

An interactive, step-by-step visualization of how [Vespa](https://vespa.ai)
serves the workloads it is actually used for: text search, vector search, hybrid
retrieval with multi-phase ranking, filtered vector search, and real-time
personalization. Everything is simulated in the browser — no backend, no Vespa
instance, no data leaves the page.

Part of the [bitvis](https://bitvis.bitsculpt.top) family.

```bash
npm install          # once, at the repo root
npm run dev -w @bitvis/vespavis
```

## What it shows

The centre of the screen is a Vespa cluster with its two tiers drawn as two
separate boxes, because that split is the architecture:

- a **stateless container cluster**, which prepares queries, runs application
  logic and the indexing chain, merges results, runs the final ranking phase and
  fetches document summaries;
- a **content cluster** of four nodes, each running a **distributor** and
  **Proton**, which stores the data and does the matching.

Each content node's body is a **funnel**: the ranking phases, as bars, scaled
against the documents that node is responsible for. Read down the stack and you
read Vespa's cost model — every phase sees fewer documents than the one above
it, and that is exactly what buys the right to run a more expensive expression.

```
active docs   ████████ 8
matched       █████    4
first-phase   █████    4
second-phase  ███      3
returned      ███      3
```

## Retrieval, four ways

These are not four buttons on the same thing — each sends a different query tree
and selects a different rank profile, which is why the footer grows and shrinks
as you switch between them.

| mode | what it does |
| --- | --- |
| **Text search** | `userQuery()` matched against the index fields, scored with `bm25(title) + bm25(description)` |
| **Vector search** | the query text is embedded and `{targetHits: 4}nearestNeighbor(embedding, q)` returns the closest documents per node, ranked by `closeness` |
| **Hybrid + rerank** | both retrievers ORed into one query tree, then `first-phase`, `second-phase` on each node's top-k, and `global-phase` in the container |
| **Filtered vector** | `category contains "…"` combined with the vector search — and one line of schema decides whether the filter runs before the graph walk or after it |

Run `waterproof jacket` in the first three in turn. BM25 puts a bluetooth
speaker second. The vector search finds a windbreaker that contains neither
word. Hybrid is the only one that gets both right — and the **vector space**
panel shows you why, because the whole embedding space is two-dimensional and
fits on a circle: you can see the speaker sitting 80° away from the query.

## Recommendation

Switch use case and the app reads a **user document** instead of a query string.
A `user` has a `profile` tensor — and, crucially, no HNSW index on it, because
nothing ever nearest-neighbour-searches users. The container fetches that
document, then searches products with the profile as the query vector.

Engage with one of the results and watch what happens: a partial update writes a
new tensor into **one attribute cell**, the profile arrow moves in the vector
panel, and the next recommendation is different. No document was re-indexed and
no graph was repaired, because there is no graph on a plain attribute. That is
why personalizing per click is affordable.

## The schema is live

In Vespa there is no mapping API and no index-settings endpoint: behaviour
follows from the deployed application package. So the schema in this app is not
a static code block — it is generated from the same config the model reads, and
the panel edits it:

- toggle **`attribute: fast-search`** on `category`, then run the filtered mode.
  With it, the filter runs *before* the graph walk and nothing is wasted. Without
  it, the walk spends its whole budget and the filter throws most of the results
  away.
- drag the **first-phase lexical weight** and watch the bluetooth speaker climb.
- change **`targetHits`** and see more or fewer documents ringed in the vector
  panel; change the **rerank counts** and see the funnel's lower bars move.

## The write path

`Feed a document` walks one document from an HTTP request to being queryable in
six steps: the container's indexing chain analyzes and embeds it, a distributor
hashes its id to a bucket and runs the ideal-state algorithm to find the nodes,
every replica writes it to a transaction log, and Proton puts it in the Ready
sub-database — the memory index, the attribute columns and the HNSW graph.

All three of those are mutable and all three are read live by queries, so the
document is findable a few milliseconds after the ack. Making it findable is not
a separate job; it is what the write already did.

**`Update`** shows the other half of schema design. Point it at `popularity` — an
attribute — and the value is assigned in place in memory: four steps, nothing
re-indexed. Point it at `title` — an index field — and the footer grows to six:
the document is read back off disk, re-indexed and written back, leaving old
postings behind for a fusion to reclaim.

**Flush and fusion** have no buttons, because in Vespa they have no API. Proton's
flush engine runs a flush when a node's memory index passes its budget — watch
the small gauge on each node card fill as you feed, and the flush start on its
own. Neither job changes what a query can find. (`npm run check` asserts exactly
that: the same query, either side of both, down to the scores.)

## Reading the picture

- **`0x3`** chips on a node are the buckets it holds. Filled means it is the
  **active** replica — and only the active replica may answer for a bucket,
  which is what stops a redundancy-2 cluster from returning every document
  twice. Copies on a non-active node are drawn dimmed.
- **`@alice`** chips are user documents. Same hash, same buckets, same nodes as
  the products beside them — a different document *type*, which is what keeps
  them out of a product query.
- Chips flying **down** the wire are the query. Chips flying **up** during
  *Return and merge* are hollow, because they are ids and scores — no field
  value has crossed the network yet. Only the **summary fill** flight carries
  documents.

## Accuracy

`SPEC.md` is the authoritative description of the intended behaviour *and* the
accuracy guardrails, with a table of every place the app knowingly simplifies.
`npm run check` enforces the parts that are arithmetic or invariance — the
distribution algorithm, the flush/fusion invisibility guarantee, the in-place
update, the pre/post-filter split, the recommendation loop, and the specific
disagreements between the retrieval modes that the demo queries depend on.

`PLAN.md` is the roadmap, starting with a real HNSW graph walk drawn on the
vector-space panel.

## Commands

- `npm run dev` — Vite dev server; the primary way to run and verify the app.
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/`.
- `npm run check` — assertions over the pure models.

## Deploy

Infrastructure lives at the repo root:

```bash
../../scripts/deploy.sh VespavisStack
```
