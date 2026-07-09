import { cloneCluster } from '../cluster'
import indexOp from './indexOp'
import refresh from './refresh'
import flush from './flush'
import merge from './merge'
import search from './search'

// Every user action becomes an `op = { type, step, payload }`. Each type is one
// self-contained module in this directory declaring its steps, its label, and
// (optionally) derive / extra / duration. The visible state is derived purely
// from (cluster, op) via deriveCluster + opExtra, so steps can be scrubbed back
// and forth; reaching the last step folds the effect into the committed cluster
// via applyOp. Adding an op type = adding one module and registering it here.
//
// Each step declares its own `ms`: how long auto-play dwells on it before
// advancing. Steps that launch a token flight whose length depends on content
// (analysis, replicate, scatter/gather/fetch) instead compute their duration in
// the module's duration() so the flight is never clipped by the next step.
export const OPS = { index: indexOp, refresh, flush, merge, search }

export const OP_STEPS = Object.fromEntries(
  Object.entries(OPS).map(([type, mod]) => [type, mod.steps]),
)
export const OP_LABELS = Object.fromEntries(
  Object.entries(OPS).map(([type, mod]) => [type, mod.label]),
)

export const stepsFor = (type) => OPS[type]?.steps || []
export const lastStep = (type) => stepsFor(type).length - 1

// How long auto-play should dwell on the current step: the module's
// content-aware duration() if it returns a value, else the step's static `ms`.
export function stepDuration(op, extra = {}) {
  if (!op) return 0
  const mod = OPS[op.type]
  return mod?.duration?.(op, extra) ?? mod?.steps[op.step]?.ms ?? 1500
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

// Ops without a derive() (search) are read-only and never fold.
export function applyOp(cluster, op) {
  if (!op || !OPS[op.type]?.derive) return cluster
  return deriveCluster(cluster, { ...op, step: lastStep(op.type) })
}

// Transient, op-specific information for the current step (highlights, the
// in-flight doc, search results) that isn't part of the persistent cluster.
// Receives the COMMITTED cluster, not the derived one.
export function opExtra(cluster, op) {
  if (!op) return {}
  return OPS[op.type]?.extra?.(cluster, op) ?? {}
}
