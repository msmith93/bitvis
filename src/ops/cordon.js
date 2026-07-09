// The `cordon` and `uncordon` ops. Cordon is the gentlest node operation:
// one boolean (spec.unschedulable) flips in etcd and the scheduler starts
// filtering the node out. Nothing running is touched — cordon ≠ drain.
// Uncordon flips it back, and crucially the scheduler then re-evaluates any
// Pending pods it couldn't place before: its watch on unbound pods never
// stops. Payloads:
//   cordon:   { id, ts, node }
//   uncordon: { id, ts, node, stuckPods: [{ name, placement|null }] }

import { flightAwareDuration } from './shared'

const CORDON_STEPS = [
  {
    key: 'request',
    ms: 1900,
    title: '1 · kubectl → API server',
    blurb:
      'kubectl cordon asks the API server to set ONE field on the Node object: spec.unschedulable = true. Like every kubectl command, it changes desired state — it does not talk to the node.',
  },
  {
    key: 'persist',
    ms: 2000,
    title: '2 · Node marked SchedulingDisabled',
    blurb:
      'The API server records it in etcd and the node now reports SchedulingDisabled. The kubelet there is still running, still healthy, still reporting status.',
  },
  {
    key: 'effect',
    ms: 2300,
    title: '3 · The scheduler filters it out — nothing else changes',
    blurb:
      'From now on the scheduler skips this node when placing new pods. Existing pods keep running untouched — cordon is NOT drain. Use it to stop new arrivals before maintenance, or as the first half of a drain.',
  },
]

const UNCORDON_STEPS = [
  {
    key: 'request',
    ms: 1900,
    title: '1 · kubectl → API server',
    blurb:
      'kubectl uncordon clears spec.unschedulable on the Node object via the API server. One field, one write.',
  },
  {
    key: 'persist',
    ms: 1900,
    title: '2 · Node schedulable again',
    blurb:
      'etcd records the change; the node drops its SchedulingDisabled badge and returns to the scheduler’s pool of feasible nodes.',
  },
  {
    key: 'reschedule',
    ms: 2300,
    title: '3 · Scheduler re-evaluates waiting Pods',
    blurb:
      'The scheduler’s watch on unbound Pods never stops. If any pods were stuck Pending for lack of capacity, the freed node makes them feasible again and they get bound now. If nothing was waiting, there is simply nothing to do.',
  },
  {
    key: 'settled',
    ms: 2100,
    title: '4 · Converged',
    blurb:
      'Any newly bound pods are started by the node’s kubelet. This is the last step of the maintenance loop: drain → (upgrade / reboot) → uncordon.',
  },
]

export const cordon = {
  type: 'cordon',
  label: 'kubectl cordon',
  steps: CORDON_STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    if (s >= 1) {
      c.nodes[p.node] = { ...c.nodes[p.node], unschedulable: true }
      c.events.push({
        id: `${p.id}-e-cordon`,
        type: 'Normal',
        reason: 'NodeNotSchedulable',
        obj: `node/${p.node}`,
        message: `Node ${p.node} status is now: NodeNotSchedulable`,
      })
    }
  },

  extra(cluster, op) {
    const p = op.payload
    switch (op.step) {
      case 0:
        return {
          focus: ['kubectl', 'apiserver'],
          flights: [
            {
              key: `${p.id}:0`,
              tokens: [{ id: `${p.id}-req`, term: `cordon ${p.node}` }],
              fromSel: '[data-fly="terminal"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 1:
        return { focus: ['apiserver', 'etcd', p.node], flights: [] }
      case 2:
        return { focus: ['scheduler', p.node], flights: [] }
      default:
        return { focus: [], flights: [] }
    }
  },

  duration: flightAwareDuration(CORDON_STEPS),
}

export const uncordon = {
  type: 'uncordon',
  label: 'kubectl uncordon',
  steps: UNCORDON_STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    if (s >= 1) {
      c.nodes[p.node] = { ...c.nodes[p.node], unschedulable: false }
      c.events.push({
        id: `${p.id}-e-uncordon`,
        type: 'Normal',
        reason: 'NodeSchedulable',
        obj: `node/${p.node}`,
        message: `Node ${p.node} status is now: NodeSchedulable`,
      })
    }
    for (const sp of p.stuckPods) {
      if (!sp.placement) continue
      if (s >= 2) {
        c.pods[sp.name] = {
          ...c.pods[sp.name],
          node: sp.placement,
          phase: s >= 3 ? 'Running' : 'ContainerCreating',
        }
        c.events.push({
          id: `${p.id}-e-sched-${sp.name}`,
          type: 'Normal',
          reason: 'Scheduled',
          obj: `pod/${sp.name}`,
          message: `Successfully assigned default/${sp.name} to ${sp.placement}`,
        })
      }
    }
  },

  extra(cluster, op) {
    const p = op.payload
    const bound = p.stuckPods.filter((sp) => sp.placement)
    switch (op.step) {
      case 0:
        return {
          focus: ['kubectl', 'apiserver'],
          flights: [
            {
              key: `${p.id}:0`,
              tokens: [{ id: `${p.id}-req`, term: `uncordon ${p.node}` }],
              fromSel: '[data-fly="terminal"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 1:
        return { focus: ['apiserver', 'etcd', p.node], flights: [] }
      case 2:
        return {
          focus: ['scheduler', 'apiserver', ...new Set(bound.map((sp) => sp.placement))],
          flights: bound.map((sp, i) => ({
            key: `${p.id}:2:${i}`,
            tokens: [
              {
                id: `${p.id}-pod-${i}`,
                term: 'Pod',
                color: cluster.pods[sp.name]?.color,
              },
            ],
            fromSel: '[data-fly="apiserver"]',
            toSel: `[data-fly="${sp.placement}"]`,
          })),
        }
      case 3:
        return {
          focus: bound.length
            ? bound.map((sp) => `kubelet:${sp.placement}`)
            : [p.node],
          flights: [],
        }
      default:
        return { focus: [], flights: [] }
    }
  },

  duration: flightAwareDuration(UNCORDON_STEPS),
}
