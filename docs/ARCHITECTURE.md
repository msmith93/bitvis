# The shared architecture

Every visualization app in this repo (`elasticsearchvis`, `cassandravis`,
`kubevis`, `vespavis`) is built on the same engine. It is described **once,
here**; per-app `CLAUDE.md` files cover only what their app does differently.

Read this before touching `ops/`, `cluster.js`, `useOpLifecycle.js`, or
anything that animates. Per-app divergences are tabulated in the root
`CLAUDE.md` — check there before assuming an API is identical across apps.

## The core idea

> **Visible state is a pure function of `(cluster, op)`.**

`cluster` is committed state. `op = { type, step, payload }` is the single
operation in flight. Nothing renders from imperative mutation; everything
renders from a derivation at the current `op.step`.

That purity buys the product's central interaction: **a stepper that scrubs
forwards *and backwards* through any operation.** It is also the invariant most
easily broken, usually by mutating `cluster` to show an in-progress effect. Do
not. Derive it.

## The data

### `src/cluster.js` — committed state

Holds the system's persistent shape (nodes, shards, keys, pods — app-specific)
plus the deterministic stand-ins for real algorithms: hashing/routing, placement,
local read paths. These are pure functions and are the app's *model*; the UI
animates exactly what they return, so if a component walks a structure, it must
walk the same function the model does rather than reimplement the walk.

Each exports a `cloneCluster`. **Its depth varies by app** (kubevis shallow,
cassandravis deep) — whichever it is, `derive` must *replace* objects (spread),
never mutate them in place.

### `op = { type, step, payload }`

Created by `App.jsx` when the user acts, held by `useOpLifecycle`.

**The payload precomputes everything non-deterministic at `start()` time** —
generated names, placements, chosen replicas, routing targets. This is what
makes `derive` pure and scrubbing deterministic. Never generate a name or pick a
target inside `derive`.

## Operations: `src/ops/`

One self-contained module per operation type, plus `index.js` as the registry.

```js
// src/ops/<name>.js
export default {
  type: 'refresh',
  label: 'Refresh',
  steps: [ { key, title, blurb, ms } , … ],  // the stepper's script
  derive(cluster, op) { … },                 // optional: partial effect of steps <= op.step
  extra(cluster, op) { … },                  // optional: transient per-step info
  duration(op, extra) { … },                 // optional: content-aware step budget
}
```

**Adding an operation = one new module + one line in `src/ops/index.js`.** (In
kubevis, also a parser case in `src/kubectl.js`.)

`steps` is the explanation script shown in the side panel and driven by the
bottom `Stepper`. Each step declares its own `ms` dwell; steps that launch a
content-dependent animation compute their budget in `duration()` instead, so a
flight is never clipped by the next step.

### The derivation functions (all dispatched from `src/ops/index.js`)

| Function | Returns | Notes |
|---|---|---|
| `deriveCluster(cluster, op)` | how the cluster should **look** at `op.step` | Always clones first, then applies the module's effect for steps `<= op.step`. The single source of the rendered cluster. |
| `opExtra(cluster, op)` | transient step info — highlights, in-flight items, computed results | Not persisted. Recomputed every render. |
| `applyOp(cluster, op)` | `deriveCluster` at the **last** step | Folds a finished op into committed state. A no-op for read-only ops with no `derive`. |
| `stepDuration(op, extra)` | ms to dwell | Module's `duration()` if it returns a value, else the step's static `ms`. |
| `opNote(op, extra)` | one optional line about the op's **payload** | Where present. The hook for anything query-specific, since `steps` are static per type. |

**The fold-before-next rule:** `start()` calls `applyOp` on the *previous*
finished op before beginning a new one. This is why a completed operation can
stay on screen without being double-applied, and it is easy to break when adding
any other path that writes committed state.

## `src/useOpLifecycle.js` — the state machine

Owns `cluster`/`op`/`opDone`/`playing`, the auto-play clock, and memoized
`derived`/`extra`. Stable API in every app:

```
{ cluster, op, opDone, playing, derived, extra, base, canStartNew,
  start, step, play, pause, resetTo }
```

plus app-specific `has*` capability flags (`hasBuffered`, `hasMemtable`,
`hasFlushable`, …) that gate toolbar buttons.

Two things to know:

- **`base`** is the folded cluster — what a command parser or form should
  validate against, since `cluster` may be mid-op. It is `null` unless
  `canStartNew`, which is why most `can*` flags inherit an implicit
  "no op in flight" guard from whichever `has*` flag they name.
- Writes to committed state from **outside** an operation are exceptional.
  kubevis is the only app that does it (ambient traffic crashing pods), and it
  funnels through a dedicated `commit(mutator)` so the fold-before-next rule
  still holds. Don't add a second path without the same care.

## `App.jsx`

Keeps **UI** state only — overlay/zoom state, form inputs, naming counters
(usually refs), scrollback — composes the `can*` button flags, and builds op
payloads. It does not own simulation state.

## `src/components/`

Presentational, driven by derived cluster + `opExtra`. Framer Motion drives
stage animation. Common members across apps: `ClusterStage` (the main picture),
`Stepper` (bottom scrubber), `CookieBanner`, `MobileWarning`, `HomeLink`.

`MobileWarning.jsx` and `HomeLink.jsx` are **byte-identical in all four apps** —
change one, change four. The others have diverged.

## `src/timing.js`

Every animation-scheduling constant lives here — flight durations, staggers,
pads, dwell times — so JS timeouts, Framer transitions and step budgets share
one named value. When an animation and its step budget disagree, the fix is
almost always a shared constant, not a tweaked magic number.

`src/constants.js` (where present) holds demo-size caps — replicas per
deployment, pods per node, top-k — shared by models and components.

## Optional layers

Not every app has these. Check before assuming.

### Close-ups — `src/closeups/` (elasticsearchvis, cassandravis)

Stepped zoom levels into one part of the picture. `CloseUp.jsx` is a generic
shell (backdrop, header, explain box, its own mini-stepper and clock); each zoom
is one module exporting `build(...)` returning
`{ key, title, steps, Stage, stageProps, … }`, dispatched by a `buildCloseUp`
switch in `index.js`. **Adding a zoom = one module + one registry case.** The
`build` argument shape is *not* shared: cassandravis passes positional args,
elasticsearchvis an options object. Both also export a `closeUpStillValid` used
to auto-close a zoom the current step has invalidated.

Rules that have already cost bugs:

- A `Stage` must be a **module-scope** component receiving data via
  `stageProps`. Defining it inside `build()` gives it a new identity on every
  re-derive, remounting it and destroying animation state mid-flight. (General
  React truth; both apps depend on it.)
- Replays must be gated on the panel having actually **landed**, not merely
  mounted — one that runs during the entrance animation is half over before it
  can be seen.
- **Nesting is elasticsearchvis-only.** It holds a *stack* of close-ups
  (innermost last); only the top is `active`, and stages read `active` to park
  their own timers. cassandravis holds a single `closeUp` object and cannot
  nest — don't port stack assumptions between them.

### Guided tours

Three different shapes, so check the app:

- **elasticsearchvis** — `src/scenarios/`, a registry of modules
  (`{ id, label, blurb, steps, setup? }`), the same shape as `ops/`. A step
  spotlights a **real control** and advances when the user actually uses it.
- **cassandravis, kubevis** — a flat `src/walkthroughSteps.js`.
- **vespavis** — none.

Where tours exist, the hard-won rule is **one click per step**: the dim layer
swallows everything outside the spotlight, so "do X then Y" leaves Y
unclickable.

### Pure-model checks — `scripts/check-models.mjs` (elasticsearchvis, vespavis)

Node-only, dependency-free, run by `npm run check`. It exists because a browser
will animate an arithmetic error confidently and wrongly. Scope is deliberately
narrow: arithmetic, and invariants that keep zoom levels from drifting apart.
**Keep it that way** — it is not a general test suite, and the apps' visual
behaviour is verified by running them.

The app's imports are extensionless (Vite resolves them), so each script
installs a small `node:module` loader hook to do the same. Copy that hook if you
add a third one.

## Adding a whole new visualization app

1. Copy the closest existing package; keep `cluster.js` / `ops/` /
   `useOpLifecycle.js` / `timing.js` / `components/` structure.
2. Name it `@bitvis/<name>`; add `dev:<name>` to the root `package.json`.
3. Copy `MobileWarning.jsx` and `HomeLink.jsx` **verbatim**.
4. Write `SPEC.md` first — goal, topology, operations to model, accuracy
   guardrails, flagged simplifications. It is the contract the app is judged on.
5. Add a `StaticSiteStack` in `infra/bin/app.ts` and a row in the root
   `README.md` + `packages/landing/sites.js`.
