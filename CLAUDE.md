# CLAUDE.md — bitvis monorepo

Guidance for Claude Code working anywhere in this repository. Start here, then
read only what the task actually needs (see **Read order** below).

## What this repo is

An npm-workspaces monorepo of **independent, client-side teaching
visualizations** for distributed systems, served at `*.bitsculpt.top`. Each app
is its own Vite + React SPA that *simulates* a system entirely in the browser —
no backend, no network, no localStorage (except one theme key), all state in
React. They share tooling, an architecture, and the deploy pipeline, but
**nothing at runtime**: each gets its own CloudFront distribution and bucket.

The product is a **screen-recordable explanation**, not a library. That framing
decides most arguments: correctness means "does this teach the real system
accurately", and verification means "run it and step through it".

## Read order (do this instead of exploring)

1. **This file** — repo map, shared architecture, per-app divergences, pitfalls.
2. **`docs/ARCHITECTURE.md`** — the `(cluster, op)` engine every app is built
   on, described once. Read it before touching `ops/`, `cluster.js`,
   `useOpLifecycle.js`, or any stepper/animation timing.
3. **`packages/<app>/CLAUDE.md`** — that app's specifics. The big ones open with
   a task→section index; read the matching section, not the whole file.
4. **`packages/<app>/SPEC.md`** — read **before changing any model or domain
   behaviour**. See the routing rule below.

**Do not spawn a subagent to "explore the architecture" or "find how X works".**
The architecture is documented in 1–3 above and is stable. Use targeted
`grep`/`Read` for the specific file a task touches. A subagent is justified only
for genuinely open-ended search across many unknown files.

### CLAUDE.md vs SPEC.md — which to read

| Question | Read |
|---|---|
| Where does this code live? How is it wired? What conventions apply? | `CLAUDE.md` (root + app) |
| Is this behaviour *faithful to the real system*? May I change/simplify it? | `SPEC.md` |
| Why was this built this way? Why was the obvious approach rejected? | app `CLAUDE.md`, then `SPEC.md` |

Every `SPEC.md` carries **"Operations to model (KEEP THESE ACCURATE)"**,
**"Accuracy guardrails"**, and **"Flagged simplifications"**. Those guardrails
are correctness requirements, not aspirations. Several also record *things that
were tried and removed* — check there before rebuilding something that looks
missing; it may have been deliberately deleted.

## Repo map

```
packages/
  elasticsearchvis/   Elasticsearch/Lucene: indexing, segments, search,       ~12.7k lines
                      the FST + automaton term dictionary, object vs nested.  (largest, most active)
  cassandravis/       Cassandra: ring, quorums, hinted handoff, LSM tree.     ~4.8k lines
  kubevis/            Kubernetes: kubectl → control plane → pods, traffic.    ~5.3k lines
  vespavis/           Vespa: two-tier serving, ranking phases, tensors.       ~4.5k lines
  landing/            Plain static card grid (index.html/sites.js/styles.css).
                      NO package.json, NO build step — deployed as-is.
  opensearchvis/      STALE. Empty leftover of the elasticsearchvis rebrand:
                      only dist/ + node_modules/, no source. Ignore it. It still
                      appears in `git log`; that history moved to elasticsearchvis.
infra/                AWS CDK (TypeScript). One StaticSiteStack per site.
scripts/deploy.sh     Build everything + `cdk deploy` (owner's machine only).
docs/ARCHITECTURE.md  The shared (cluster, op) engine.
```

## Commands

Install once at the repo root (`npm install`) — workspaces hoist everything.

| Task | Command |
|---|---|
| Dev server | `npm run dev:<app>` from root, or `npm run dev -w @bitvis/<app>` |
| Build one | `npm run build -w @bitvis/<app>` |
| Build all | `npm run build` (root; `--if-present` skips `landing`) |
| Model checks | `npm run check -w @bitvis/elasticsearchvis` · `-w @bitvis/vespavis` |
| E2E | `npm run test:e2e -w @bitvis/cassandravis` |
| Deploy | `./scripts/deploy.sh <StackName>` — needs the `bitsculpt` AWS profile |

Stacks: `KubevisStack`, `ElasticsearchvisStack`, `VespavisStack`,
`CassandravisStack`, `LandingStack`. No argument deploys all.

**There is no linter and no formatter, in any package, deliberately.** Don't add
one, and don't reformat files you aren't otherwise changing. Match the
surrounding style — these files carry unusually dense explanatory comments, and
that is the house style, not clutter.

### How to verify a change

There is no unit-test runner. In order of what actually catches things:

1. `npm run dev` and **step through the affected operation**, scrubbing
   Prev/Next across step boundaries. This is the primary verification and the
   docs mean it literally.
2. `npm run check` where it exists — pure-model assertions only (arithmetic and
   cross-level invariants a browser would animate confidently and wrongly).
   **Keep it to arithmetic and invariants**; it is not a general test suite.
3. `npm run test:e2e -w @bitvis/cassandravis` — Playwright smoke tests that a
   runtime error in any close-up fails the build (`npm run build` can't catch
   those). Starts its own Vite on port 5183.
4. `npm run build` — catches syntax/import errors and nothing else.

## The shared architecture, in brief

Full detail in **`docs/ARCHITECTURE.md`**. The ten-line version:

- `src/cluster.js` holds **committed state**; `op = { type, step, payload }`
  holds **the operation in flight**.
- Every visible thing is a **pure derivation of `(cluster, op)`** —
  `deriveCluster` for the cluster, `opExtra` for transient per-step info. That
  purity is what lets the stepper scrub **forwards and backwards**, and it is
  the invariant most easily broken.
- Each operation is **one self-contained module in `src/ops/`** declaring
  `{ type, label, steps, derive?, extra?, duration? }`, registered in
  `src/ops/index.js`. Adding an operation = one module + one registry line.
- `applyOp` folds a finished op into committed state; `start()` folds the
  previous op before beginning the next.
- `src/useOpLifecycle.js` owns the state machine and auto-play clock.
- `src/timing.js` holds **every** animation constant so JS timeouts, Framer
  transitions, and step budgets share one named value.
- `src/components/` is presentational, driven by derived state.
- `src/index.css` is a **single stylesheet per app** built on CSS custom
  properties. There is no CSS framework and no CSS-in-JS.

## Per-app divergences (the traps)

The apps look interchangeable and are not. Verify before assuming.

| | elasticsearchvis | cassandravis | kubevis | vespavis |
|---|---|---|---|---|
| Step list API | `stepsFor(type)` | `stepsFor(op)` | `stepsFor(type)` | **`stepsOf(op)`** |
| Steps vary by payload | no | **yes** | no | **yes** (`stepsFor(payload)` on the module) |
| `npm run check` | yes | — | — | yes |
| E2E tests | — | **yes** (Playwright) | — | — |
| Close-up zooms | `src/closeups/` (+ `stages/`) | `src/closeups/` | — | — |
| Guided tours | `src/scenarios/` registry | `walkthroughSteps.js` | `walkthroughSteps.js` | none |
| `cloneCluster` | — | **deep** (per-node storage) | **shallow** | — |
| Theme | dark + light toggle | dark only | dark only | light only (brand) |

Extra lifecycle members also differ: `commit(mutator)` exists **only** in
kubevis (for the ambient traffic layer); `toggleDelete` **only** in
elasticsearchvis.

The stable core of `useOpLifecycle` — present in all four — is
`{ cluster, op, opDone, playing, derived, extra, base, canStartNew, start, step,
play, pause, resetTo }` plus app-specific `has*` capability flags.

## Repo-wide conventions

- **`MobileWarning.jsx` and `HomeLink.jsx` are byte-identical across all four
  apps.** Changing one means changing four. (`CookieBanner.jsx`, `Stepper.jsx`
  and `analytics.js` have diverged — do not assume they match.)
- **Every rendered number must come from a model/trace**, never be written into
  copy. This is stated in several SPECs and is a hard rule.
- **Explanatory copy is part of the product.** Step blurbs, tour text and
  captions are the teaching surface; treat wording changes with the same care as
  logic, and keep copy in sync with what the animation actually shows.
- Flagged simplifications are **declared in the UI or SPEC**, not hidden.
- No backend, no persistence beyond the theme key, no runtime deps besides
  React, ReactDOM and Framer Motion.

## Pitfalls

- **Vite ports are not pinned.** Every app's `vite.config.js` is the bare
  default, so the first dev server takes 5173 and later ones auto-increment.
  `.claude/launch.json`'s port numbers are informational, not enforced — read
  the actual URL from the dev server output. Kill stray servers before starting
  one. (Playwright is the exception: it pins 5183 with `--strictPort`.)
- **Don't mutate `cluster` to show in-progress effects** — that breaks
  backward scrubbing. Derive it.
- **Don't add per-kind variants of a shared replay/animation.** Several SPECs
  record cases where that was tried and reverted; prefer one path whose
  behaviour is driven by data.
- `git log`/`git blame` on elasticsearchvis code often lands in
  `packages/opensearchvis` — same code, pre-rebrand.
- `packages/landing` has no `package.json`, so workspace commands skip it. Edit
  its files directly.

## Current state (changeable — verify before relying)

This section is project status, not architecture. Confirm with a quick grep
rather than trusting it if it matters.

- **Light theme rollout is partial.** Only elasticsearchvis has a `ThemeToggle`
  and a `:root[data-theme='light']` block. vespavis is light-only *by design*
  (it matches Vespa's brand), and kubevis and cassandravis are still dark-only.
  A theming task in those two is net-new work, not a port.
- elasticsearchvis is by far the most active package and has the deepest
  documentation; `vespavis/PLAN.md` is that app's live roadmap (move entries to
  "where it got to" rather than deleting them).
