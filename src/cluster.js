// The simulated cluster: a fixed topology (1 control plane + 3 worker nodes)
// and the committed state every operation derives from. The control plane
// hosts the four actors the visualization animates — kube-apiserver, etcd,
// kube-scheduler, kube-controller-manager. Workers only run pods.

export const WORKER_NODES = [
  { id: 'node-1', name: 'node-1' },
  { id: 'node-2', name: 'node-2' },
  { id: 'node-3', name: 'node-3' },
]

export const CONTROL_PLANE_NODE = 'control-plane'

// Committed cluster state. Everything the app renders is a pure derivation of
// (cluster, op); never mutate this directly to show in-progress effects.
export function initialCluster() {
  return {
    // name -> { name, image, replicas, rsName, createdAt }
    deployments: {},
    // name -> { name, deployment, image, replicas, createdAt }
    replicaSets: {},
    // name -> { name, rs, deployment, image, node|null, phase, createdAt }
    // phase: Pending | ContainerCreating | Running | Terminating
    pods: {},
    // { id, type, reason, obj, message } — appended chronologically
    events: [],
  }
}

// Shallow-clone the containers; individual objects are shared with the
// committed cluster, so derive() must REPLACE objects (spread), not mutate.
export function cloneCluster(c) {
  return {
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
// Deterministic stand-in for the kube-scheduler's filter-and-score cycle:
// least-loaded worker wins, ties broken by node order. Deterministic so a
// scrubbed op re-derives identical placements. `exclude` lets deletePod plan
// the replacement as if the victim were already gone.
export function planPlacements(cluster, count, exclude = null) {
  const load = Object.fromEntries(WORKER_NODES.map((w) => [w.id, 0]))
  for (const p of Object.values(cluster.pods)) {
    if (p.node && p.name !== exclude && p.phase !== 'Terminating') load[p.node]++
  }
  const out = []
  for (let i = 0; i < count; i++) {
    let best = WORKER_NODES[0].id
    for (const w of WORKER_NODES) if (load[w.id] < load[best]) best = w.id
    load[best]++
    out.push(best)
  }
  return out
}

// Live (schedulable-capacity-consuming) pod count, for the parser's cap check.
export function livePodCount(cluster) {
  return Object.values(cluster.pods).filter((p) => p.phase !== 'Terminating')
    .length
}

// Pods of one ReplicaSet in insertion (creation) order.
export function podsOfRs(cluster, rsName) {
  return Object.values(cluster.pods).filter((p) => p.rs === rsName)
}
