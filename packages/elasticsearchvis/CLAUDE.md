# CLAUDE.md — elasticsearchvis

> **Read the root `/CLAUDE.md` and `/docs/ARCHITECTURE.md` first.** They cover
> the monorepo layout and the `(cluster, op)` engine this app shares with its
> three siblings. This file covers only what is specific to elasticsearchvis.
>
> `packages/elasticsearchvis`, npm workspace `@bitvis/elasticsearchvis`. Deploy
> with `../../scripts/deploy.sh ElasticsearchvisStack`.

## Find your task here first

This file is long because this app is the deepest one. **Read the section your
task touches, not the whole file.** The Architecture bullets below are in this
order:

| Working on… | Read the bullet(s) |
|---|---|
| Cluster/shard/segment state, routing | `cluster` |
| `object` vs `nested`, `_source`, doc blocks | **A Lucene doc is NOT an Elasticsearch doc**, Sub-objects and their mapping |
| Adding/changing an operation, step lists | `op`, Derivation, `useOpLifecycle` |
| Guided tours | Scenarios |
| Query parsing, `field:value`, `AND` | Fielded + conjunctive queries |
| Wildcards, fuzzy, `~`, routing keys | Patterns (wildcard + fuzzy) and routing |
| Any zoom panel | Close-ups, then the specific zoom's bullet |
| The 4-tile segment view (.tip/.tim/.doc/.fdt) | The segment close-up, `anatomy.jsx` |
| The FST, term dictionary, automaton walk | **The on-disk models** (longest bullet — the seek/consider rule lives here) |
| Sample data, datasets | `SAMPLE_DOCS` |
| Analyzer, tokenization, scoring | Analysis, the per-shard inverted index |
| Colours, dark/light | Theming |
| Animation timing | `src/timing.js` |

**Before removing or rebuilding something that looks missing**, check `SPEC.md`
— it records several features that were deliberately deleted (posting-list
encoding, the parent-bitset diagram, the two-automaton contrast table) and why.
Rebuilding them has already been a wasted cycle.

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

Built on the shared `(cluster, op)` engine — see `/docs/ARCHITECTURE.md` for how
derivation, the ops registry, `useOpLifecycle` and `timing.js` work in general.
Below is what differs here. Note two app-specific API facts: `stepsFor(type)`
takes a **type** (cassandravis's takes an op), and this is the only app whose
close-ups **nest**.

- **`cluster`** (`src/cluster.js`) is the committed state: `{ shards, docs }`.
  Each shard has `buffer`, `translog`, and immutable `segments`
  (`{ id, docIds, searchable, committed }`). Topology is fixed (3 shards, 1
  replica each across 3 nodes; coordinator = node-1) via `SHARD_PLACEMENT`.
  `routeShard(docId)` is the deterministic murmur3 stand-in.

- **A Lucene doc is NOT an Elasticsearch doc.** `seg.docIds` is the segment's
  Lucene documents **in ordinal order** — the ordinal IS the array index, which
  is why a merge renumbers them for free. One Elasticsearch document occupies a
  contiguous **block** of that array with its root **LAST**, and
  `src/mapping.js`'s `buildBlock` is the only thing that makes one. `object`
  mapping flattens sub-objects into the parent as multi-valued fields (one Lucene
  doc, pairing lost — that false positive is the lesson); `nested` writes each
  sub-object as its own Lucene doc. The join up from a matched child is
  `docRootId`, and it is SHOWN on the stored `_source` rows in the shard
  close-up. A `parentBitset` / `nextSetBit` pair and an ordinal-ruler diagram of
  them were removed — `SPEC.md` records why, and there is a note in
  `src/cluster.js`; don't rebuild them.
  **Three rules that will silently break the model if ignored:**
  (1) never sort or regroup `seg.docIds` — `refresh` copies the buffer in order
  and `merge` concatenates in order, and block contiguity depends on both;
  (2) a block is ATOMIC — `toggleDelete` flips every doc sharing a root, and
  anything that deletes or rewrites part of a block is wrong;
  (3) **a doc with no nested field is a block of exactly one Lucene doc whose id
  is its `_id`**, so every flat dataset degenerates to the pre-nested model
  exactly. That degeneration is the correctness constraint of the whole feature:
  `npm run check` must pass **byte-identically** for sections 1-6 after any
  change here. `SAMPLE_DOCS` is off-limits — it is tuned for three other
  scenarios; the nested lesson has its own `CATALOG_DOCS`.
  Field sets come from the document (`Object.keys(doc.tokens)`), never a
  hardcoded `['title','body']`; display goes through `label` / `detail`, which a
  flat `{title, body}` doc derives as exactly title and body.
  A doc's multi-valued fields (`valueBags` in `segmentAnatomy`) are drawn as
  aligned per-field lists in the shard close-up — that is the only place `object`
  flattening is visible, so don't drop it. The block root ALSO carries `source`,
  the original JSON verbatim: `buildBlock` stashes it and `SearchResultsOverlay`
  renders it as `_source` — identical under `object` and `nested` (sub-objects
  paired either way), because that is exactly what Elasticsearch returns and why
  an `object` false positive is easy to miss. `fields` (the flattened indexed
  form) is what the shard close-up shows; `source` is what the response shows.
  Don't reconstruct sub-objects from child docs — read `source` (see `SPEC.md`).

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

- **Sub-objects and their mapping are chosen in the index form**, not by loading
  a dataset: `IndexOverlay`'s collapsed Advanced section edits `variants` (in
  App state) plus a `nested` flag, and shows a live "writes N Lucene docs" line
  built from the SAME `buildBlock` call `startIndex` makes — keep those two on
  one builder or the preview will drift from the write. A scenario prefills it
  through the `setIndexDoc` action and still asks the reader to press Index,
  which is what keeps the one-click-per-step rule.

- **Fielded + conjunctive queries** are the third first-class query feature.
  `parseQuery` accepts `field:value` and an UPPERCASE `AND` and nothing else; a
  clause carries `.field`, every clause of a conjunctive query carries
  `.conjunction` (put on each clause rather than the array so it survives the
  `.map`/`.filter` the patterns go through). `scoreDoc` returns 0 unless every
  clause matched **the same Lucene doc** — that one rule is the entire
  object-vs-nested lesson, and it is deliberately ONE code path for both
  mappings: the only difference is whether a Lucene doc is a whole document or a
  single sub-object. `joinToRoots` then folds Lucene hits up to the documents
  that own them, which is the identity function on flat data. Uppercase-only
  `AND` is what keeps a document containing "and" from parsing as an operator.

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
  capability flags. There is deliberately **no `hasSearchable`**: a search
  against an empty or entirely un-refreshed index is a lesson, not an error
  state (`SPEC.md` says so), and zero hits is the payoff. Note what removing it
  exposed — every other `can*` flag inherits the "no op in flight" guard from a
  `has*` flag, because `base` is null unless `canStartNew`; `canSearch` names
  `canStartNew` itself instead, and must keep doing so or `start()` commits a
  null cluster. **`App.jsx`** keeps UI state (overlay phase, zoom,
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
  (`shardCloseUp` / `coordCloseUp` / `fetchShards` / `closeUpStillValid` /
  `closeUpAnchor` / `buildCloseUp`). Four kinds: `shard` (local search, search
  step 2), `coordinator` (steps 3–4), `fetch` (a shard holding a winner, step
  4 — `stages/shardFetch.jsx`, which turns each id back into a segment +
  ordinal), and `segment` (inside one segment, nested under `shard` or
  `fetch`, with `phase: 'query' | 'fetch'`). **Adding a zoom = one module plus
  one case in the registry.** A `steps` entry is `{ key, title, blurb }` plus an
  optional `link: { label, url }`, rendered under the blurb by the shared
  `components/DocLinks.jsx` (the same component App's "What's happening" panel
  uses for `opDocs`). It is for a step that has to admit a simplification and
  owes the real story a pointer — `search.js`'s `topk` step and WAND are the
  case it exists for; don't scatter it. Three things to respect:
  - App holds ONE `closeUps` array (the stack, innermost last), not a flag per
    zoom. Only the top is `active`: the shell runs a clock only for it, and stages
    read `active` to park their own timers (that is how the shard stage's probe
    replay freezes behind a child). `closeUpStillValid` is checked against the
    stack ROOT only — a nested zoom lives and dies with its parent. `zoomShard`
    (a `shard` OR `fetch` root) and `coordZoom` survive in the walkthrough
    snapshot as projections of the root, alongside `closeUpKind` /
    `closeUpDepth`.
  - A `Stage` must be a **module-scope** component and receive its data through
    `stageProps`. Defining it inside `build()` gives it a new identity on every
    re-derive, which remounts it and destroys flight/probe state mid-animation.
  - A `Stage` returns a **fragment**, so its pinned strips (`.si-querybox`) and
    its scroller (`.si-scroll`) are direct flex children of `.shard-inspector` —
    the stylesheet's `> .si-*` rules depend on it. Don't wrap it in a div. Also
    note the shell deliberately has no `AnimatePresence` exit: `layout` chips
    being relayouted can deadlock an exit animation and leave an invisible
    click-swallowing backdrop.

- **The segment close-up** (`src/closeups/stages/segment.jsx`, `kind:
  'segment'`) is the deepest zoom: FOUR TILES — `.tip` term index, `.tim` term
  blocks, `.doc` postings, `.fdt` stored fields — on a 2×2 grid, and a tour that
  dives into them in the order a query reads them (overview · walk · read ·
  found · postings · done; in the fetch phase overview · locate · read · done,
  with the three query-phase tiles dimmed). The dive is a CAMERA inside the one
  panel, not a nested close-up: the grid animates with the same tween App's
  `.layout` uses (scale 1.7, fade, transform-origin at the tile's quadrant) and
  the tile's panel springs in with the same spring `CloseUp` uses, so it reads
  as the same zoom the shard card gets. Rules that will break it if ignored:
  - Every tile is mounted for every step (at grid scale: glyph, name, status
    line off the models — `tileStatus`). A step only moves the camera and
    changes what is lit. Tile bodies gate their replays AND their scroll
    effects on `live` (= active, camera on this tile, spring landed —
    `shared.jsx`'s `scrollTileTo` defers a frame on top of that); a replay or
    a measurement made while the panel is still scaling in is wrong.
  - `cameraBeats(to, from)` is the ONE place the zoom-out / grid-hold / dive
    timings live; `dwell()` adds it to each step's replay so the clock and the
    camera agree. A backward step or a manual scrub (`sub != null`) moves the
    camera straight to the target — the grid beat is for watching.
  - The camera aims by GEOMETRY (`QUADRANT`), never by measuring the grid,
    which may be mid-tween when the target is decided.
  - `stages/dictionary.jsx` is no longer a stage: `deriveDictionary` runs the
    models once per build and `FstTile` / `BlocksTile` are the first two tile
    bodies (module-scope, fed by props). `src/postings.js` and
    `src/storedFields.js` are the pure models behind the other two, and `npm
    run check` section 8 pins them to the levels above (ordinal = index in
    `seg.docIds`, frequency = `scoreDoc`'s count, root last, `_source` on roots
    only, every fetch winner resolves to one segment).
  - The stored-fields tile is NEVER dived into by the query-phase tour — the
    fetch-step 🔍 on a shard opens it (`stages/shardFetch.jsx` → `segment` with
    `phase: 'fetch'`). `shardLocal.jsx`'s `sourceHL` is `false` for the same
    reason. Doc values are out of scope: four tiles, not five.

- **`src/closeups/anatomy.jsx`** is the segment card BOTH shard close-ups draw —
  the inverted index (term dictionary | postings) and the stored `_source` rows.
  Keep it shared: the query phase lights the dictionary then the postings and
  never the `_source`; the fetch phase lights only the `_source` and flags the
  rows it was sent for, leaving everything above visibly untouched. That
  contrast is the two-phase lesson and it needs one picture, so a phase gets its
  own behaviour through `focus` (per-step lighting, plus `fetchIds`), `magnify`
  (the 🔍 and which phase it opens — `data-anat-dict` vs `data-anat-fetch`) and
  `note`, never through a second card.
  - The fuzzy and wildcard scenarios pin panel step indices (`PANEL_WALK = 1`,
    `PANEL_FOUND = 3`) and target `[data-tour="fst"]` / `"automaton"`, which
    only exist while the camera is on the term-index tile — so the fuzzy tour
    has a `dive` step that makes the reader press into it first.

- **The on-disk models** (`src/blocktree.js`, `src/automaton.js`) are the deepest
  teaching layer: what a segment's term dictionary really is (an FST in `.tip`
  over prefix-compressed blocks in `.tim`) and how a pattern resolves against it
  (a DFA intersected with the FST). `automaton.js` builds **two NFAs** — a glob
  for `*`/`?`, a Levenshtein `(i, e)` grid for `~` — and that choice is the ONLY
  thing a pattern's kind decides; determinization, the walk, pruning and floor
  selection are shared, because to Lucene both are just an `AutomatonQuery`.
  `automaton.js` has **no stage of its own** — it feeds the term-index and
  term-blocks tiles of the segment close-up (`dictionary.jsx`), which serve a
  plain term, a wildcard and a fuzzy with one picture. For a fuzzy
  that picture gains a second panel: `buildLevenshteinNfa` also returns a `grid`
  drawing model (nodes carrying their own `(i, e)`, edges tagged by which edit
  they are), and `shared.jsx`'s `AutomatonGrid` renders it, lighting the state
  SET out of `dfa.states[...].nfaSet`. The view must never reverse-engineer a
  coordinate from a state id — `npm run check` asserts the two agree. The
  geometry is ONE stack in every mode: the split holds what is in memory (only
  fuzzy has a second thing to put beside the FST) and the `.tim` block column is
  the next tile; that is a property of the QUERY, not of the
  step, so the no-content-swapping rule still holds. A fuzzy's `found` step
  dives BACK into the term-index tile, because the spell-out lives in the
  automaton grid. The FST
  panel is **capped and pans to the cursor** (`.cu-fst` + the scroll effect in
  `ArcGraph`): the .tip FST is bushy rather than deep, so its height grows with
  the dictionary and would otherwise set the panel's size. The strip therefore
  starts below the fold, so the stage scrolls each step's subject into view on a
  step change (same rule, same instant behaviour). The arc replay is the
  SAME for every query, and the ONE rule it obeys is about what the query can
  accept at a node, never about the query's kind: **exactly one live label and
  the walk SEEKS** (Lucene's node carries its own arc index — a presence bitset,
  or a sorted array it bisects — so `findTargetArc` jumps to that label and
  never compares the siblings), **many or ANY and the arcs are considered** one
  at a time. Green is an arc taken (sought or followed), red is an arc no
  live transition accepts, and the subtree behind a prune OR behind a seek's
  untouched siblings is dimmed — that dimming is where the cost lesson lives now. The
  consequence is that red appears only in fuzzy mode on this data, which is the
  accurate answer; `SPEC.md` carries the Lucene citations
  (`FST.findTargetArc`'s four arc encodings, `FSTCompiler`'s thresholds, the
  root-arc cache deleted in 8.4) and the reason the old every-sibling-reddens
  version was wrong. Red is a VERDICT, never a claim the arc was inspected —
  `IntersectTermsEnum` leapfrogs transition ranges and never runs the automaton
  on a label it rejects, which is why the strip reads `no live transition —
  PRUNE` and not `refused on sight`. Don't reintroduce inspection language. A seek that finds no arc emits NO visit and just ends the
  walk — same reason the dead-end stub is gone. Only the automaton panel is
  fuzzy-specific. Don't reintroduce a per-kind variant of the walk; `SPEC.md`
  records why the glob-only version was wrong too.
  **A plain term runs that same intersection** (it is the degenerate
  pattern), but it keeps `seekTrace` for its COST numbers, and that split is
  load-bearing: `intersectTrace` loads a block at every output-carrying state on
  the way down — three for `search` — where `seekExact` carries the last output
  and reads exactly ONE, which is the number the whole zoom exists to teach.
  Never let `hits.blocksLoaded` / `hits.termsRead` reach term-mode copy;
  `npm run check` asserts the two walks agree while deliberately NOT asserting
  equal block counts. Term mode also used to draw a dashed red ✗ stub for the
  arc it ran out of; that fires on SUCCESSFUL lookups (arcs are block prefixes,
  so the arrows always run out first) and put two opposite meanings on red, so
  it is gone — the fact lives in the copy and the walk readout.
  Note also that `CloseUp` takes `held`, which freezes its clock while a
  read-this tour step is up — and that `held` must be in the clock effect's deps
  or the already-scheduled dwell still fires once. `CloseUp` also owns `sub`,
  the manual scrub position inside a step's replay: a ctx may declare
  `units(step)` (like `dwell`, a fresh closure per re-derive — never put it in a
  dep array) and Prev/Next then walk one arc decision / row / character at a
  time before rolling to the neighbouring step. Manual mode MUST be expressed as
  `sub` non-null (which turns each `useReveal`'s `on` false, parking it at the
  end) and never by clearing `active`, which stages read to park their own
  timers. That scrubbing is what the fuzzy scenario is built around: it reports
  its position up as `closeUpSub`, and a scenario step may set `holdPanel` to
  freeze the panel's clock while it waits for the reader to walk the replay with
  Next (pair it with `targetExtra: '[data-tour="cu-stepper"]'`, or the dim layer
  swallows the very clicks being asked for — and never set it on a step asking
  for ▶ Play, which `held` makes inert). Those steps also set `noDim` (the dim
  rects go transparent and click-through, so nothing on screen is hidden or
  disabled while the reader watches two panels move together) and `panelNext`
  (a step button in the tip itself, so they never look away to find the
  mini-stepper). A `noDim` step blocks nothing, so its `advanceOn` must survive
  the reader closing the panel or the tour strands; and its tip belongs BESIDE
  the close-up, since `placement: 'left'` off the automaton lands squarely on
  the FST panel. The guided walk also NARRATES each decision (`ctx.narrate` +
  a step's `liveNarration`), folded out of `explainDecision` in `automaton.js`:
  which readings were waiting for the character, which paid an edit, or — for a
  prune — that every live reading is out of edits. Two facts that narration
  depends on, both checked against Lucene's own source: an arc can only die once
  every live reading has spent its budget (a reading with budget always buys the
  character as an insertion — `npm run check` asserts it), and the walk is
  depth-first so it BACKTRACKS, which the narration must call out or the live
  set appears to lose progress. Two things about the fuzzy
  grid that are easy to get wrong and are now asserted by `npm run check`: the
  from-set of a step is the visit's own `dfaFrom` (the walk BACKTRACKS, so the
  previous visit's `dfaTo` is the wrong state and almost nothing lights up), and
  the arc walk only consumes block prefixes so it can never reach an accepting
  state — `termPath` finishes the word on step 4, which is the only view that
  reaches the grid's right-hand column. That is why the fuzzy scenario has a
  step pointing at it (`the-payoff`, gated on the `closeUpStep` snapshot field)
  and why the panel's "click ✕ to exit" hint is suppressed while any read-this
  tip is up: the payoff lands on the panel's LAST step, which is exactly where
  the hint used to invite the reader to leave. The read step in between shows
  the union of states that earned the block reads (`levBlockView`), not the
  walk's leftover cursor — that lit a meaningless near-start set for a full
  three seconds. `npm run check` now asserts both halves: no `follow` visit
  reaches an accepting state, and at least one finishing path does.
  `ArcGraph`'s `matches` prop marks the
  states whose block held a matching term (halo + the word beside the bubble, from
  the read step on) — that is the only thing allowed to put a word near a node,
  and `SPEC.md` explains why it hangs outside the bubble rather than in it.

- **`SAMPLE_DOCS` is load-bearing for three scenarios at once**, and its job is
  partly to be *vocabulary* rather than prose. A fuzzy query can only prune when
  block prefixes discriminate, which needs ~90+ distinct terms per shard; the
  original fourteen docs pruned nothing and that is why `prefix_length` briefly
  existed as a UI control. Docs 15+ exist for that reason and carry two rules in
  a comment there (never the bare term `search`; nothing else may end in
  `search`). `npm run check` guards the pruning, the shard-0 4/3/2/1 top-k
  spread, `*search`'s two matches and `sc*`'s range — read those before editing
  the dataset.

  Posting-list ENCODING had a model and a zoom; both were removed and `SPEC.md`
  records why — don't rebuild them. The postings tile (`src/postings.js`) is
  the CONCEPT — ordinals and frequencies — and must stay that. These models are
  pure and produce **replayable traces**, exactly like `dictionaryTrace` in
  `src/wildcard.js` — the stage folds a trace into a view rather than animating
  imperatively. The segment close-up is a **persistent stage** in the
  `coordMerge` style: every tile is rendered on every step and the step only
  changes the camera and what is highlighted. Do not reintroduce per-step
  content swapping there — `SPEC.md` explains why.

  `SPEC.md` has the accuracy guardrails; the short version is that
  block sizes are toy-scaled (2–4 vs Lucene's 25–48), documented in `SPEC.md`
  rather than badged in the zoom. The term-blocks tile ends at the `.tim` strip
  and its totals: the per-step cost lines, the toy-size badge, the term-entry /
  expansion block and the two-automaton contrast table that used to sit below it
  were all removed as clutter (the expansion list still shows in the shard zoom
  and results panel); what follows the strip now is the next TILE, not more copy.
  Every rendered number must come from a trace, and `automaton.js`'s matched set
  is kept in agreement with `expandTerms` so the zoom levels can't drift.

- **Components** (`src/components/`) are presentational, driven by the derived
  cluster + `opExtra`: `ClusterStage` (nodes/shards/segments),
  `IndexOverlay` (the index-a-document choreography), `SearchFlight` /
  `SearchResultsPanel` (scatter-gather), `InvertedIndexTable`, `Stepper`.
  Framer Motion drives the stage animations.

- **Analysis** (`src/analyzer.js`): a small stand-in for the standard analyzer —
  lowercase + split on non-(letter/number/apostrophe). No stemming/stopwords,
  keeping "your words → terms" obvious. Search relevance is term-frequency
  counting (`computeSearch`), a deliberate stand-in for BM25.
  **Analysis runs once per shard COPY, and the index op must show that.**
  Elasticsearch replicates the operation, not the index: the primary indexes
  locally, forwards the DOCUMENT to each in-sync replica, and the replica runs
  the same indexing operation — analysis included — itself. So the replicate step
  in `IndexOverlay` flies the doc card on to the replica and replays step 2's
  whole scan → tokens → emit sequence against `[data-replica-target]`; it used to
  fly the primary's tokens across, which taught the opposite. Two consequences
  worth knowing before touching that file: the fly card is now kept MOUNTED and
  merely faded through step 3 (unmounting it would make it restart from the
  editing form, and `beginReplicaEmit` needs its rect), which is why it carries
  `pointer-events: none` — it hovers invisibly over a clickable shard card; and
  the step's budget in `indexOp.js` is `INDEX_REPLICA_HOP_MS +
  INDEX_ANALYSIS_LEAD_MS + flightMs(n) + FLIGHT_PAD_MS`, i.e. step 2's budget
  again plus the hop. `SPEC.md` carries the guardrail and the Elastic citation.

- The per-shard inverted index (`shardInvertedIndex` in `src/invertedIndex.js`)
  is built only from `searchable` segments and skips `purged` docs — buffered
  docs and applied deletes never appear in search, matching the SPEC guardrails.
  **A tombstone is drawn at FULL strength and only fades once a refresh purges
  it** (`.doc-chip.deleted` / `.doc-chip.purged`): the fade is the one signal
  that a doc has left the searchable view, so spending it on a still-searchable
  tombstone makes refresh a no-op on screen. `ClusterStage`'s `DocChip` must
  keep passing `purged` — it didn't, and the main stage showed nothing at all
  when a refresh applied a delete. `refresh.js`'s `note()` says it in words on
  the same beat, and returns null when there is nothing to apply.

- **`MobileWarning` and `HomeLink`** (`src/components/`, styled in `index.css`)
  are the two components that are **byte-identical in all four apps** — change
  one, change four. Rationale in `/docs/ARCHITECTURE.md`.

- **Theming** — dark (default) and light, chosen by `ThemeToggle` (top-right of
  the header) and remembered in `localStorage` as `esvis-theme`; `index.html`
  applies the saved value to `<html data-theme>` before first paint so there is
  no flash. It is entirely CSS custom properties: **two `:root` blocks** in
  `index.css` (`:root` dark, `:root[data-theme='light']` light) define one set of
  semantic tokens. The rules that matter when editing colour:
  - The brand accents (`--accent` teal, `--accent-2` blue, `--good`, `--warn`,
    `--danger`) keep their meaning in both themes, but teal `#00bfb3` is
    illegible as text/hairlines on white, so **`--accent-text`** is the token for
    teal-as-text / thin border / thin stroke (it just equals `--accent` in dark).
    `--good`/`--warn`/`--danger`/`--accent-2`/`--accent-soft` are darkened
    outright in the light block since none is used as a large fill.
  - Translucent `rgba()` **tints of the brand colours are left as literals** —
    they read on either ground. The **structural darks go through tokens**:
    `--scrim` (modal backdrops), `--sink` (inset fills), `--tip-glass`
    (translucent tour tips), and `--shadow-rgb` (the rgb triple inside every
    `rgba(var(--shadow-rgb), …)` drop shadow). Add a new dark `rgba()` only as
    one of these, never as a literal, or it will stay dark in light mode.
  - `CookieBanner` is inline-styled: it uses `var(--…)` tokens, not hex.
