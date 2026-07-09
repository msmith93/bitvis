// The `nodeCrash` and `recoverNode` scenarios. A node failure is where the
// control plane's watch-based design earns its keep: nobody tells Kubernetes
// the node died — the kubelet's heartbeats just stop, the node controller
// times out, and the same drift-correction machinery that handles a deleted
// pod handles a lost machine. The op ends with the node still NotReady;
// recovery is a separate scenario. Payloads:
//   nodeCrash:   { id, ts, node, victims: [{ name, rsName, deployment, image,
//                  color, newName, placement|null }] }
//   recoverNode: { id, ts, node, stuckPods: [{ name, placement|null }] }

import { flightAwareDuration } from './shared'

const CRASH_STEPS = [
  {
    key: 'silent',
    ms: 2300,
    title: '1 · The node goes silent',
    blurb:
      'Power failure, kernel panic, someone unplugs the wrong cable. The kubelet’s heartbeats (its Lease renewals) simply stop arriving at the API server. Nothing announces the failure — the cluster can only notice an absence.',
  },
  {
    key: 'notready',
    ms: 2400,
    title: '2 · Node controller marks it NotReady',
    blurb:
      'The node controller (in the controller-manager) watches those heartbeats. After a grace period (~40s real time, compressed here) with no word from the kubelet, it flips the node’s condition to NotReady via the API server.',
  },
  {
    key: 'stale',
    ms: 2400,
    title: '3 · Its pods become unknowable',
    blurb:
      'The pods on the dead node go stale: their containers might still be running — the cluster genuinely cannot know. Kubernetes waits a tolerance window (default ~5 min, compressed here) before giving up on them, in case the node comes right back.',
  },
  {
    key: 'evict',
    ms: 2300,
    title: '4 · Eviction: the stale pods are given up on',
    blurb:
      'The control plane deletes the unreachable Pod objects. Now it is the familiar story: ReplicaSet controllers see desired > actual and create replacement pods — new names, Pending.',
  },
  {
    key: 'reschedule',
    ms: 2100,
    title: '5 · Replacements land on healthy nodes',
    blurb:
      'The scheduler filters out the NotReady node and binds the replacements to the surviving workers; their kubelets pull and start. If the survivors are full, a replacement stays Pending until capacity returns.',
  },
  {
    key: 'down',
    ms: 2500,
    title: '6 · Recovered? Not yet.',
    blurb:
      'The workload is healthy again — that is the point of replicas — but the node is still down and stays NotReady. Nothing will land on it until it comes back. Use the “Recover Node” scenario (or in real life: fix the machine) to bring it home.',
  },
]

const RECOVER_STEPS = [
  {
    key: 'reboot',
    ms: 2200,
    title: '1 · The machine comes back',
    blurb:
      'The node reboots and its kubelet reconnects to the API server, resuming heartbeats. Any containers it was running before the crash are gone — their Pod objects were already deleted and replaced elsewhere.',
  },
  {
    key: 'ready',
    ms: 2100,
    title: '2 · Node controller marks it Ready',
    blurb:
      'Heartbeats are flowing again, so the node controller flips the condition back to Ready. The node rejoins the scheduler’s pool — empty. Note what does NOT happen: no pod “moves back”. Pods never move.',
  },
  {
    key: 'reschedule',
    ms: 2300,
    title: '3 · Scheduler re-evaluates waiting Pods',
    blurb:
      'If any pods were stuck Pending (the survivors were full), the recovered node makes them feasible and they bind to it now. Otherwise it simply waits for future work.',
  },
  {
    key: 'settled',
    ms: 2100,
    title: '4 · Back in service',
    blurb:
      'The cluster is whole again. The crash cost you nothing but the pods’ in-memory state — the deployment’s desired count was maintained throughout by controllers that never knew or cared WHY the pods vanished.',
  },
]

export const nodeCrash = {
  type: 'nodeCrash',
  label: 'scenario: node crash',
  steps: CRASH_STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload

    if (s >= 0) c.nodes[p.node] = { ...c.nodes[p.node], ready: false }
    if (s >= 1)
      c.events.push({
        id: `${p.id}-e-notready`,
        type: 'Warning',
        reason: 'NodeNotReady',
        obj: `node/${p.node}`,
        message: `Node ${p.node} status is now: NodeNotReady`,
      })
    for (const v of p.victims) {
      if (s >= 3) delete c.pods[v.name]
      else if (s >= 2) c.pods[v.name] = { ...c.pods[v.name], phase: 'Unknown' }
      if (s >= 3)
        c.events.push({
          id: `${p.id}-e-evict-${v.name}`,
          type: 'Warning',
          reason: 'TaintManagerEviction',
          obj: `pod/${v.name}`,
          message: `Deleting pod from unreachable node ${p.node}`,
        })
      if (s >= 3) {
        c.pods[v.newName] = {
          name: v.newName,
          rs: v.rsName,
          deployment: v.deployment,
          image: v.image,
          color: v.color,
          node: s >= 4 ? v.placement : null,
          phase:
            s >= 5 && v.placement
              ? 'Running'
              : s >= 4 && v.placement
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
      if (s >= 4 && v.placement)
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
    switch (op.step) {
      case 0:
        return { focus: [p.node], flights: [] }
      case 1:
        return { focus: ['controller', 'apiserver', p.node], flights: [] }
      case 2:
        return { focus: [p.node], flights: [] }
      case 3:
        return {
          focus: ['controller', 'apiserver'],
          flights: [
            {
              key: `${p.id}:3`,
              tokens: p.victims.map((v, i) => ({
                id: `${p.id}-pod-${i}`,
                term: 'Pod',
                color: v.color,
              })),
              fromSel: '[data-fly="controller"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 4:
        return {
          focus: ['scheduler', 'apiserver', ...new Set(placed.map((v) => v.placement))],
          flights: placed.map((v, i) => ({
            key: `${p.id}:4:${i}`,
            tokens: [{ id: `${p.id}-pl-${i}`, term: 'Pod', color: v.color }],
            fromSel: '[data-fly="apiserver"]',
            toSel: `[data-fly="${v.placement}"]`,
          })),
        }
      case 5:
        return { focus: [p.node], flights: [] }
      default:
        return { focus: [], flights: [] }
    }
  },

  duration: flightAwareDuration(CRASH_STEPS),
}

export const recoverNode = {
  type: 'recoverNode',
  label: 'scenario: recover node',
  steps: RECOVER_STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    if (s >= 1) {
      c.nodes[p.node] = { ...c.nodes[p.node], ready: true }
      c.events.push({
        id: `${p.id}-e-ready`,
        type: 'Normal',
        reason: 'NodeReady',
        obj: `node/${p.node}`,
        message: `Node ${p.node} status is now: NodeReady`,
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
        return { focus: [p.node, `kubelet:${p.node}`], flights: [] }
      case 1:
        return { focus: ['controller', 'apiserver', p.node], flights: [] }
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
        return { focus: [p.node], flights: [] }
      default:
        return { focus: [], flights: [] }
    }
  },

  duration: flightAwareDuration(RECOVER_STEPS),
}
