# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this package.

> This app is `packages/kubevis` in the **bitvis** monorepo (npm workspaces).
> Run `npm install` once at the repo root. Deploy infra lives at the repo root
> (`infra/`, `scripts/`), not here.

## Commands

Run from this package dir, or from the repo root with `-w @bitvis/kubevis`:

- `npm run dev` — start the Vite dev server (the primary way to run/verify).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` locally.
- `../../scripts/deploy.sh KubevisStack` — build + CDK deploy (S3/CloudFront/
  Route 53, see the root `infra/`) to https://kubevis.bitsculpt.top. Requires the
  `bitsculpt` AWS profile, so it only runs on the owner's machine.

There is no test runner, linter, or formatter configured. The deliverable is a
screen-recordable proof-of-concept (see `SPEC.md`), so "verify" means running
`npm run dev` and stepping through create → get → scale → delete-pod-self-heal
in the terminal.

## What this app is

A single-page React (Vite) app that teaches how Kubernetes turns kubectl
commands into running pods. A terminal simulator at the bottom accepts a small
kubectl grammar; the stage above animates the control plane (kube-apiserver,
etcd, kube-scheduler, controller-manager) and 3 worker nodes. Everything is
simulated client-side — no backend, no localStorage, all state in React.
`SPEC.md` is the authoritative description of intended behavior AND the
Kubernetes-accuracy guardrails (kubectl talks only to the API server; only the
API server touches etcd; controllers/scheduler are watch loops; desired state
lands in etcd before anything acts; pods never move — replacements get new
names; the scheduler only binds, the kubelet runs; the control plane runs ON
a node as static pods, kept free of workloads by its NoSchedule taint). Treat
those guardrails as
correctness requirements — read `SPEC.md` before changing the model.

## Architecture

Same core pattern as the sibling `elasticsearchvis` repo: a **pure derivation of
visible state from `(cluster, op)`**, which lets the stepper scrub any
operation forwards and backwards.

- **`cluster`** (`src/cluster.js`) is the committed state:
  `{ nodes, deployments, replicaSets, pods, events }`. Topology is fixed (1
  control plane + 3 workers in `WORKER_NODES`), but worker STATE is dynamic:
  `nodes[id] = { ready, unschedulable, version }` (cordon/drain/crash/
  upgrade). `planPlacements` is the deterministic scheduling stand-in —
  filters to Ready+schedulable workers with a free slot (MAX_PODS_PER_NODE),
  least-loaded wins, and returns null when nothing is feasible (the pod stays
  Pending; uncordon/recover ops re-bind `stuckPendingPods`).
  `rsHash`/`podSuffix` generate real-looking names from counters App holds.
  `cloneCluster` shallow-clones containers, so `derive` must REPLACE objects
  (spread), never mutate them.

- **`op`** = `{ type, step, payload }` (held by `useOpLifecycle`). Each op type
  (`createDeployment`, `scaleUp`, `scaleDown`, `deletePod`, `get`, `cordon`,
  `uncordon`, `drain`, `expose`, `createIngress`, `deleteService`,
  `deleteIngress`, and the scenario ops `podCrash`, `nodeCrash`,
  `recoverNode`, `upgradeNode`) is one module in `src/ops/` declaring
  `{ type, label, steps, derive?, extra?, duration? }`; each step has the explanation text shown in the right panel
  and driven by the bottom `Stepper`. Payloads precompute every name and
  placement at start-time so `derive` is pure and scrubbing is deterministic.
  Adding a kubectl verb = one new module + a registry entry in
  `src/ops/index.js` + a parser case in `src/kubectl.js`.

- **Derivation** (dispatched by `src/ops/index.js`):
  - `deriveCluster(cluster, op)` returns how the cluster should *look* at the
    current `op.step` — always clones, applies the module's partial effect of
    steps `<= op.step`. Single source of the rendered cluster.
  - `opExtra(cluster, op)` returns transient step info: `focus` (which actor
    boxes/nodes/kubelets glow), `flights` (chip flights between
    `data-fly`-tagged elements — pod-creation flights land on the apiserver,
    binding flights go apiserver → node; unscheduled pods are visible only in
    the SidePanel etcd tree plus the scheduler's "waiting" pill), and
    `output` for get tables.
  - `applyOp(cluster, op)` = `deriveCluster` at the last step; folds a finished
    op into committed state (no-op for `get`, which has no `derive`).
    `start()` folds the previous finished op before beginning a new one.

- **`src/useOpLifecycle.js`** owns the op state machine (ported from
  elasticsearchvis): `cluster`/`op`/`opDone`/`playing`, the auto-play clock,
  memoized `derived`/`extra`, `start`/`step`/`play`/`pause`/`resetTo`, and
  `base` (the folded cluster the parser validates against). **`App.jsx`**
  keeps UI state: terminal scrollback, naming/op counters (refs), presets,
  and builds op payloads from parsed commands.

- **`src/kubectl.js`** is the tolerant kubectl parser (returns tagged action
  objects; validates against `base`) plus the kubectl-style table formatters
  used by `get`. `src/constants.js` holds demo caps (replicas, pods/node).

- **`src/timing.js`** holds every animation-scheduling constant (flight
  stagger/travel/pad, pod-appear delay) so step budgets
  (`flightAwareDuration` in `src/ops/shared.js`) and framer transitions stay
  in sync.

- **Components** (`src/components/`) are presentational, driven by the derived
  cluster + `opExtra`: `ClusterStage` (control-plane actors, pending tray,
  node columns, pod chips), `ChipFlight` (viewport-coordinate chip flights
  between `data-fly` elements), `Terminal` (scrollback/prompt/history/presets;
  disabled while an op is mid-walk), `SidePanel` (step blurb + etcd tree +
  events), `Stepper`, `ScenarioBar` (the simulate bar; App picks each
  scenario's target at click time and echoes it into the terminal),
  `TrafficRail` + `RequestFlight` (the serving chain UI).

- **Traffic** (`src/useTraffic.js`) is an ambient layer OUTSIDE the op
  machinery: a 250ms tick accumulates fractional requests at the
  slider-selected rate (RPS_STEPS, 0–100 r/s) and evaluates
  `routeRequest(derived)` (in `src/cluster.js` — ingress rule → Service →
  ready endpoints, first missing hop wins: 404/503) against the currently
  rendered cluster, so requests react to mid-op states and scrubbing. At
  rps ≤ 1 each request is a decorative `RequestFlight` chip; above that
  `TrafficBeams` draws aggregate flow beams and pods get live `r/s` badges.
  Pods have a POD_CAPACITY_RPS (20) serving limit — sustained overload
  OOM-kills them into CrashLoopBackOff with kubelet restart after an
  escalating backoff, cascading as survivors inherit the load. Those phase
  flips are the only committed-state writes outside ops, funneled through
  `useOpLifecycle`'s `commit(mutator)` (crashes defer while an op is
  mid-walk; restarts always commit, phase-guarded); all overload
  bookkeeping stays in refs inside `useTraffic`, never in cluster state.
  `services` and `ingresses` live in cluster state; `serviceEndpoints`
  counts only Running pods. Framer Motion drives stage animations;
  `PodChip` is `forwardRef` because `AnimatePresence popLayout` measures
  exiting children.

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
