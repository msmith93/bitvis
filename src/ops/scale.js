// The `scale` ops. Scaling is the cleanest demonstration that Kubernetes is
// declarative: kubectl edits ONE number on the Deployment, and the same
// reconciliation machinery that created the pods closes the new gap — up by
// creating and scheduling pods, down by terminating the surplus.
//
// Up and down are separate op types (the steps genuinely differ: up ends with
// scheduler + kubelet work, down ends with kubelets stopping containers) that
// share this file. Payloads:
//   scaleUp:   { id, ts, name, rsName, image, color, from, to, newPodNames, placements }
//   scaleDown: { id, ts, name, rsName, from, to, victims }

import { flightAwareDuration } from './shared'

const UP_STEPS = [
  {
    key: 'request',
    ms: 1900,
    title: '1 · kubectl → API server',
    blurb:
      'kubectl scale is a tiny request: patch spec.replicas on the Deployment. kubectl does not create pods — it never does. It only asks the API server to change one number in the desired state.',
  },
  {
    key: 'persist',
    ms: 1900,
    title: '2 · New desired count in etcd',
    blurb:
      'The API server updates the Deployment in etcd. Desired state and reality now disagree — and in Kubernetes, that disagreement is a to-do item for a controller, not an error.',
  },
  {
    key: 'reconcile',
    ms: 2100,
    title: '3 · ReplicaSet controller sees the gap',
    blurb:
      'The ReplicaSet controller’s watch fires: desired went up, actual is still the old count. It creates exactly the missing number of Pod objects — Pending, unscheduled, existing only as records in etcd (watch the cluster-state panel).',
  },
  {
    key: 'schedule',
    ms: 1900,
    title: '4 · Scheduler binds the new Pods',
    blurb:
      'The scheduler spots the new unbound Pods and assigns each to the least-loaded worker, writing nodeName back through the API server. Existing pods are untouched — scaling never moves what is already running.',
  },
  {
    key: 'kubelet',
    ms: 2200,
    title: '5 · Kubelets start the new containers',
    blurb:
      'The kubelets on the chosen nodes see their new assignments, pull the image, and start containers. ContainerCreating → Running.',
  },
  {
    key: 'settled',
    ms: 2000,
    title: '6 · Converged',
    blurb:
      'Actual replicas match spec.replicas again. Nothing remembers that a “scale command” happened — the system only ever compares desired vs actual, which is why the same machinery also heals crashes and node failures.',
  },
]

const DOWN_STEPS = [
  {
    key: 'request',
    ms: 1900,
    title: '1 · kubectl → API server',
    blurb:
      'kubectl scale patches spec.replicas downward on the Deployment. Again: just one number in the desired state changes. No pod is touched yet.',
  },
  {
    key: 'persist',
    ms: 1900,
    title: '2 · New desired count in etcd',
    blurb:
      'The API server records the lower replica count in etcd. Reality now has MORE pods than desired — surplus the controllers must reclaim.',
  },
  {
    key: 'reconcile',
    ms: 2300,
    title: '3 · ReplicaSet controller picks victims',
    blurb:
      'The ReplicaSet controller sees actual > desired and selects which pods to remove (preferring the youngest). It marks them for deletion via the API server; they enter Terminating.',
  },
  {
    key: 'stop',
    ms: 2300,
    title: '4 · Kubelets stop the containers',
    blurb:
      'The kubelets on the affected nodes see the deletion, send the containers a graceful shutdown signal (SIGTERM), and tear them down. The Pod objects are then removed from etcd.',
  },
  {
    key: 'settled',
    ms: 2000,
    title: '5 · Converged',
    blurb:
      'Actual replicas match the lower desired count. The freed capacity is immediately available to the scheduler for future pods.',
  },
]

export const scaleUp = {
  type: 'scaleUp',
  label: 'kubectl scale (up)',
  steps: UP_STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    if (s >= 1)
      c.deployments[p.name] = { ...c.deployments[p.name], replicas: p.to }
    if (s >= 2) {
      c.replicaSets[p.rsName] = { ...c.replicaSets[p.rsName], replicas: p.to }
      c.events.push({
        id: `${p.id}-e-rs`,
        type: 'Normal',
        reason: 'ScalingReplicaSet',
        obj: `deployment/${p.name}`,
        message: `Scaled up replica set ${p.rsName} to ${p.to}`,
      })
      p.newPodNames.forEach((pn, i) => {
        c.pods[pn] = {
          name: pn,
          rs: p.rsName,
          deployment: p.name,
          image: p.image,
          color: p.color,
          node: s >= 3 ? p.placements[i] : null,
          phase: s >= 5 ? 'Running' : s >= 4 ? 'ContainerCreating' : 'Pending',
          restarts: 0,
          createdAt: p.ts,
        }
        c.events.push({
          id: `${p.id}-e-create-${i}`,
          type: 'Normal',
          reason: 'SuccessfulCreate',
          obj: `replicaset/${p.rsName}`,
          message: `Created pod: ${pn}`,
        })
      })
    }
    if (s >= 3)
      p.newPodNames.forEach((pn, i) =>
        c.events.push({
          id: `${p.id}-e-sched-${i}`,
          type: 'Normal',
          reason: 'Scheduled',
          obj: `pod/${pn}`,
          message: `Successfully assigned default/${pn} to ${p.placements[i]}`,
        }),
      )
    if (s >= 5)
      p.newPodNames.forEach((pn, i) =>
        c.events.push({
          id: `${p.id}-e-start-${i}`,
          type: 'Normal',
          reason: 'Started',
          obj: `pod/${pn}`,
          message: `Started container ${p.name}`,
        }),
      )
  },

  extra(cluster, op) {
    const p = op.payload
    const chips = p.newPodNames.map((n, i) => ({
      id: `${p.id}-pod-${i}`,
      term: 'Pod',
      color: p.color,
    }))
    switch (op.step) {
      case 0:
        return {
          focus: ['kubectl', 'apiserver'],
          flights: [
            {
              key: `${p.id}:0`,
              tokens: [
                { id: `${p.id}-req`, term: `replicas=${p.to}`, color: p.color },
              ],
              fromSel: '[data-fly="terminal"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 1:
        return {
          focus: ['apiserver', 'etcd'],
          flights: [
            {
              key: `${p.id}:1`,
              tokens: [
                { id: `${p.id}-dep`, term: `deploy/${p.name}`, color: p.color },
              ],
              fromSel: '[data-fly="apiserver"]',
              toSel: '[data-fly="etcd"]',
            },
          ],
        }
      case 2:
        return {
          focus: ['controller', 'apiserver'],
          flights: [
            {
              key: `${p.id}:2`,
              tokens: chips,
              fromSel: '[data-fly="controller"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 3:
        return {
          focus: ['scheduler', 'apiserver', ...new Set(p.placements)],
          flights: p.placements.map((node, i) => ({
            key: `${p.id}:3:${i}`,
            tokens: [chips[i]],
            fromSel: '[data-fly="apiserver"]',
            toSel: `[data-fly="${node}"]`,
          })),
        }
      case 4:
        return {
          focus: [...new Set(p.placements.map((n) => `kubelet:${n}`))],
          flights: [],
        }
      case 5:
        return { focus: ['apiserver', ...new Set(p.placements)], flights: [] }
      default:
        return { focus: [], flights: [] }
    }
  },

  duration: flightAwareDuration(UP_STEPS),
}

export const scaleDown = {
  type: 'scaleDown',
  label: 'kubectl scale (down)',
  steps: DOWN_STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    if (s >= 1)
      c.deployments[p.name] = { ...c.deployments[p.name], replicas: p.to }
    if (s >= 2) {
      c.replicaSets[p.rsName] = { ...c.replicaSets[p.rsName], replicas: p.to }
      c.events.push({
        id: `${p.id}-e-rs`,
        type: 'Normal',
        reason: 'ScalingReplicaSet',
        obj: `deployment/${p.name}`,
        message: `Scaled down replica set ${p.rsName} to ${p.to}`,
      })
      for (const v of p.victims) {
        if (s >= 3) {
          delete c.pods[v]
        } else {
          c.pods[v] = { ...c.pods[v], phase: 'Terminating' }
        }
        c.events.push({
          id: `${p.id}-e-kill-${v}`,
          type: 'Normal',
          reason: 'Killing',
          obj: `pod/${v}`,
          message: 'Stopping container',
        })
      }
    }
  },

  extra(cluster, op) {
    const p = op.payload
    const victimNodes = [
      ...new Set(p.victims.map((v) => cluster.pods[v]?.node).filter(Boolean)),
    ]
    switch (op.step) {
      case 0:
        return {
          focus: ['kubectl', 'apiserver'],
          flights: [
            {
              key: `${p.id}:0`,
              tokens: [{ id: `${p.id}-req`, term: `replicas=${p.to}` }],
              fromSel: '[data-fly="terminal"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 1:
        return {
          focus: ['apiserver', 'etcd'],
          flights: [
            {
              key: `${p.id}:1`,
              tokens: [{ id: `${p.id}-dep`, term: `deploy/${p.name}` }],
              fromSel: '[data-fly="apiserver"]',
              toSel: '[data-fly="etcd"]',
            },
          ],
        }
      case 2:
        return { focus: ['controller', 'apiserver', ...victimNodes], flights: [] }
      case 3:
        return {
          focus: victimNodes.map((n) => `kubelet:${n}`),
          flights: [],
        }
      case 4:
        return { focus: ['apiserver'], flights: [] }
      default:
        return { focus: [], flights: [] }
    }
  },

  duration: flightAwareDuration(DOWN_STEPS),
}
