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

// The steps of a LIVE op. A module may export `stepsFor(payload)` instead of a
// fixed `steps`, and `search` does: dfs_query_then_fetch is a genuinely
// three-phase search, so it gains a round trip in front of the scatter and the
// FOOTER has to show that — a search type you cannot see the cost of is not
// worth offering. Prefer this everywhere over the by-type form below.
export function stepsOf(op) {
  if (!op) return []
  const mod = OPS[op.type]
  return mod?.stepsFor?.(op.payload) ?? mod?.steps ?? []
}
export const lastStep = (op) => stepsOf(op).length - 1

// The by-TYPE forms, for the two callers that ask about an op type in the
// abstract rather than about the op in flight (IndexOverlay's choreography).
// Only correct for types whose steps don't vary — which is every type but
// search.
export const stepsForType = (type) => OPS[type]?.steps || []
export const lastStepOfType = (type) => stepsForType(type).length - 1

// How long auto-play should dwell on the current step: the module's
// content-aware duration() if it returns a value, else the step's static `ms`.
export function stepDuration(op, extra = {}) {
  if (!op) return 0
  const mod = OPS[op.type]
  return mod?.duration?.(op, extra) ?? stepsOf(op)[op.step]?.ms ?? 1500
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
  return deriveCluster(cluster, { ...op, step: lastStep(op) })
}

// Transient, op-specific information for the current step (highlights, the
// in-flight doc, search results) that isn't part of the persistent cluster.
// Receives the COMMITTED cluster, not the derived one.
export function opExtra(cluster, op) {
  if (!op) return {}
  return OPS[op.type]?.extra?.(cluster, op) ?? {}
}

// Links to the official Elasticsearch docs for the current op type, shown under
// the step blurb in "What's happening" for readers who want to go deeper. An
// op module without a `docs` array simply contributes none.
export function opDocs(op) {
  if (!op) return []
  return OPS[op.type]?.docs ?? []
}

// One optional line about THIS op's payload rather than its current step —
// e.g. what a routing key or a wildcard pattern cost. Rendered under the step
// blurb, which stays static per step.
export function opNote(op, extra = {}) {
  if (!op) return null
  return OPS[op.type]?.note?.(op, extra) ?? null
}
