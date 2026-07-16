import { cloneCluster } from '../cluster'
import put from './put'
import get from './get'
import del from './del'
import flush from './flush'
import compact from './compact'
import { nodeCrash, recoverNode } from './nodeCrash'
import coordCrash from './coordCrash'
import repair from './repair'

// Every user action becomes an `op = { type, step, payload }`. Each type is one
// self-contained module in this directory declaring its steps, its label, and
// (optionally) derive / extra / duration. The visible state is derived purely
// from (cluster, op) via deriveCluster + opExtra, so steps can be scrubbed back
// and forth; reaching the last step folds the effect into the committed cluster
// via applyOp. Adding an op type = adding one module and registering it here.
//
// Unlike the sibling apps, `steps` may be a FUNCTION of the op payload: put and
// get legitimately grow steps when the hinted-handoff or read-repair branch
// applies. The payload is fixed at start() time, so the step list is static per
// op instance and scrubbing stays deterministic.
export const OPS = { put, get, del, flush, compact, nodeCrash, coordCrash, recoverNode, repair }

export const OP_LABELS = Object.fromEntries(
  Object.entries(OPS).map(([type, mod]) => [type, mod.label]),
)

// The step list for an op INSTANCE (payload-aware), not just a type.
export function stepsFor(op) {
  const mod = op && OPS[op.type]
  if (!mod) return []
  return typeof mod.steps === 'function' ? mod.steps(op.payload) : mod.steps
}
export const lastStep = (op) => stepsFor(op).length - 1

// How long auto-play should dwell on the current step: the module's
// content-aware duration() if it returns a value, else the step's static `ms`.
export function stepDuration(op, extra = {}) {
  if (!op) return 0
  const mod = OPS[op.type]
  return mod?.duration?.(op, extra) ?? stepsFor(op)[op.step]?.ms ?? 1500
}

// Derive how the cluster should LOOK at the current op step. Folding an op into
// committed state = deriveCluster at the last step (see applyOp). Always clones
// — even for read-only ops — so the rendered cluster's identity behaves the
// same on every render regardless of op type.
export function deriveCluster(cluster, op) {
  if (!op) return cluster
  const c = cloneCluster(cluster)
  OPS[op.type]?.derive?.(c, op)
  return c
}

// Ops without a derive() are read-only and never fold.
export function applyOp(cluster, op) {
  if (!op || !OPS[op.type]?.derive) return cluster
  return deriveCluster(cluster, { ...op, step: lastStep(op) })
}

// Transient, op-specific information for the current step (focus highlights,
// chip flights, the ring walk state, read responses) that isn't part of the
// persistent cluster. Receives the COMMITTED cluster, not the derived one.
export function opExtra(cluster, op) {
  if (!op) return {}
  return OPS[op.type]?.extra?.(cluster, op) ?? {}
}
