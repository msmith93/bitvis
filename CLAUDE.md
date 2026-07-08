# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Commands

- `npm run dev` — start the Vite dev server (the primary way to run/verify).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` locally.
- `./scripts/deploy.sh` — build + CDK deploy (S3/CloudFront/Route 53, see
  `infra/`) to https://kubevis.bitsculpt.top. Requires the `bitsculpt` AWS
  profile, so it only runs on the owner's machine.

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

Same core pattern as the sibling `opensearchvis` repo: a **pure derivation of
visible state from `(cluster, op)`**, which lets the stepper scrub any
operation forwards and backwards.

- **`cluster`** (`src/cluster.js`) is the committed state:
  `{ deployments, replicaSets, pods, events }`. Topology is fixed (1 control
  plane + 3 workers in `WORKER_NODES`). `planPlacements` is the deterministic
  least-loaded scheduling stand-in; `rsHash`/`podSuffix` generate real-looking
  names from counters App holds. `cloneCluster` shallow-clones containers, so
  `derive` must REPLACE objects (spread), never mutate them.

- **`op`** = `{ type, step, payload }` (held by `useOpLifecycle`). Each op type
  (`createDeployment`, `scaleUp`, `scaleDown`, `deletePod`, `get`) is one
  module in `src/ops/` declaring `{ type, label, steps, derive?, extra?,
  duration? }`; each step has the explanation text shown in the right panel
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
    `data-fly`-tagged elements), and `output` for get tables.
  - `applyOp(cluster, op)` = `deriveCluster` at the last step; folds a finished
    op into committed state (no-op for `get`, which has no `derive`).
    `start()` folds the previous finished op before beginning a new one.

- **`src/useOpLifecycle.js`** owns the op state machine (ported from
  opensearchvis): `cluster`/`op`/`opDone`/`playing`, the auto-play clock,
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
  events), `Stepper`. Framer Motion drives stage animations; `PodChip` is
  `forwardRef` because `AnimatePresence popLayout` measures exiting children.
