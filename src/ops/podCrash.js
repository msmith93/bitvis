// The `podCrash` scenario: a container process dies. The essential lesson is
// WHO fixes it — the kubelet, locally, because of the pod's restartPolicy.
// The ReplicaSet controller never stirs: the Pod object still exists, so
// desired == actual the whole time. Contrast with `kubectl delete pod`,
// where the object vanishes and the RS must manufacture a NEW pod. Payload:
//   { id, ts, podName, node }

const STEPS = [
  {
    key: 'crash',
    ms: 2300,
    title: '1 · The container process exits',
    blurb:
      'Something inside the container dies — a panic, an OOM kill, exit 1. Watch what does NOT happen: the Pod object still exists in etcd, so the ReplicaSet controller sees desired == actual and does nothing. This is not its problem.',
  },
  {
    key: 'kubelet',
    ms: 2400,
    title: '2 · The kubelet notices — locally',
    blurb:
      'The kubelet on this node supervises its containers directly. The pod’s restartPolicy is Always (the Deployment default), so the kubelet will restart the container itself — no API-server round-trip, no scheduler, no controller. Repeated crashes earn an increasing backoff delay: that is the famous CrashLoopBackOff.',
  },
  {
    key: 'restart',
    ms: 2200,
    title: '3 · Restarted in place',
    blurb:
      'The kubelet starts a fresh container in the SAME pod — same name, same node, same IP. Nothing was rescheduled; nothing was replaced. The image is already on the node, so this is fast.',
  },
  {
    key: 'settled',
    ms: 2300,
    title: '4 · Running again, restart count +1',
    blurb:
      'The kubelet reports the restart up to the API server — check the RESTARTS column in kubectl get pods. Restarts are pod-local self-healing by the kubelet; replacements (delete, eviction, node failure) are cluster-level self-healing by controllers. Two different loops, two different actors.',
  },
]

export default {
  type: 'podCrash',
  label: 'scenario: pod crash',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    const pod = c.pods[p.podName]
    if (!pod) return
    if (s >= 3) {
      c.pods[p.podName] = {
        ...pod,
        phase: 'Running',
        restarts: pod.restarts + 1,
      }
    } else if (s >= 2) {
      c.pods[p.podName] = { ...pod, phase: 'ContainerCreating' }
    } else if (s >= 0) {
      c.pods[p.podName] = { ...pod, phase: 'CrashLoopBackOff' }
    }
    if (s >= 1)
      c.events.push({
        id: `${p.id}-e-backoff`,
        type: 'Warning',
        reason: 'BackOff',
        obj: `pod/${p.podName}`,
        message: 'Back-off restarting failed container',
      })
    if (s >= 3)
      c.events.push({
        id: `${p.id}-e-started`,
        type: 'Normal',
        reason: 'Started',
        obj: `pod/${p.podName}`,
        message: 'Started container (restart)',
      })
  },

  extra(cluster, op) {
    const p = op.payload
    switch (op.step) {
      case 0:
        return { focus: [p.node], flights: [] }
      case 1:
        return { focus: [`kubelet:${p.node}`], flights: [] }
      case 2:
        return { focus: [`kubelet:${p.node}`, p.node], flights: [] }
      case 3:
        return { focus: ['apiserver', p.node], flights: [] }
      default:
        return { focus: [], flights: [] }
    }
  },
}
