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
  never land on it — dedicated, workload-free control-plane nodes are the
  production norm for self-hosted clusters, and the stage depicts that. It is
  drawn in the SAME row as the workers: it's just a node with a different
  role. Unscheduled (Pending, unbound) pods appear ONLY in the side panel's
  etcd cluster-state tree (highlighted) plus a "waiting" counter on the
  kube-scheduler box — a pod with no node is just a record in etcd, so it has
  no place on the stage.
- **3 worker nodes** (`node-1..3`), each with a kubelet badge and a stack of
  pod chips. Capacity capped at 4 pods per node (demo-size limit).
- Single `default` namespace; workloads are Deployments only.

## Core interaction
1. The terminal accepts a small kubectl grammar (presets provided):
   - `kubectl create deployment <name> --image=<img> [--replicas=<n>]`
   - `kubectl scale deployment <name> --replicas=<n>`
   - `kubectl delete pod <name>`
   - `kubectl cordon|uncordon|drain <node>` (drain accepts and ignores
     `--ignore-daemonsets` / `--force`)
   - `kubectl expose deployment <name> [--port=<n>]`
   - `kubectl create ingress <name> --rule=<host>/<path>=<svc>:<port>`
   - `kubectl delete service|ingress <name>`
   - `kubectl get pods|deployments|replicasets|nodes|events|services|ingress|endpoints`
   - `help`, `clear`
   A "simulate:" bar above the stage triggers the things kubectl can't do:
   Pod Crash, Node Crash, Recover Node, and Upgrade Node (enabled only for a
   drained node — upgrades happen on the machine, outside the API).
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
   Pending, unbound (visible in the etcd tree + scheduler "waiting" pill).
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

### cordon / uncordon (3 / 4 steps)
Cordon flips ONE field (`spec.unschedulable`) via the API server; the
scheduler filters the node out; running pods untouched — cordon ≠ drain.
Uncordon flips it back AND the scheduler re-evaluates any stuck Pending pods
(its watch on unbound pods never stops) — they bind to the freed node.

### drain (7 steps)
Client-side choreography — there is no Drain API object. kubectl cordons the
node, then posts an Eviction per pod (where PDBs would gate in real life) →
pods Terminating → removed → RS controllers see drift → replacements Pending
→ scheduler binds them to the REMAINING schedulable nodes (or leaves them
Pending when full) → node empty and still cordoned: safe to upgrade/reboot.
Order matters and is accurate: evict FIRST, replace after — drains have no
surge (that's a rolling-update concept, maxSurge); availability comes from
replicas + PodDisruptionBudgets.

### pod crash (scenario, 4 steps)
A container process exits. The Pod object still exists, so the ReplicaSet
controller does nothing — the KUBELET restarts the container in place
(restartPolicy Always, with CrashLoopBackOff backoff on repeats). Same pod
name, same node; RESTARTS increments in `get pods`. The deliberate
counterpoint to `delete pod`.

### node crash (scenario, 6 steps)
The kubelet's heartbeats stop; nothing announces the failure. The node
controller marks the node NotReady after a grace period; its pods go
stale/Unknown; after the tolerance window the control plane deletes the stale
Pod objects; RS controllers replace them; the scheduler binds replacements to
healthy nodes. The op ENDS with the node still NotReady — recovery is a
separate scenario (Recover Node: rejoins Ready and EMPTY; stuck Pending pods
may bind to it; pods never move back).

### expose (4 steps)
kubectl → API server → Service object in etcd (a stable ClusterIP + label
selector; NOTHING starts running) → Endpoints controller materializes the
selector into a live list of READY pod addresses → kube-proxy programs every
node's routing. Pruning is automatic: only Running pods are endpoints.

### create ingress (4 steps)
An Ingress is a routing RULE, not a proxy. kubectl → API server → rule in
etcd → the ingress controller (running all along, answering 404) watches
Ingress objects and programs the route. Deleting the Service (503) or the
Ingress (404) breaks a different link — the rail shows which.

### The traffic rail (ambient, outside the op machinery)
A synthetic user fires one request every 5 seconds, always on (pausable).
The rail is grid-aligned over the WORKER columns only — user traffic is the
data plane and must never appear to pass through the control plane; the
column above the control-plane card holds a note saying exactly that. Each
tick traces routeRequest against the currently RENDERED cluster: ingress
rule → Service → ready endpoint (round-robin), so traffic reacts live to
mid-op states, scrubbing, drains, and crashes. Failures die at the first
missing hop: no rule → 404 at the controller; missing Service or zero ready
endpoints → 503. The rail shows the user (✓/✗ ticker + counters), the
ingress controller (its rules), and one chip per Service with a live
endpoint count.

### upgrade node (scenario, 4 steps; requires a drained node)
The part kubectl cannot do: the kubelet is upgraded ON the machine. The node
briefly drops out, rejoins at the new version (visible skew in `get nodes`),
and is still cordoned — the cordon is desired state in etcd, not machine
state. Finish with `kubectl uncordon`. Fleet pattern: drain → upgrade →
uncordon, one node at a time.

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
  Terminating. A Pending pod with no node is never drawn on any node — it
  exists only in the etcd tree (side panel) until the scheduler binds it.
- The control plane is not magic infrastructure floating above the cluster —
  its components run ON a node (as static pods run by that node's kubelet).
  The scheduler filters the control-plane node out via its NoSchedule taint.
- Restarts vs replacements: a crashed CONTAINER is restarted in place by the
  kubelet (RS uninvolved, restart count increments); a lost POD OBJECT
  (delete, eviction, node failure) is replaced by the RS controller with a
  new name. Never conflate the two loops.
- Drain is kubectl-side: cordon + per-pod Evictions. No Drain object exists.
- A dead node is detected only by ABSENCE of kubelet heartbeats; the node
  controller marks NotReady, and stale pods are evicted after a tolerance
  window. Replacements never "move back" when the node returns.
- Node upgrades happen outside the Kubernetes API (drain → upgrade the
  machine → uncordon). Version skew across nodes mid-upgrade is normal.
- Pods with no feasible node stay Pending, and the scheduler binds them the
  moment capacity returns (uncordon / node recovery) — it never stops
  watching unbound pods.
- A Service is a stable virtual IP + label selector — creating one runs
  nothing. Endpoints contain only READY (Running) pods; the Endpoints
  controller prunes the rest, which is why traffic never hits a dead pod.
- An Ingress is a rule OBJECT implemented by an ingress controller that runs
  in the cluster; with no rules it still answers (404). A request fails at
  the first missing hop: no rule → 404, missing Service or zero ready
  endpoints → 503. Deleting a Service breaks serving without touching pods.
- Pod names follow the real convention: `<deployment>-<pod-template-hash>-<suffix>`.

## UI layout
- Top: title bar + Reset cluster.
- Center: the stage — the simulate bar, then ONE row of four node columns:
  the control-plane node first (tinted, with its static-pod actor boxes
  stacked inside), then the 3 workers. Node cards size to their content.
  Unscheduled pods are NOT drawn on the stage (see topology note); the
  kube-scheduler box carries an "N waiting" pill while any exist.
  Highlights and chip flights follow the active op step.
- Right: explanation panel + etcd desired-state tree + event stream.
- Bottom: the terminal (presets row, scrollback, prompt with ↑/↓ history),
  then the stepper (op label, Prev / Next / Play / Pause, step pips) at the
  very bottom.

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
- Node-failure timings (40s heartbeat grace, ~5 min pod tolerance) and crash
  backoff are compressed into steps; no PodDisruptionBudgets during drain;
  upgrades bump a single hardcoded version (v1.30.0 → v1.31.0).
- Serving: the ingress controller is drawn as a fixed rail box (really pods
  in the cluster); kube-proxy's per-node routing is collapsed into one
  Service chip; load-balancing is round-robin (a stand-in for iptables
  randomness); Endpoints-controller latency is instant; a single Ingress
  rule is honored (the first); readiness == phase Running (no probes);
  synthetic traffic evaluates the rendered (derived) cluster, so it reacts
  to scrubbing.
- `kubectl scale` to the current count prints an explanation instead of a
  no-op walkthrough.

## Roadmap (future ops, in rough priority order)
- Rolling updates: `kubectl set image` + `rollout status/undo` — second
  ReplicaSet, maxSurge/maxUnavailable choreography, rollback (now extra fun
  with live traffic: zero failed requests during a well-configured rollout).
- `kubectl describe pod` — inspector with per-object event history.
- Probes & CrashLoopBackOff; `kubectl logs`; HPA.
