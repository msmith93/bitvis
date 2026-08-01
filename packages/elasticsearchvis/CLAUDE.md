# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

> This app is `packages/elasticsearchvis` in the **bitvis** monorepo (npm workspaces).
> Run `npm install` once at the repo root. Deploy infra lives at the repo root
> (`infra/`, `scripts/`); deploy this site with `../../scripts/deploy.sh ElasticsearchvisStack`.

## Commands

- `npm run dev` — start the Vite dev server (the primary way to run/verify the app).
- `npm run check` — assert the pure models (`scripts/check-models.mjs`). No test
  framework; plain node. Covers the four things a browser cannot tell you are
  wrong: the two zoom levels agreeing on what a pattern matched, edit distance,
  the BM25 numbers the docs quote, and the shard close-up scoring identically to
  the cluster-level search. **Run it after touching any model.**
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` locally.

There is no test framework, linter, or formatter configured. The deliverable is a
screen-recordable proof-of-concept (see `SPEC.md`), so "verify" means running
`npm run check` for the arithmetic and then `npm run dev` and stepping through
Index → Refresh → Flush → Merge → Search.

## What this app is

A single-page React (Vite) app that teaches how Elasticsearch/Lucene indexes and
searches documents across a distributed cluster. Everything is simulated
client-side — no backend, no localStorage, all state in React. `SPEC.md` is the
authoritative description of the intended behavior AND the Elasticsearch-accuracy
guardrails (segments are immutable; a doc isn't searchable until refresh;
refresh ≠ flush; replicas live on a different node than their primary;
scatter-then-gather two-phase search). Treat those guardrails as correctness
requirements — read `SPEC.md` before changing the model.

## Architecture

The core pattern is a **pure derivation of visible state from `(cluster, op)`**,
which lets the stepper scrub any operation forwards and backwards.

- **`cluster`** (`src/cluster.js`) is the committed state: `{ shards, docs }`.
  Each shard has `buffer`, `translog`, and immutable `segments`
  (`{ id, docIds, searchable, committed }`). Topology is fixed (3 shards, 1
  replica each across 3 nodes; coordinator = node-1) via `SHARD_PLACEMENT`.
  `routeShard(docId)` is the deterministic murmur3 stand-in.

- **`op`** = `{ type, step, payload }` (held by `useOpLifecycle`). Each op type
  (`index`, `refresh`, `flush`, `merge`, `search`) is one module in `src/ops/`
  declaring `{ type, label, steps, stepsOf?, derive?, extra?, duration? }`; each
  step has the explanation text shown in the right panel and driven by the bottom
  `Stepper`. Adding an op type = one new module + a registry entry in
  `src/ops/index.js`.

  A module may declare `stepsOf(op)` when the PAYLOAD changes the walk — that is
  how a `dfs_query_then_fetch` search gets its extra pre-query step. Because of
  it, `stepsFor`/`lastStep` take the whole **op**, not its type, and **nothing may
  hard-code a search step index**: use `stepKey` / `stepAt` / `atStep` /
  `pastStep` from `src/ops/search.js`, and `opStepKey` / `opStepsDone` in the
  scenario snapshot.

- **Derivation** (dispatched by `src/ops/index.js` to the op modules):
  - `deriveCluster(cluster, op)` returns how the cluster should *look* at the
    current `op.step` — it clones the committed cluster (always, even for
    read-only search) and applies the module's partial effect of steps
    `<= op.step`. This is the single source of the rendered cluster; never
    mutate `cluster` directly to show in-progress effects.
  - `opExtra(cluster, op)` returns transient, non-persistent step info
    (in-flight doc highlights, computed search results).
  - `applyOp(cluster, op)` = `deriveCluster` at the last step; it *folds* a
    finished op into committed state (no-op for ops without `derive`, i.e.
    search). `start()` commits the previous finished op into `cluster` (via
    `applyOp`) before beginning a new one. This "fold before next" is why
    completed ops can stay rendered without double-applying — note the same
    care in `toggleDelete` for completed merges.
  - `opNote(op, extra)` returns one optional line about the op's PAYLOAD rather
    than its current step (the routing target, the wildcard's dictionary cost),
    rendered under the step blurb. Steps stay static per type; this is the hook
    for anything query-specific.

- **Scenarios** (`src/scenarios/`) are guided lessons, one module each plus a
  registry — the same shape as `src/ops/`. A scenario is
  `{ id, label, blurb, steps, setup? }`; a step spotlights a REAL control and
  advances when the user actually uses it (`advanceOn`), with `waitFor` gating
  visibility only and `onShow` allowed to drive the app (prefill an input,
  pause) but never to do the thing it is asking for. `src/useWalkthrough.js`
  owns which scenario is running and `start(id)` restarts one from step 1;
  `Walkthrough.jsx` renders the spotlight and `ScenarioPicker` is the topbar
  menu. The snapshot both predicates read is documented in
  `src/scenarios/index.js`. Steps that ask the user to press ▶ Play set
  `highlightPlay: true` and target `[data-tour="stepper-play"]`.

- **Multi-term queries (wildcard + fuzzy) and routing** are first-class query
  features, not scenario-only props. `src/wildcard.js` is the pure model:
  `parseQuery` keeps `*`/`?`/`~N` tokens whole (the analyzer would eat them), and
  `dictionaryTrace` produces the replayable probe list. **`seekPrefix` is the one
  field that decides cost for every pattern kind** — non-empty means the sorted
  dictionary can be seeked, empty means it must be enumerated — which is why a
  fuzzy's `prefix_length` maps straight onto it and `dictionaryTrace` needed no
  fuzzy branch at all. `matchTerm` is the SINGLE semantic authority on whether a
  term matches; `src/automaton.js` delegates its per-term verdict back to it, and
  that is what keeps the two zoom levels from drifting (asserted by
  `npm run check`). `ShardInspector` replays the trace per segment on the
  dictionary step (and `localSearchSteps` gives a pattern query its own step
  list, which is why the inspector addresses steps by `key` rather than index).
  Routing is
  `docRoute(doc) = routeShard(doc.routing || doc.id)`; a search payload's
  `routing` restricts `computeSearch` to one shard, and every downstream visual
  (stage highlights, scatter flights, both inspectors) follows from the shorter
  `serving` map.

- **`src/useOpLifecycle.js`** owns the op state machine: `cluster`/`op`/
  `opDone`/`playing`, the auto-play clock, memoized `derived`/`extra`,
  `start`/`step`/`play`/`pause`/`toggleDelete`/`resetTo`, and the `has*`
  capability flags. **`App.jsx`** keeps UI state (overlay phase, zoom,
  form inputs, doc/segment naming counters), composes the `can*` button flags,
  and builds op payloads.

- **`src/timing.js`** holds every animation-scheduling constant (`flightMs`,
  flight pads, scan/lead times, inspector dwell) so JS timeouts, framer
  transitions, and step budgets that must stay in sync share one named value.
  `src/constants.js` holds the demo-size caps (gather/fetch/top-k) shared by
  the search model and the flight components. `DICT_SEEK_MS` / `DICT_SCAN_MS`
  pace the dictionary probe replay, and the inspector's dwell for that step is
  computed from them the same way op steps budget for flights.

- **Close-ups** (`src/closeups/`) are the zoom levels, and they NEST. `CloseUp.jsx`
  is a generic shell (backdrop, head, explain box, mini-stepper + its auto-play
  clock, and the entrance spring out of the clicked element); each zoom is one
  module in `src/closeups/stages/` exporting
  `build(...) → { key, title, sub, steps, dwell?, Stage, stageProps, source,
  className? }`, and `src/closeups/index.js` is the registry
  (`shardCloseUp` / `coordCloseUp` / `closeUpStillValid` / `closeUpAnchor` /
  `buildCloseUp`). **Adding a zoom = one module plus one case in the registry.**
  The `scoring` stage (one document's BM25) and the `dictionary` stage are both
  nested — opened from inside the shard close-up — so they inherit their validity
  from the stack root.
  Three things to respect:
  - App holds ONE `closeUps` array (the stack, innermost last), not a flag per
    zoom. Only the top is `active`: the shell runs a clock only for it, and stages
    read `active` to park their own timers (that is how the shard stage's probe
    replay freezes behind a child). `closeUpStillValid` is checked against the
    stack ROOT only — a nested zoom lives and dies with its parent. `zoomShard`
    and `coordZoom` survive in the walkthrough snapshot as projections of the
    root, alongside `closeUpKind` / `closeUpDepth`.
  - A `Stage` must be a **module-scope** component and receive its data through
    `stageProps`. Defining it inside `build()` gives it a new identity on every
    re-derive, which remounts it and destroys flight/probe state mid-animation.
  - A `Stage` returns a **fragment**, so its pinned strips (`.si-querybox`) and
    its scroller (`.si-scroll`) are direct flex children of `.shard-inspector` —
    the stylesheet's `> .si-*` rules depend on it. Don't wrap it in a div. Also
    note the shell deliberately has no `AnimatePresence` exit: `layout` chips
    being relayouted can deadlock an exit animation and leave an invisible
    click-swallowing backdrop.

- **The on-disk models** (`src/blocktree.js`, `src/automaton.js`) are the deepest
  teaching layer: what a segment's term dictionary really is (an FST in `.tip`
  over prefix-compressed blocks in `.tim`) and how a wildcard resolves against it
  (a DFA intersected with the FST). `automaton.js` has **no stage of its own** —
  it feeds the `dictionary` stage, which serves a plain term and a wildcard with
  one picture. Posting-list encoding had a model and a zoom; both were removed and
  `SPEC.md` records why — don't rebuild them. They are
  pure and produce **replayable traces**, exactly like `dictionaryTrace` in
  `src/wildcard.js` — the stage folds a trace into a view rather than animating
  imperatively. The `dictionary` stage is a **persistent stage** in the
  `coordMerge` style: the FST (in memory) and the blocks it indexes (on disk) are
  rendered on every step and the step only changes what is highlighted. Do not
  reintroduce per-step content swapping there — `SPEC.md` explains why. `SPEC.md` has the accuracy guardrails; the short version is that
  block sizes are toy-scaled (2–4 vs 25–48, 2 vs 128) with a visible badge saying
  so, every rendered number must come from a trace, and `automaton.js`'s matched
  set is kept in agreement with `expandTerms` so the zoom levels can't drift.

- **Components** (`src/components/`) are presentational, driven by the derived
  cluster + `opExtra`: `ClusterStage` (nodes/shards/segments),
  `IndexOverlay` (the index-a-document choreography), `SearchFlight` /
  `SearchResultsPanel` (scatter-gather), `InvertedIndexTable`, `Stepper`.
  Framer Motion drives the stage animations.

- **Analysis** (`src/analyzer.js`): a small stand-in for the standard analyzer —
  lowercase + split on non-(letter/number/apostrophe). No stemming/stopwords,
  keeping "your words → terms" obvious.

- **Relevance** (`src/relevance.js`) is real BM25 with Lucene's constants
  (k1=1.2, b=0.75). The interesting part is WHOSE statistics it is given:
  `shardStats`/`mergeStats` (`src/invertedIndex.js`) produce either one shard's
  own `docCount`/`docFreq` (plain `query_then_fetch`) or the summed totals
  (`dfs_query_then_fetch`), and `computeSearch` picks between them. **Anything
  that scores must take its stats from `statsForShard(search, shardId)`** — the
  shard close-up and the results panel showing different numbers for the same
  document is the failure mode this prevents, and `npm run check` asserts they
  agree. `perTerm` carries every input the formula used (tf, docFreq, idf, norm,
  contribution) so the scoring close-up can render the arithmetic rather than
  assert it. Scores are floats: render them through `fmtScore`.

- The per-shard inverted index (`shardInvertedIndex` in `src/invertedIndex.js`)
  is built only from `searchable` segments and skips `purged` docs — buffered
  docs and applied deletes never appear in search, matching the SPEC guardrails.
