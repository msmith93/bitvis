// The `deletePod` op: the self-healing "aha". Deleting a pod owned by a
// ReplicaSet doesn't shrink anything — the moment reality drops below desired
// state, the ReplicaSet controller manufactures a replacement (with a NEW
// name; pods are never resurrected or moved). Payload:
//   { id, ts, podName, node, rsName, deployment, image, color, replicas,
//     newPodName, placement }

import { flightAwareDuration } from './shared'

const STEPS = [
  {
    key: 'request',
    ms: 1900,
    title: '1 · kubectl → API server',
    blurb:
      'kubectl asks the API server to delete one specific pod. Note the shape of what’s coming: nobody tells the ReplicaSet “please make a new one.” Deletion is just another change to cluster state — and controllers are watching.',
  },
  {
    key: 'terminating',
    ms: 2200,
    title: '2 · Pod enters Terminating',
    blurb:
      'The API server marks the pod for deletion. The kubelet on its node sees this and begins a graceful shutdown: the container gets SIGTERM and a grace period to finish in-flight work.',
  },
  {
    key: 'gone',
    ms: 2000,
    title: '3 · Pod object removed',
    blurb:
      'The container has stopped and the Pod object is removed from etcd. The deployment is now BELOW its desired replica count — desired and actual state disagree.',
  },
  {
    key: 'rs-notices',
    ms: 2300,
    title: '4 · ReplicaSet controller notices the drift',
    blurb:
      'The ReplicaSet controller’s watch fires: desired N, actual N−1. It doesn’t know or care WHY a pod vanished — crash, eviction, or your kubectl delete all look the same. It creates a replacement Pod object with a brand-new name.',
  },
  {
    key: 'schedule',
    ms: 1900,
    title: '5 · Scheduler binds the replacement',
    blurb:
      'The scheduler sees the new unbound pod and assigns it to the least-loaded node — which may or may not be where the old pod ran. Pods never move; they are replaced.',
  },
  {
    key: 'kubelet',
    ms: 2100,
    title: '6 · Kubelet starts the new container',
    blurb:
      'The chosen node’s kubelet pulls the image (cached, so it’s quick) and starts the container. ContainerCreating → Running.',
  },
  {
    key: 'healed',
    ms: 2400,
    title: '7 · Self-healed',
    blurb:
      'Desired and actual match again. Kubernetes didn’t “restart” your pod — it noticed reality drifted from the declared state and manufactured a new pod to close the gap. This same loop is what survives node failures at 3 a.m.',
  },
]

export default {
  type: 'deletePod',
  label: 'kubectl delete pod',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload

    if (s >= 2) delete c.pods[p.podName]
    else if (s >= 1) c.pods[p.podName] = { ...c.pods[p.podName], phase: 'Terminating' }

    if (s >= 1)
      c.events.push({
        id: `${p.id}-e-kill`,
        type: 'Normal',
        reason: 'Killing',
        obj: `pod/${p.podName}`,
        message: 'Stopping container',
      })
    if (s >= 3) {
      c.pods[p.newPodName] = {
        name: p.newPodName,
        rs: p.rsName,
        deployment: p.deployment,
        image: p.image,
        color: p.color,
        node: s >= 4 ? p.placement : null,
        phase: s >= 6 ? 'Running' : s >= 5 ? 'ContainerCreating' : 'Pending',
        restarts: 0,
        createdAt: p.ts,
      }
      c.events.push({
        id: `${p.id}-e-create`,
        type: 'Normal',
        reason: 'SuccessfulCreate',
        obj: `replicaset/${p.rsName}`,
        message: `Created pod: ${p.newPodName}`,
      })
    }
    if (s >= 4)
      c.events.push({
        id: `${p.id}-e-sched`,
        type: 'Normal',
        reason: 'Scheduled',
        obj: `pod/${p.newPodName}`,
        message: `Successfully assigned default/${p.newPodName} to ${p.placement}`,
      })
    if (s >= 6)
      c.events.push({
        id: `${p.id}-e-start`,
        type: 'Normal',
        reason: 'Started',
        obj: `pod/${p.newPodName}`,
        message: `Started container ${p.deployment}`,
      })
  },

  extra(cluster, op) {
    const p = op.payload
    const chip = [{ id: `${p.id}-new`, term: 'Pod', color: p.color }]
    switch (op.step) {
      case 0:
        return {
          focus: ['kubectl', 'apiserver'],
          flights: [
            {
              key: `${p.id}:0`,
              tokens: [{ id: `${p.id}-req`, term: `delete ${short(p.podName)}` }],
              fromSel: '[data-fly="terminal"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 1:
        return { focus: ['apiserver', `kubelet:${p.node}`, p.node], flights: [] }
      case 2:
        return { focus: ['apiserver', 'etcd', p.node], flights: [] }
      case 3:
        return {
          focus: ['controller', 'apiserver'],
          flights: [
            {
              key: `${p.id}:3`,
              tokens: chip,
              fromSel: '[data-fly="controller"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 4:
        return {
          focus: ['scheduler', 'apiserver', p.placement],
          flights: [
            {
              key: `${p.id}:4`,
              tokens: chip,
              fromSel: '[data-fly="apiserver"]',
              toSel: `[data-fly="${p.placement}"]`,
            },
          ],
        }
      case 5:
        return { focus: [`kubelet:${p.placement}`], flights: [] }
      case 6:
        return { focus: ['apiserver', p.placement], flights: [] }
      default:
        return { focus: [], flights: [] }
    }
  },

  duration: flightAwareDuration(STEPS),
}

// pod names are long; flights show just the suffix
function short(podName) {
  const parts = podName.split('-')
  return parts[parts.length - 1]
}
