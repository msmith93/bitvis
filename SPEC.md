# Build: Interactive Kubernetes Visualizer (Proof of Concept)

## Goal
A single-page React app that teaches how Kubernetes turns a kubectl command
into running containers. The user types commands into a **terminal simulator at
the bottom**; above it, a **cluster stage** animates what the control plane
actually does — the request hitting the API server, desired state landing in
etcd, controllers reconciling, the scheduler binding pods, kubelets starting
containers. A stepper scrubs every operation forwards and backwards with a
short explanation per step. The reconciliation loop (desired vs actual state)
is the pedagogical core.

Sibling project: `opensearchvis` (OpenSearch write-path visualizer). kubevis
reuses its architecture — pure derivation of visible state from `(cluster,
op)`, per-op step modules, one timing file, Framer Motion chip flights.

## Tech
- React (Vite, single page). No backend — everything simulated client-side.
- Discrete boxes/badges/chips whose state is animated; a teaching tool, not
  high-perf. Framer Motion for stage animations.
- No localStorage/sessionStorage. All state in React state.

## Cluster topology (fixed)
- **1 control-plane node** (`control-plane`) — drawn as a real node with its
  own kubelet, hosting the four control-plane components **as static pods**
  (kubeadm-style stacked topology): **kube-apiserver**, **etcd**,
  **kube-scheduler**, **kube-controller-manager**. It carries the
  `node-role.kubernetes.io/control-plane:NoSchedule` taint, so user workloads
  never land on it. The stage also shows a tray for unscheduled (Pending,
  unbound) pods, which exist only as API objects.
- **3 worker nodes** (`node-1..3`), each with a kubelet badge and a stack of
  pod chips. Capacity capped at 4 pods per node (demo-size limit).
- Single `default` namespace; workloads are Deployments only.

## Core interaction
1. The terminal accepts a small kubectl grammar (presets provided):
   - `kubectl create deployment <name> --image=<img> [--replicas=<n>]`
   - `kubectl scale deployment <name> --replicas=<n>`
   - `kubectl delete pod <name>`
   - `kubectl get pods|deployments|replicasets|nodes|events`
   - `help`, `clear`
2. Every command becomes an **op** that walks discrete steps on the stage.
   A stepper (Prev / Next / Play / Pause) controls and scrubs the active op.
3. The right panel shows the current step's explanation, the etcd
   desired-state tree (Deployment → ReplicaSet → Pods), and recent events.
4. `get` commands print kubectl-style tables in the terminal after their
   (read-only) op finishes.

## Operations to model (KEEP THESE ACCURATE)

### create deployment (the marquee, 7 steps)
1. **kubectl → API server** — the only front door; the request is declarative.
2. **Desired state to etcd** — Deployment object persisted; NOTHING runs yet.
3. **Deployment controller** — watch fires; creates the ReplicaSet (via the
   API server).
4. **ReplicaSet controller** — desired N vs actual 0; creates N Pod objects,
   Pending, unbound (shown in the tray).
5. **Scheduler binds** — filters/scores nodes (least-loaded stand-in), writes
   only `nodeName` back. The scheduler never starts anything.
6. **Kubelet** — each bound node's kubelet pulls the image and starts the
   container (ContainerCreating).
7. **Running** — kubelets report status up; desired == actual.

### scale (up: 6 steps / down: 5 steps — separate op types)
Up: request → etcd spec change → RS controller creates the missing pods →
scheduler binds them → kubelets start them → converged. Existing pods are
untouched.
Down: request → etcd spec change → RS controller picks victims (youngest
first) → kubelets stop containers, pod objects removed → converged.

### delete pod (self-healing, 7 steps)
Request → pod Terminating (kubelet graceful shutdown) → pod object gone,
actual < desired → **ReplicaSet controller notices the drift** and creates a
replacement with a NEW name → scheduler binds it (wherever is least loaded) →
kubelet starts it → healed. The controller can't tell a kubectl delete from a
crash — same loop either way.

### get (read-only, 3 steps, never mutates)
kubectl → API server → etcd read → response formatted as a kubectl table in
the terminal. Read-only ops have no `derive` and never fold into state.

## Accuracy guardrails (don't get these wrong)
- kubectl talks **only to the API server**. Every animated arrow originates or
  terminates at the API server; kubectl never touches nodes or etcd.
- **Only the API server reads/writes etcd.**
- Controllers and the scheduler are watch/reconcile loops against the API
  server. They never talk to each other, to kubelets, or to containers.
- **Declarative first**: every mutating command lands in etcd as desired state
  BEFORE any controller acts. Never animate a command directly creating a
  container.
- Ownership: Deployment → ReplicaSet → Pods. Deleting an RS-owned pod triggers
  recreation; the replacement has a **new name**.
- **Pods never move.** A pod chip never migrates between nodes; replacement =
  new Pod object, possibly on a different node.
- The scheduler only sets `nodeName` (binds); only the kubelet starts
  containers.
- Phases progress Pending → ContainerCreating → Running; deletion shows
  Terminating. A Pending pod with no node sits in the control-plane tray, not
  on a node.
- The control plane is not magic infrastructure floating above the cluster —
  its components run ON a node (as static pods run by that node's kubelet).
  The scheduler filters the control-plane node out via its NoSchedule taint.
- Pod names follow the real convention: `<deployment>-<pod-template-hash>-<suffix>`.

## UI layout
- Top: title bar + Reset cluster.
- Center: the stage — control plane (4 actor boxes + unscheduled-pod tray)
  above 3 worker-node columns. Highlights and chip flights follow the active
  op step.
- Right: explanation panel + etcd desired-state tree + event stream.
- Bottom: stepper (op label, Prev / Next / Play / Pause, step pips), then the
  terminal (presets row, scrollback, prompt with ↑/↓ history).

## Deliverable for this POC
- Working `npm run dev` Vite app.
- create → full 7-step walkthrough with flights, scrubbing both directions.
- scale up/down → reconciliation diff visualized.
- delete pod → self-healing with a new pod name.
- get → read path animated, kubectl-style tables printed.
- Deterministic scrubbing: replaying an op yields identical names/placements.
- Clean enough to screen-record. Don't over-engineer.

## Flagged simplifications of the Kubernetes model
Documented so reviewers can verify the teaching stays honest:
- Single namespace (`default`); Deployments only; one container per pod.
- Scheduling is least-loaded spread — no resource requests/limits, affinity,
  or taints. Capacity is a hard demo cap (4 pods/node) enforced by the parser
  rather than pods staying Pending.
- `ContainerCreating` is shown as a pod phase (it's really a container status
  within Pending) for teaching clarity.
- Image pulls are a timing constant; no registries, probes, or restarts.
- No kube-proxy, Services, DNS, or networking (roadmap).
- The controller-manager is drawn as one box; Deployment and ReplicaSet
  controllers are named in the step text but not drawn separately.
- One control-plane node with stacked etcd (no HA / external etcd); managed
  clouds (EKS/GKE/AKS) instead host the control plane on machines you never
  see. The control-plane static pods live in `kube-system`, which is why they
  don't appear in `kubectl get pods` (we only show `default`).
- Events are simplified (no counts/timestamps beyond ordering).
- `kubectl scale` to the current count prints an explanation instead of a
  no-op walkthrough.

## Roadmap (future ops, in rough priority order)
- Rolling updates: `kubectl set image` + `rollout status/undo` — second
  ReplicaSet, maxSurge/maxUnavailable choreography, rollback.
- Services & traffic: `kubectl expose` — selector matching, Endpoints,
  animated request load-balancing across pods.
- Node ops: `cordon` / `drain` / `uncordon`, simulated node failure →
  mass rescheduling (pods replaced, not moved).
- `kubectl describe pod` — inspector with per-object event history.
- Probes & CrashLoopBackOff; `kubectl logs`; HPA.
