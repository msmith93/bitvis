// The `upgradeNode` scenario: the part of a node upgrade kubectl CANNOT do.
// Upgrading a kubelet happens on the machine (package manager, new AMI, new
// VM) — outside the Kubernetes API. That is why the scenario button only
// enables once a node is drained (cordoned + empty), and why the flow ends by
// telling you to run kubectl uncordon. Payload:
//   { id, ts, node, fromVersion, toVersion }

const STEPS = [
  {
    key: 'ready',
    ms: 2300,
    title: '1 · Drained and safe to touch',
    blurb:
      'The node is cordoned and empty — that is what drain bought us: no workload can be disrupted by what happens next. Note that everything from here on happens OUTSIDE the Kubernetes API; kubectl has no “upgrade” verb.',
  },
  {
    key: 'upgrade',
    ms: 2500,
    title: '2 · The kubelet is upgraded on the machine',
    blurb:
      'An operator (or your cloud provider) upgrades the node: new kubelet binary, new container runtime, maybe a whole new machine image. The node briefly drops out while its kubelet restarts. Control-plane components are upgraded the same way, one node at a time — that is why Kubernetes tolerates version skew.',
  },
  {
    key: 'rejoin',
    ms: 2300,
    title: '3 · Rejoins at the new version — still cordoned',
    blurb:
      'The upgraded kubelet reconnects and reports its new version (check kubectl get nodes: the cluster now runs mixed versions, which is normal mid-upgrade). The node is Ready but STILL SchedulingDisabled — the cordon survives reboots; it is desired state in etcd, not machine state.',
  },
  {
    key: 'next',
    ms: 2400,
    title: '4 · Finish with kubectl uncordon',
    blurb:
      'One command remains, and it IS a kubectl command: kubectl uncordon puts the node back in the scheduler’s pool. Repeat drain → upgrade → uncordon across the fleet, one node at a time, and you have a zero-downtime cluster upgrade.',
  },
]

export default {
  type: 'upgradeNode',
  label: 'scenario: upgrade node',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    if (s === 1) c.nodes[p.node] = { ...c.nodes[p.node], ready: false }
    if (s >= 2) {
      c.nodes[p.node] = {
        ...c.nodes[p.node],
        ready: true,
        version: p.toVersion,
      }
      c.events.push({
        id: `${p.id}-e-upgraded`,
        type: 'Normal',
        reason: 'NodeReady',
        obj: `node/${p.node}`,
        message: `Node ${p.node} rejoined at ${p.toVersion} (was ${p.fromVersion})`,
      })
    }
  },

  extra(cluster, op) {
    const p = op.payload
    switch (op.step) {
      case 0:
        return { focus: [p.node], flights: [] }
      case 1:
        return { focus: [p.node, `kubelet:${p.node}`], flights: [] }
      case 2:
        return { focus: ['apiserver', p.node, `kubelet:${p.node}`], flights: [] }
      case 3:
        return { focus: ['kubectl', p.node], flights: [] }
      default:
        return { focus: [], flights: [] }
    }
  },
}
