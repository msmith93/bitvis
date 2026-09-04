# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this package.

> This app is `packages/vespavis` in the **bitvis** monorepo (npm workspaces).
> Run `npm install` once at the repo root. Deploy infra lives at the repo root
> (`infra/`, `scripts/`); deploy this site with
> `../../scripts/deploy.sh VespavisStack`.

## Commands

- `npm run dev` — start the Vite dev server (the primary way to run/verify).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` locally.
- `npm run check` — assertions over the pure models (`scripts/check-models.mjs`).

There is no test runner, linter, or formatter configured, and there should not
be: the deliverable is a screen-recordable proof-of-concept, so "verify" means
running `npm run dev` and stepping through a query, a feed, an update and a
recommendation. `npm run check` is the narrow exception — it covers the
invariants a browser will animate confidently and wrongly. Keep it to arithmetic
and invariance, plus the one framing rule below.

## What this app is

A single-page React (Vite) app teaching how Vespa serves its most common
workloads. Everything is simulated client-side — no backend, no localStorage,
all state in React.

**Its subject is retrieval and ranking as a computation**, not storage: a
candidate set narrowing through phases that are each allowed to cost more than
the last, over data whose schema decides what any of it costs. Storage is
modelled honestly and is one collapsed panel away on every node card. Keep it
there. It was the centre of an earlier version and it crowded out everything
that makes Vespa worth explaining.

**`SPEC.md` is authoritative** for both intended behaviour and the accuracy
guardrails. Read it before changing the model. **`PLAN.md`** is the roadmap; if
you build something from it, move the entry into "where it got to" rather than
deleting it.

## The framing rule

**Vespa is explained on its own terms, never by contrast with another search
engine.** No source file, no step blurb and no document may name one, and
`npm run check` fails the build if one does (the banned list lives in
`scripts/check-models.mjs`, which is its own single exemption).

This is a design constraint, not a style guide. The first version of this app was
built around the comparison, and the comparison chose the subject: it put storage
at the centre of every node card, gave two background maintenance jobs top-level
buttons, and left ranking, tensors and the vector space undrawn. `SPEC.md` §1 and
§5 record it. Say what Vespa does, not what it lacks.

## Architecture

A **pure derivation of visible state from `(cluster, op)`**, so the stepper can
scrub any operation forwards and backwards.

- **`src/schema.js`** is the source of truth for the application package. It
  exports `DEFAULT_SCHEMA_CONFIG` — the live, editable schema decisions — plus
  `buildProductSchema(config)`, `USER_SCHEMA`, the corpus and the users.

  **The one rule that matters here:** `buildProductSchema` and each mode's
  `profile(config)` in `ranking.js` must be generated from the SAME config
  object `runQuery` reads. In Vespa the schema *is* the application; if the panel
  is ever built from a different source than the model, the schema on screen will
  drift from the behaviour beside it, and the app will be lying in the most
  damaging possible place.

  **The corpus is tuned for exactly two disagreements** and `npm run check`
  asserts both: "Rain Shell Windbreaker" is the right answer for
  `waterproof jacket` and contains neither word, and "Waterproof Bluetooth
  Speaker" contains one of them and is not a jacket. Edit either and the hybrid
  lesson evaporates while the app still looks fine.

  Each product also carries `passages`, the per-field vectors that pooling threw
  away. **Nothing on a content node reads them** — the schema stores one pooled
  `embedding`, which is what HNSW indexes, so `first-phase` and `second-phase`
  can only see the average. They exist for `global-phase`, the phase allowed to
  be expensive enough to look again. That asymmetry IS the lesson; don't let a
  content-node feature start reading `passages`.

- **`src/cluster.js`** holds topology and placement. A document id hashes to a
  bucket; the bucket's replicas come from `idealState`, a CRUSH-like
  pseudo-random ranking of nodes seeded per `(bucket, node)`. Nothing stores
  where a document lives — it is recomputed. Four rules:
  1. `hash32` **must** keep its murmur3 finalizer. Plain FNV-1a over
     `bucket:node` strings leaves the differences between nodes' draws nearly
     constant, the ranking comes out the same for every bucket, and the cluster
     degenerates into two fixed pairs of nodes — a placement table drawn as if it
     were an algorithm. `npm run check` asserts against it.
  2. `activeReadyDocs` is the ONLY place the active-replica rule is enforced,
     and it also filters by document **type**. Proton keeps one document
     database per type, so `user` documents share the same nodes and buckets as
     products and are still invisible to a product query. Both filters are real;
     drop either and the model is wrong in a different way.
  3. `memoryIndex` and `diskIndexes` partition the index-field postings of
     `ready`. **Attributes are not partitioned** — an attribute exists in memory
     for every ready document from the moment it is written, which is the entire
     reason `ops/update.js` has a cheap path at all.
  4. `hasIndexFields` keeps attribute-only documents out of the disk indexes. A
     `user` has no index fields, so it is in Ready and in no index. That follows
     from its schema, not from convenience.

- **`op`** = `{ type, step, payload }` (held by `useOpLifecycle`). One module per
  type in `src/ops/`, registered in `src/ops/index.js`.

  A module may export **`stepsFor(payload)`** instead of a fixed `steps`, and
  both `query` and `update` do. Which phases a query runs is a property of its
  rank profile; whether an update is cheap is a property of the field's indexing
  statement. In both cases the FOOTER changes shape, which is the cheapest way
  to make that visible. Consequently `lastStep(op)` takes the whole op, and
  `ops/query.js` addresses its steps by **key**, never by index.

- **`src/ranking.js`** holds the query model and is where the accuracy risk
  concentrates. Four things that are easy to "fix" into being wrong:
  - **`first-phase` cannot normalize.** It runs per document. A hybrid
    `first-phase` is a weighted sum with a tuned constant
    (`config.lexicalWeight`). Cross-hit normalization is `normalize_linear` and
    it is a `global-phase` feature because the container is the first place that
    has seen every node's hits. An earlier draft used `normalize(lexical)` in
    `first-phase`; it produced a per-node artifact that promoted whichever
    document happened to be alone on a sparse node. SPEC.md §5 records it.
  - **BM25 statistics are per content node.** `fieldStats` is computed from the
    node's ready set, not cluster-wide. That is real Vespa; do not average it.
  - **Hits outside `global-phase`'s rerank-count keep their content-node score
    and stay BELOW the reranked ones.** The two groups came out of different
    expressions; sorting them together compares numbers that do not mean the
    same thing.
  - **Pre-filter vs post-filter is decided by `config.categoryFastSearch`,** and
    the post-filter path must keep *counting what it threw away*
    (`postFilterDropped`). A post-filter that silently returned the right answer
    would teach that the setting does not matter.

- **`src/vectors.js`** is the embedding model: a 2-D lexicon where each known
  word sits at an angle and a text is the normalized weighted sum. The
  **weights** are load-bearing, not decoration — head nouns are weighted 5 and
  modifiers 1, because with equal weights "insulated hiking boot with a
  waterproof leather upper" drifts halfway into outerwear on four modifiers and
  the vector search starts recommending boots to someone shopping for a coat.
  Two dimensions is a deliberate affordance: the whole space fits on screen,
  which is what `components/VectorSpace.jsx` exists to exploit and what makes
  the HNSW walk in PLAN.md item 1 drawable.

- **`src/components/ClusterStage.jsx`** draws the two tiers. Two things to
  respect:
  - A content node's **body is the funnel**, not its storage. The funnel bars
    are the ranking phases scaled against the node's active document count, so
    "each phase sees fewer documents and may cost more" is the literal shape of
    the picture. Storage lives behind the `▸ storage` expander. Do not promote
    it back.
  - The **flush gauge is not a button.** Proton's flush engine runs a flush when
    the memory index passes its budget, so the gauge fills as you feed and
    `App.jsx` starts the op itself when it crosses. Giving flush a button
    implies an API that does not exist.

- **`src/components/VectorSpace.jsx`** plots the actual embeddings — no
  projection, no layout, the angle a dot sits at IS the angle
  `angularDistance` measures. The query and the user profile are the two things
  that move, which is why they are the two things drawn as arrows.

- **`src/components/Flights.jsx`** decides what crosses the wire. The
  return-trip chips are deliberately drawn differently from the summary-fill
  chips: the first phase returns ids and floats, the second returns documents.
  Draw them the same and there is no visible reason for two protocol phases to
  exist, and the picture is lying.

- **`src/timing.js`** holds every animation-scheduling constant;
  **`src/constants.js`** holds what is genuinely fixed (Vespa's bm25 defaults)
  or a demo-size cap. Anything a reader can tune lives in
  `DEFAULT_SCHEMA_CONFIG` instead, because it is a schema decision.

- **`MobileWarning`** and **`HomeLink`** are identical copies of the files every
  bitvis visualizer carries. `CookieBanner` and `analytics.js` are copies too,
  with the banner's inline colours swapped to the Vespa light-theme palette.

## Colour

`src/index.css` uses Vespa's own brand palette, read off `brand.vespa.ai/color`:
the signature button green `#5cf699`, the deep olive `#2e2f27`, and the pastels
the brand guidelines lean on — the lavender `#b6aed5`, the sky `#b7e2f1`, the
pink `#dbb8ca` and the yellow `#e8d360`. Vespa's site is a light theme and **so
is this app** (it was dark once, like the other bitvis apps): the warm off-white
plus a wash of the brand lavender is the page, the deep olive is the ink, and the
lavender and sky carry the surfaces, borders and section accents throughout
rather than sitting nearly unused.

The bright green `#5cf699` stays the accent — "this is happening right now" — but
only as a **fill** (buttons, the returned-doc outline, progress bars). On the
light ground it is illegible as text or a hairline, so each of the three
load-bearing hues has an ink-dark partner token for that: `--accent-ink`,
`--accent-2-ink` (sky), `--lav-ink` (lavender). Reach for the `-ink` token
whenever the colour is text, a 1–2px border, or a thin SVG stroke; reach for the
plain token for a fill or a low-opacity tint. Every `rgba()` literal in the file
is one of these same colours — keep them in sync.

**No category colour may be the accent green.** The accent means "this is
happening right now" and it is what outlines a hit the query returned; a document
filed under outerwear must not look like a document the query just chose.
`CATEGORY_COLOR` in `src/schema.js` deliberately uses four *secondary* Vespa
colours for that reason, at mid strength so an 8px dot still reads on white. The
pink (`--accent-3`, a deeper rose on the light theme) is reserved for the user
tensor — the profile arrow, the user chips, the attributes line — so that "this
is a live in-memory value" reads as one idea across the app.
