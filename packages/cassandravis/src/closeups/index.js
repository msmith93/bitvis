import { stepIdx } from '../ops/writePath'
import { getIdx } from '../ops/get'
import * as quorum from './quorum'
import * as coordinator from './coordinator'
import * as writepath from './writepath'
import * as readpath from './readpath'
import * as readrepair from './readrepair'
import * as ringwalk from './ringwalk'
import * as flushCU from './flush'
import * as compactCU from './compact'
import * as gossip from './gossip'
import * as hint from './hint'
import * as merkle from './merkle'

// The close-up registry: which zoom is available WHERE (which op/step, which
// node), and how to build its ctx for the CloseUp shell. Buttons and the
// auto-close effect both go through these, so a 🔍 is only ever shown for a
// close-up that is currently valid.

const isWrite = (op) => op?.type === 'put' || op?.type === 'del'

// The zoom offered on a node card for the current op/step, or null.
export function closeUpForNode(op, nid, cluster) {
  if (!op) return null
  const p = op.payload
  if (isWrite(op)) {
    const idx = stepIdx(p)
    if (op.step === idx.write && p.replicas.includes(nid) && !p.down.includes(nid))
      return 'writepath'
    if (op.step === idx.ack && nid === p.coord) return 'quorum'
  } else if (op.type === 'get') {
    const idx = getIdx(p)
    if (idx.repair >= 0 && op.step === idx.repair && nid === p.coord) return 'readrepair'
    if (
      (op.step === idx.query || op.step === idx.resolve) &&
      p.contacted.includes(nid) &&
      cluster.nodes[nid]?.up
    )
      return 'readpath'
  } else if (op.type === 'flush') {
    if (p.targets.includes(nid)) return 'flush'
  } else if (op.type === 'compact') {
    if (p.targets.includes(nid)) return 'compact'
  } else if (op.type === 'nodeCrash' || op.type === 'coordCrash') {
    if (op.step === 1 && nid !== p.node && cluster.nodes[nid]?.up) return 'gossip'
    // The reroute step: zoom on the NEW coordinator for the leader-vs-
    // leaderless contrast — why no election just happened.
    if (op.type === 'coordCrash' && op.step === 2 && nid === p.next) return 'coordinator'
  } else if (op.type === 'recoverNode') {
    if (p.replays.length > 0 && op.step === 1 && nid === p.node) return 'hint'
  }
  return null
}

// The zoom offered on the ring (the hash + walk phases of put/del/get).
export function ringCloseUp(op) {
  if (!op) return null
  const inWalkPhase = op.step >= 1 && op.step <= 2
  return (isWrite(op) || op.type === 'get') && inWalkPhase ? 'ringwalk' : null
}

// The zoom offered on the Merkle panel during a repair.
export function merkleCloseUp(op) {
  return op?.type === 'repair' ? 'merkle' : null
}

// Auto-close: is this open close-up still valid for the current op/step?
export function closeUpStillValid(op, cu, cluster) {
  if (!cu || !op) return false
  if (cu.kind === 'ringwalk') return ringCloseUp(op) === 'ringwalk'
  if (cu.kind === 'merkle') return merkleCloseUp(op) === 'merkle'
  return closeUpForNode(op, cu.node, cluster) === cu.kind
}

// Build the shell ctx for an open close-up. `base` is the committed cluster
// (before this op), used where the zoom must show pre-op storage.
export function buildCloseUp(cu, { op, base, derived }) {
  const p = op.payload
  const keysMeta = derived.keys
  switch (cu.kind) {
    case 'quorum':
      return quorum.build(p, op.type)
    case 'coordinator':
      return coordinator.build(p)
    case 'writepath':
      return writepath.build(p, cu.node, base.nodes[cu.node], op.type, keysMeta)
    case 'readpath':
      return readpath.build(cu.node, derived.nodes[cu.node], p.key, keysMeta)
    case 'readrepair':
      return readrepair.build(p)
    case 'ringwalk':
      return ringwalk.build(p)
    case 'flush':
      return flushCU.build(cu.node, base.nodes[cu.node], p.names[cu.node], keysMeta)
    case 'compact':
      return compactCU.build(cu.node, base.nodes[cu.node], p.names[cu.node], keysMeta)
    case 'gossip':
      return gossip.build(cu.node, p.node)
    case 'hint':
      return hint.build(cu.node, base.nodes[cu.node], p.replays)
    case 'merkle':
      return merkle.build(p)
    default:
      return null
  }
}

export { default as CloseUp } from './CloseUp'
