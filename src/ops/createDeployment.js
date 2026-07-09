// The `createDeployment` op: the marquee choreography. A kubectl request
// becomes desired state in etcd, and the control plane's reconciliation loops
// (deployment controller → replicaset controller → scheduler → kubelet) turn
// that intent into running pods. Payload precomputes every name and placement
// at start-time so derive() is pure and the op can be scrubbed:
//   { id, ts, name, image, replicas, color, rsName, podNames, placements }

import { flightAwareDuration } from './shared'

const STEPS = [
  {
    key: 'request',
    ms: 2100,
    title: '1 · kubectl → API server',
    blurb:
      'kubectl sends an HTTP request to the kube-apiserver — the cluster’s only front door. Every component, human or machine, talks to the cluster exclusively through the API server. The request is declarative: “a Deployment that keeps N replicas of this image running should exist.” It does not say how.',
  },
  {
    key: 'persist',
    ms: 2100,
    title: '2 · Desired state recorded in etcd',
    blurb:
      'The API server validates the request and writes the Deployment object into etcd, the cluster’s store of record. Only the API server ever reads or writes etcd. Note what has NOT happened: no container is running anywhere. Kubernetes has merely recorded intent.',
  },
  {
    key: 'deploy-controller',
    ms: 2300,
    title: '3 · Deployment controller creates a ReplicaSet',
    blurb:
      'Inside the controller-manager, the Deployment controller’s watch fires: this Deployment should own 1 ReplicaSet, but 0 exist. It creates one — through the API server, like everything else. Controllers never talk to each other or to nodes; each one just compares desired vs actual and issues corrections.',
  },
  {
    key: 'rs-controller',
    ms: 1900,
    title: '4 · ReplicaSet controller creates Pods',
    blurb:
      'The ReplicaSet controller sees desired = N pods, actual = 0, and creates N Pod objects. They are Pending: records in etcd with no node assigned — see them in the cluster-state panel, and the scheduler’s “waiting” counter. A Pod object is a promise, not a process.',
  },
  {
    key: 'schedule',
    ms: 1900,
    title: '5 · Scheduler binds each Pod to a node',
    blurb:
      'The kube-scheduler watches for Pods with no nodeName. For each one it filters the nodes — the control-plane node is excluded by its NoSchedule taint — then scores the survivors (here: least loaded wins) and writes the chosen nodeName back through the API server. That is ALL the scheduler does — it decides placement; it never starts anything.',
  },
  {
    key: 'kubelet',
    ms: 2400,
    title: '6 · Kubelet pulls the image and starts containers',
    blurb:
      'Each worker’s kubelet watches the API server for Pods bound to its node. Seeing new ones, it pulls the container image and starts the containers — ContainerCreating. The kubelet is the only component that actually runs workloads.',
  },
  {
    key: 'running',
    ms: 2300,
    title: '7 · Running — actual state matches desired state',
    blurb:
      'The kubelets report status back up to the API server: all pods Running. The reconciliation loop is now closed — and it never stops watching. Kill a pod and the ReplicaSet controller will notice the drift and correct it. Try it: kubectl delete pod <name>.',
  },
]

// Which control-plane / node actors glow, and which chip flights run, per step.
function choreography(op) {
  const p = op.payload
  const podChips = p.podNames.map((n, i) => ({
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
            tokens: [{ id: `${p.id}-req`, term: 'Deployment', color: p.color }],
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
            tokens: [{ id: `${p.id}-dep`, term: `deploy/${p.name}`, color: p.color }],
            fromSel: '[data-fly="apiserver"]',
            toSel: '[data-fly="etcd"]',
          },
        ],
      }
    case 2:
      return {
        focus: ['controller', 'apiserver', 'etcd'],
        flights: [
          {
            key: `${p.id}:2`,
            tokens: [{ id: `${p.id}-rs`, term: `rs/${p.rsName}`, color: p.color }],
            fromSel: '[data-fly="controller"]',
            toSel: '[data-fly="apiserver"]',
          },
        ],
      }
    case 3:
      return {
        focus: ['controller', 'apiserver'],
        flights: [
          {
            key: `${p.id}:3`,
            tokens: podChips,
            fromSel: '[data-fly="controller"]',
            toSel: '[data-fly="apiserver"]',
          },
        ],
      }
    case 4:
      return {
        focus: ['scheduler', 'apiserver', ...new Set(p.placements)],
        flights: p.placements.map((node, i) => ({
          key: `${p.id}:4:${i}`,
          tokens: [podChips[i]],
          fromSel: '[data-fly="apiserver"]',
          toSel: `[data-fly="${node}"]`,
        })),
      }
    case 5:
      return {
        focus: [...new Set(p.placements.map((n) => `kubelet:${n}`))],
        flights: [],
      }
    case 6:
      return {
        focus: ['apiserver', ...new Set(p.placements)],
        flights: [],
      }
    default:
      return { focus: [], flights: [] }
  }
}

export default {
  type: 'createDeployment',
  label: 'kubectl create deployment',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload

    if (s >= 1) {
      c.deployments[p.name] = {
        name: p.name,
        image: p.image,
        replicas: p.replicas,
        rsName: p.rsName,
        color: p.color,
        createdAt: p.ts,
      }
    }
    if (s >= 2) {
      c.replicaSets[p.rsName] = {
        name: p.rsName,
        deployment: p.name,
        image: p.image,
        replicas: p.replicas,
        createdAt: p.ts,
      }
      c.events.push({
        id: `${p.id}-e-rs`,
        type: 'Normal',
        reason: 'ScalingReplicaSet',
        obj: `deployment/${p.name}`,
        message: `Scaled up replica set ${p.rsName} to ${p.replicas}`,
      })
    }
    if (s >= 3) {
      p.podNames.forEach((pn, i) => {
        c.pods[pn] = {
          name: pn,
          rs: p.rsName,
          deployment: p.name,
          image: p.image,
          color: p.color,
          node: s >= 4 ? p.placements[i] : null,
          phase: s >= 6 ? 'Running' : s >= 5 ? 'ContainerCreating' : 'Pending',
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
    if (s >= 4)
      p.podNames.forEach((pn, i) =>
        c.events.push({
          id: `${p.id}-e-sched-${i}`,
          type: 'Normal',
          reason: 'Scheduled',
          obj: `pod/${pn}`,
          message: `Successfully assigned default/${pn} to ${p.placements[i]}`,
        }),
      )
    if (s >= 5)
      p.podNames.forEach((pn, i) =>
        c.events.push({
          id: `${p.id}-e-pull-${i}`,
          type: 'Normal',
          reason: 'Pulling',
          obj: `pod/${pn}`,
          message: `Pulling image "${p.image}"`,
        }),
      )
    if (s >= 6)
      p.podNames.forEach((pn, i) =>
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
    return choreography(op)
  },

  duration: flightAwareDuration(STEPS),
}
