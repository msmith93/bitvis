// The simulated cluster: a fixed topology (1 control plane + 3 worker nodes)
// and the committed state every operation derives from. The control plane
// hosts the four actors the visualization animates — kube-apiserver, etcd,
// kube-scheduler, kube-controller-manager. Workers only run pods.

import { MAX_PODS_PER_NODE } from './constants'

export const WORKER_NODES = [
  { id: 'node-1', name: 'node-1' },
  { id: 'node-2', name: 'node-2' },
  { id: 'node-3', name: 'node-3' },
]

export const CONTROL_PLANE_NODE = 'control-plane'

export const BASE_VERSION = 'v1.30.0'
export const UPGRADED_VERSION = 'v1.31.0'

// Committed cluster state. Everything the app renders is a pure derivation of
// (cluster, op); never mutate this directly to show in-progress effects.
export function initialCluster() {
  return {
    // worker node state; the control plane is static (not drainable in v1).
    // id -> { id, ready, unschedulable, version }
    nodes: Object.fromEntries(
      WORKER_NODES.map((w) => [
        w.id,
        { id: w.id, ready: true, unschedulable: false, version: BASE_VERSION },
      ]),
    ),
    // name -> { name, image, replicas, rsName, color, createdAt }
    deployments: {},
    // name -> { name, deployment, image, replicas, createdAt }
    replicaSets: {},
    // name -> { name, rs, deployment, image, node|null, phase, restarts, createdAt }
    // phase: Pending | ContainerCreating | Running | Terminating |
    //        CrashLoopBackOff | Unknown
    pods: {},
    // { id, type, reason, obj, message } — appended chronologically
    events: [],
  }
}

// Shallow-clone the containers; individual objects are shared with the
// committed cluster, so derive() must REPLACE objects (spread), not mutate.
export function cloneCluster(c) {
  return {
    nodes: { ...c.nodes },
    deployments: { ...c.deployments },
    replicaSets: { ...c.replicaSets },
    pods: { ...c.pods },
    events: [...c.events],
  }
}

// ---- Naming ----------------------------------------------------------------
// Real conventions, deterministically generated from counters the App holds
// (like opensearchvis's doc/segment counters): a ReplicaSet gets a fake
// pod-template hash (web-66b6c48dd5) and each pod a 5-char suffix from the
// same consonant-heavy alphabet Kubernetes uses (web-66b6c48dd5-8w5x7).
const SAFE_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789'
const HEX = '0123456789abcdef'

function lcg(seed) {
  let s = (seed * 2654435761 + 1013904223) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s
  }
}

export function rsHash(seed) {
  const next = lcg(seed + 17)
  let out = ''
  for (let i = 0; i < 10; i++) out += HEX[next() % HEX.length]
  return out
}

export function podSuffix(seed) {
  const next = lcg(seed + 101)
  let out = ''
  for (let i = 0; i < 5; i++) out += SAFE_ALPHABET[next() % SAFE_ALPHABET.length]
  return out
}

// ---- Scheduling ------------------------------------------------------------
// Deterministic stand-in for the kube-scheduler's filter-and-score cycle.
// Filter: only Ready, schedulable workers with a free slot (MAX_PODS_PER_NODE)
// are feasible. Score: least-loaded wins, ties broken by node order.
// Returns one nodeId per pod, or null when nothing is feasible — a null
// placement means the pod stays Pending (exactly like a real cluster with no
// capacity). Deterministic so a scrubbed op re-derives identical placements.
// `exclude` names pods to ignore when counting load (their slot is being
// vacated by the same op that plans these placements).
export function planPlacements(cluster, count, exclude = []) {
  const skip = new Set(Array.isArray(exclude) ? exclude : [exclude])
  const load = {}
  const eligible = []
  for (const w of WORKER_NODES) {
    const n = cluster.nodes[w.id]
    if (n && n.ready && !n.unschedulable) {
      eligible.push(w.id)
      load[w.id] = 0
    }
  }
  for (const p of Object.values(cluster.pods)) {
    if (
      p.node &&
      load[p.node] !== undefined &&
      !skip.has(p.name) &&
      p.phase !== 'Terminating'
    )
      load[p.node]++
  }
  const out = []
  for (let i = 0; i < count; i++) {
    let best = null
    for (const id of eligible) {
      if (load[id] >= MAX_PODS_PER_NODE) continue
      if (best === null || load[id] < load[best]) best = id
    }
    if (best !== null) load[best]++
    out.push(best)
  }
  return out
}

// Free pod slots across Ready, schedulable workers — the parser's capacity
// check for create/scale (mirrors what the scheduler above would find).
export function schedulableCapacity(cluster, exclude = []) {
  const placements = planPlacements(
    cluster,
    WORKER_NODES.length * MAX_PODS_PER_NODE,
    exclude,
  )
  return placements.filter((p) => p !== null).length
}

// Pods the scheduler is still waiting to place. Uncordon / node recovery
// re-evaluates these — the scheduler never stops watching unbound pods.
export function stuckPendingPods(cluster) {
  return Object.values(cluster.pods).filter(
    (p) => !p.node && p.phase === 'Pending',
  )
}

// Pods of one ReplicaSet in insertion (creation) order.
export function podsOfRs(cluster, rsName) {
  return Object.values(cluster.pods).filter((p) => p.rs === rsName)
}

// Pods currently bound to a node (any phase — they occupy the node visually).
export function podsOnNode(cluster, nodeId) {
  return Object.values(cluster.pods).filter((p) => p.node === nodeId)
}
