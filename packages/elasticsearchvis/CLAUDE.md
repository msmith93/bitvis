# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

> This app is `packages/elasticsearchvis` in the **bitvis** monorepo (npm workspaces).
> Run `npm install` once at the repo root. Deploy infra lives at the repo root
> (`infra/`, `scripts/`); deploy this site with `../../scripts/deploy.sh ElasticsearchvisStack`.

## Commands

- `npm run dev` — start the Vite dev server (the primary way to run/verify the app).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` locally.
- `npm run check` — assertions over the pure models (`scripts/check-models.mjs`).

There is no test runner, linter, or formatter configured, and there should not
be: the deliverable is a screen-recordable proof-of-concept (see `SPEC.md`), so
"verify" means running `npm run dev` and stepping through Index → Refresh →
Flush → Merge → Search. `npm run check` is the narrow exception — it covers only
the arithmetic a browser will animate confidently and wrongly (edit distance,
`Fuzziness.AUTO`, and the invariants that keep the zoom levels from drifting).
Keep it to arithmetic.

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
  declaring `{ type, label, steps, derive?, extra?, duration? }`; each step has
  the explanation text shown in the right panel and driven by the bottom
  `Stepper`. Adding an op type = one new module + a registry entry in
  `src/ops/index.js`.

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
  `highlightPlay: true` and target `[data-tour="stepper-play"]`. Two traps that
  have already cost bugs: **a step may only ask for ONE click** — the dim layer
  swallows everything outside the spotlight hole, so "do X then Y" leaves Y
  unclickable unless both sit inside the same target (or `targetExtra` names the
  second) — and a step asking for a Search needs a ▶ Play beat in front of it
  whenever an op is paused mid-walk, because `canStartNew` in `useOpLifecycle`
  keeps the Search button disabled until the current op reaches its last step. The intro tour
  deliberately ends on the topbar Scenarios button (`[data-tour="scenarios"]`)
  so the menu gets discovered: that step advances on `scenariosOpen` — the real
  click that opens the menu, reported up from `ScenarioPicker` — and never asks
  the user to pick a particular scenario.

- **Patterns (wildcard + fuzzy) and routing** are first-class query features, not
  scenario-only props. `src/wildcard.js` is the pure model: `parseQuery` keeps
  `*`/`?`/`~` tokens whole (the analyzer would eat them), and `dictionaryTrace`
  produces the replayable probe list — a binary-search seek when the pattern has
  a literal prefix, a full enumeration when it doesn't. **`seekPrefix` is the one
  field that decides cost, for every kind**, which is why adding fuzzy needed no
  change to the traces at all: a fuzzy's `prefix_length` maps straight onto it,
  and `prefix_length: 0` lands in the same full-enumeration branch a leading
  wildcard does. `matchTerm` is the single semantic authority on what matches —
  `src/automaton.js` delegates its per-term verdict to it, which is what keeps
  the two zoom levels from disagreeing. `ShardInspector` replays that
  trace per segment on the dictionary step (and `localSearchSteps` gives a
  pattern query its own step list, which is why the inspector addresses steps
  by `key` rather than index). Routing is
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
  over prefix-compressed blocks in `.tim`) and how a pattern resolves against it
  (a DFA intersected with the FST). `automaton.js` builds **two NFAs** — a glob
  for `*`/`?`, a Levenshtein `(i, e)` grid for `~` — and that choice is the ONLY
  thing a pattern's kind decides; determinization, the walk, pruning and floor
  selection are shared, because to Lucene both are just an `AutomatonQuery`.
  `automaton.js` has **no stage of its own** — it feeds the `dictionary` stage,
  which serves a plain term, a wildcard and a fuzzy with one picture. For a fuzzy
  that picture gains a second panel: `buildLevenshteinNfa` also returns a `grid`
  drawing model (nodes carrying their own `(i, e)`, edges tagged by which edit
  they are), and `shared.jsx`'s `AutomatonGrid` renders it, lighting the state
  SET out of `dfa.states[...].nfaSet`. The view must never reverse-engineer a
  coordinate from a state id — `npm run check` asserts the two agree. In fuzzy
  mode the `.tim` block column leaves the split and becomes a full-width strip so
  the two in-memory structures can sit side by side; that is a property of the
  QUERY, not of the step, so the no-content-swapping rule still holds. The FST
  panel is **capped and pans to the cursor** (`.cu-fst` + the scroll effect in
  `ArcGraph`): the .tip FST is bushy rather than deep, so its height grows with
  the dictionary and would otherwise set the panel's size. The arc replay is the
  SAME for every query — green followed, red rejected, subtree dimmed, cursor
  panning — and only the automaton panel is fuzzy-specific. Don't reintroduce a
  per-kind variant of the walk; `SPEC.md` records why the glob-only version was
  wrong. Note also that `CloseUp` takes `held`, which freezes its clock while a
  read-this tour step is up — and that `held` must be in the clock effect's deps
  or the already-scheduled dwell still fires once. Two things about the fuzzy
  grid that are easy to get wrong and are now asserted by `npm run check`: the
  from-set of a step is the visit's own `dfaFrom` (the walk BACKTRACKS, so the
  previous visit's `dfaTo` is the wrong state and almost nothing lights up), and
  the arc walk only consumes block prefixes so it can never reach an accepting
  state — `termPath` finishes the word on step 4, which is the only view that
  reaches the grid's right-hand column.

- **`SAMPLE_DOCS` is load-bearing for three scenarios at once**, and its job is
  partly to be *vocabulary* rather than prose. A fuzzy query can only prune when
  block prefixes discriminate, which needs ~90+ distinct terms per shard; the
  original fourteen docs pruned nothing and that is why `prefix_length` briefly
  existed as a UI control. Docs 15+ exist for that reason and carry two rules in
  a comment there (never the bare term `search`; nothing else may end in
  `search`). `npm run check` guards the pruning, the shard-0 4/3/2/1 top-k
  spread, `*search`'s two matches and `sc*`'s range — read those before editing
  the dataset.

  Posting-list encoding had a model and a zoom; both were removed and `SPEC.md`
  records why — don't rebuild them. These models are
  pure and produce **replayable traces**, exactly like `dictionaryTrace` in
  `src/wildcard.js` — the stage folds a trace into a view rather than animating
  imperatively. The `dictionary` stage is a **persistent stage** in the
  `coordMerge` style: the FST (in memory) and the blocks it indexes (on disk) are
  rendered on every step and the step only changes what is highlighted. Do not
  reintroduce per-step content swapping there — `SPEC.md` explains why.

  `SPEC.md` has the accuracy guardrails; the short version is that
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
  keeping "your words → terms" obvious. Search relevance is term-frequency
  counting (`computeSearch`), a deliberate stand-in for BM25.

- The per-shard inverted index (`shardInvertedIndex` in `src/invertedIndex.js`)
  is built only from `searchable` segments and skips `purged` docs — buffered
  docs and applied deletes never appear in search, matching the SPEC guardrails.

- **`MobileWarning`** (`src/components/MobileWarning.jsx`, styled in `index.css`)
  is a full-screen advisory shown on small touch screens: these visualizers are
  desktop simulations, so a phone gets told so before it fights the layout. It
  is advisory ("Continue anyway" dismisses it for the session, with no
  persistence) and it is deliberately gated on a coarse pointer AND a small
  viewport, so a narrow desktop window never trips it. Every visualizer app
  carries an identical copy of it — the landing page does not.

- **`HomeLink`** (`src/components/HomeLink.jsx`, styled in `index.css`) is the
  way back to the bitvis landing page (`https://bitvis.bitsculpt.top`). Each
  visualizer is its own subdomain, so without it a visitor who enjoys this one
  has no path to the others; it sits first in the topbar and carries the landing
  page's own 2×2 dot mark. Every visualizer app carries an identical copy.
