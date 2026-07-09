import { cloneCluster } from '../cluster'
import createDeployment from './createDeployment'
import { scaleUp, scaleDown } from './scale'
import deletePod from './deletePod'
import getResource from './getResource'
import { cordon, uncordon } from './cordon'
import drain from './drain'
import podCrash from './podCrash'
import { nodeCrash, recoverNode } from './nodeCrash'
import upgradeNode from './upgradeNode'
import expose from './expose'
import createIngress from './createIngress'
import { deleteService, deleteIngress } from './deleteRoute'

// Every terminal command becomes an `op = { type, step, payload }`. Each type
// is one self-contained module in this directory declaring its steps, its
// label, and (optionally) derive / extra / duration. The visible state is
// derived purely from (cluster, op) via deriveCluster + opExtra, so steps can
// be scrubbed back and forth; reaching the last step folds the effect into the
// committed cluster via applyOp. Adding a kubectl verb = adding one module and
// registering it here. (Same architecture as opensearchvis.)
export const OPS = {
  createDeployment,
  scaleUp,
  scaleDown,
  deletePod,
  get: getResource,
  cordon,
  uncordon,
  drain,
  podCrash,
  nodeCrash,
  recoverNode,
  upgradeNode,
  expose,
  createIngress,
  deleteService,
  deleteIngress,
}

export const stepsFor = (type) => OPS[type]?.steps || []
export const lastStep = (type) => stepsFor(type).length - 1

// How long auto-play should dwell on the current step: the module's
// content-aware duration() if it returns a value, else the step's static `ms`.
export function stepDuration(op, extra = {}) {
  if (!op) return 0
  const mod = OPS[op.type]
  return mod?.duration?.(op, extra) ?? mod?.steps[op.step]?.ms ?? 1600
}

// Derive how the cluster should LOOK at the current op step. Folding an op
// into committed state = deriveCluster at the last step (see applyOp). Always
// clones — even for read-only ops — so the rendered cluster's identity behaves
// the same on every render regardless of op type.
export function deriveCluster(cluster, op) {
  if (!op) return cluster
  const c = cloneCluster(cluster)
  OPS[op.type]?.derive?.(c, op)
  return c
}

// Ops without a derive() (get) are read-only and never fold.
export function applyOp(cluster, op) {
  if (!op || !OPS[op.type]?.derive) return cluster
  return deriveCluster(cluster, { ...op, step: lastStep(op.type) })
}

// Transient, op-specific information for the current step (actor highlights,
// chip flights, get output) that isn't part of the persistent cluster.
// Receives the COMMITTED cluster, not the derived one.
export function opExtra(cluster, op) {
  if (!op) return {}
  return OPS[op.type]?.extra?.(cluster, op) ?? {}
}
