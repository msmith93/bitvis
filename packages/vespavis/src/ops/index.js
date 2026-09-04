import { cloneCluster } from '../cluster'
import feed from './feed'
import update from './update'
import remove from './remove'
import flush from './flush'
import fusion from './fusion'
import query from './query'

// Every user action becomes an `op = { type, step, payload }`. Each type is one
// self-contained module declaring its steps, its label and (optionally)
// derive / extra / note / duration. Visible state is derived purely from
// (cluster, op), so steps scrub forwards and backwards; reaching the last step
// folds the effect into the committed cluster via applyOp.
//
// A module may export `stepsFor(payload)` instead of a fixed `steps`, and both
// the query and update ops do. Which phases a query runs is a property of its
// rank profile, and whether an update is cheap is a property of the field's
// indexing statement — so in both cases the FOOTER changes shape, which is the
// cheapest way to make that visible.
export const OPS = { feed, update, remove, flush, fusion, query }

export const OP_LABELS = Object.fromEntries(
  Object.entries(OPS).map(([type, mod]) => [type, mod.label]),
)

// The steps of a LIVE op (payload-aware). Prefer this everywhere.
export function stepsOf(op) {
  if (!op) return []
  const mod = OPS[op.type]
  return mod?.stepsFor?.(op.payload) ?? mod?.steps ?? []
}
export const lastStep = (op) => stepsOf(op).length - 1

export function stepDuration(op, extra = {}) {
  if (!op) return 0
  const mod = OPS[op.type]
  return mod?.duration?.(op, extra) ?? stepsOf(op)[op.step]?.ms ?? 1500
}

// How the cluster should LOOK at the current step. Always clones, even for the
// read-only query op, so the rendered cluster's identity behaves the same way
// on every render regardless of op type.
export function deriveCluster(cluster, op) {
  if (!op) return cluster
  const c = cloneCluster(cluster)
  OPS[op.type]?.derive?.(c, op)
  return c
}

// Ops without a derive() (query) are read-only and never fold.
export function applyOp(cluster, op) {
  if (!op || !OPS[op.type]?.derive) return cluster
  return deriveCluster(cluster, { ...op, step: lastStep(op) })
}

export function opExtra(cluster, op) {
  if (!op) return {}
  return OPS[op.type]?.extra?.(cluster, op) ?? {}
}

// One optional line about THIS op's payload rather than its current step.
export function opNote(op, extra = {}) {
  if (!op) return null
  return OPS[op.type]?.note?.(op, extra) ?? null
}
