// The `drain` op: the standard pre-maintenance move. Notably, drain is a
// CLIENT-side orchestration — there is no "drain" object in Kubernetes.
// kubectl itself cordons the node, then requests an Eviction for each pod on
// it, and the usual machinery (RS controllers + scheduler + kubelets) does
// the rest. Payload:
//   { id, ts, node, victims: [{ name, rsName, deployment, image, color,
//     newName, placement|null }] }
// A null placement means the remaining nodes are full: the replacement stays
// Pending until capacity returns (uncordon / recovery) — exactly like a real
// cluster.

import { flightAwareDuration } from './shared'

const STEPS = [
  {
    key: 'cordon',
    ms: 2100,
    title: '1 · kubectl cordons the node first',
    blurb:
      'kubectl drain is client-side choreography — there is no Drain API object. Step one: kubectl sets spec.unschedulable = true on the node via the API server, so nothing new lands while we empty it.',
  },
  {
    key: 'persist',
    ms: 1900,
    title: '2 · SchedulingDisabled recorded',
    blurb:
      'etcd records the cordon; the scheduler now filters this node out. Its pods are still running — emptying them is the next step, and it happens pod by pod.',
  },
  {
    key: 'evict',
    ms: 2300,
    title: '3 · kubectl requests Evictions',
    blurb:
      'For each pod on the node, kubectl posts an Eviction through the API server (in a real cluster this is where PodDisruptionBudgets can say “not yet”). The pods enter Terminating — graceful shutdown, not a kill.',
  },
  {
    key: 'stopped',
    ms: 2100,
    title: '4 · Kubelet stops them; Pod objects removed',
    blurb:
      'The node’s kubelet sends each container SIGTERM, waits out the grace period, and the Pod objects are removed from etcd. The deployments are now BELOW their desired replica counts.',
  },
  {
    key: 'reconcile',
    ms: 2300,
    title: '5 · ReplicaSet controllers see the drift',
    blurb:
      'Eviction looks identical to any other pod loss: desired > actual. The ReplicaSet controllers create replacement Pod objects — new names, Pending, unscheduled. Note the order: evict FIRST, replace after. Drains have no surge (pre-creating spares is a rolling-update concept, maxSurge); availability during a drain comes from running enough replicas and from PodDisruptionBudgets.',
  },
  {
    key: 'schedule',
    ms: 2100,
    title: '6 · Scheduler places them on the REMAINING nodes',
    blurb:
      'The drained node is filtered out (SchedulingDisabled), so replacements land on the other workers. If they are full, a replacement simply stays Pending — it will bind the moment capacity returns.',
  },
  {
    key: 'drained',
    ms: 2400,
    title: '7 · Drained: empty and still cordoned',
    blurb:
      'The kubelets start the replacements; the drained node is empty but STILL cordoned. It is now safe to upgrade its kubelet, reboot it, or replace the machine — then kubectl uncordon brings it back into service.',
  },
]

export default {
  type: 'drain',
  label: 'kubectl drain',
  steps: STEPS,

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
    for (const v of p.victims) {
      if (s >= 3) delete c.pods[v.name]
      else if (s >= 2) c.pods[v.name] = { ...c.pods[v.name], phase: 'Terminating' }
      if (s >= 2)
        c.events.push({
          id: `${p.id}-e-evict-${v.name}`,
          type: 'Normal',
          reason: 'Evicted',
          obj: `pod/${v.name}`,
          message: `Evicted pod from ${p.node} (drain)`,
        })
      if (s >= 4) {
        c.pods[v.newName] = {
          name: v.newName,
          rs: v.rsName,
          deployment: v.deployment,
          image: v.image,
          color: v.color,
          node: s >= 5 ? v.placement : null,
          phase:
            s >= 6 && v.placement
              ? 'Running'
              : s >= 5 && v.placement
              ? 'ContainerCreating'
              : 'Pending',
          restarts: 0,
          createdAt: p.ts,
        }
        c.events.push({
          id: `${p.id}-e-create-${v.newName}`,
          type: 'Normal',
          reason: 'SuccessfulCreate',
          obj: `replicaset/${v.rsName}`,
          message: `Created pod: ${v.newName}`,
        })
      }
      if (s >= 5 && v.placement)
        c.events.push({
          id: `${p.id}-e-sched-${v.newName}`,
          type: 'Normal',
          reason: 'Scheduled',
          obj: `pod/${v.newName}`,
          message: `Successfully assigned default/${v.newName} to ${v.placement}`,
        })
    }
  },

  extra(cluster, op) {
    const p = op.payload
    const placed = p.victims.filter((v) => v.placement)
    const chips = (list) =>
      list.map((v, i) => ({ id: `${p.id}-pod-${i}`, term: 'Pod', color: v.color }))
    switch (op.step) {
      case 0:
        return {
          focus: ['kubectl', 'apiserver', p.node],
          flights: [
            {
              key: `${p.id}:0`,
              tokens: [{ id: `${p.id}-req`, term: `drain ${p.node}` }],
              fromSel: '[data-fly="terminal"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 1:
        return { focus: ['apiserver', 'etcd', p.node], flights: [] }
      case 2:
        return {
          focus: ['kubectl', 'apiserver', p.node],
          flights: [
            {
              key: `${p.id}:2`,
              tokens: p.victims.map((v, i) => ({
                id: `${p.id}-ev-${i}`,
                term: 'Eviction',
              })),
              fromSel: '[data-fly="terminal"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 3:
        return { focus: [`kubelet:${p.node}`, p.node], flights: [] }
      case 4:
        return {
          focus: ['controller', 'apiserver'],
          flights: [
            {
              key: `${p.id}:4`,
              tokens: chips(p.victims),
              fromSel: '[data-fly="controller"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 5:
        return {
          focus: ['scheduler', 'apiserver', ...new Set(placed.map((v) => v.placement))],
          flights: placed.map((v, i) => ({
            key: `${p.id}:5:${i}`,
            tokens: [{ id: `${p.id}-pl-${i}`, term: 'Pod', color: v.color }],
            fromSel: '[data-fly="apiserver"]',
            toSel: `[data-fly="${v.placement}"]`,
          })),
        }
      case 6:
        return {
          focus: [
            p.node,
            ...new Set(placed.map((v) => `kubelet:${v.placement}`)),
          ],
          flights: [],
        }
      default:
        return { focus: [], flights: [] }
    }
  },

  duration: flightAwareDuration(STEPS),
}
