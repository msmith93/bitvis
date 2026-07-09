import { useEffect, useRef, useState } from 'react'
import {
  initialCluster,
  planPlacements,
  podsOfRs,
  podsOnNode,
  podSuffix,
  rsHash,
  stuckPendingPods,
  UPGRADED_VERSION,
  WORKER_NODES,
} from './cluster'
import { formatGet, HELP_LINES, parseCommand } from './kubectl'
import { OPS, stepsFor } from './ops'
import { useOpLifecycle } from './useOpLifecycle'
import { useTraffic } from './useTraffic'
import ClusterStage from './components/ClusterStage'
import RequestFlight from './components/RequestFlight'
import ScenarioBar from './components/ScenarioBar'
import SidePanel from './components/SidePanel'
import Stepper from './components/Stepper'
import Terminal from './components/Terminal'
import TrafficRail from './components/TrafficRail'

// A copy of the cluster with one node's state patched — used to plan
// placements for the world an op is ABOUT to create (e.g. where do evicted
// pods land once this node counts as cordoned?).
const withNode = (c, nodeId, patch) => ({
  ...c,
  nodes: { ...c.nodes, [nodeId]: { ...c.nodes[nodeId], ...patch } },
})

// One color per deployment; its ReplicaSet's pods inherit it so you can track
// ownership on the stage at a glance (opensearchvis's doc colors).
const DEPLOYMENT_COLORS = [
  '#7aa2ff',
  '#59c2a5',
  '#e0a04a',
  '#c792ea',
  '#e05a7a',
  '#4ec9d4',
]

const WELCOME = [
  'kubevis — a simulated Kubernetes cluster. Nothing here is real; every',
  'component is animated so you can watch what the control plane does.',
  'Type "help" for the supported commands, or click a preset above.',
]

// App owns UI state only: terminal scrollback, naming counters, presets.
// Everything cluster-shaped lives in useOpLifecycle; see src/ops/.
export default function App() {
  const life = useOpLifecycle(initialCluster)
  const [lines, setLines] = useState(() =>
    WELCOME.map((text, i) => ({ id: `w${i}`, kind: 'info', text })),
  )
  // Monotonic counters for line ids, op ids, names, colors. Refs (not state):
  // they must tick inside event handlers without re-rendering, and payloads
  // capture their values at start-time so scrubbing never regenerates names.
  const seq = useRef({ line: 0, op: 0, name: 0, dep: 0, svc: 1 })
  const printed = useRef(new Set())
  const traffic = useTraffic(life.derived)

  function appendLines(entries) {
    setLines((ls) => [
      ...ls,
      ...entries.map((e) => ({ id: `l${seq.current.line++}`, ...e })),
    ])
  }

  // Print a finished `get` op's table exactly once (scrub-proof via op id).
  useEffect(() => {
    const op = life.op
    if (
      op?.type === 'get' &&
      life.opDone &&
      !printed.current.has(op.payload.id)
    ) {
      printed.current.add(op.payload.id)
      appendLines(op.payload.table.map((text) => ({ kind: 'out', text })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [life.op, life.opDone])

  function handleCommand(cmd) {
    appendLines([{ kind: 'cmd', text: cmd }])
    if (!life.canStartNew) {
      appendLines([
        { kind: 'err', text: 'an operation is still in progress — press ▶ or Next to finish it' },
      ])
      return
    }
    const base = life.base
    const parsed = parseCommand(cmd, base)
    const opId = () => `op${seq.current.op++}`

    switch (parsed.kind) {
      case 'noop':
        return
      case 'help':
        appendLines(HELP_LINES.map((text) => ({ kind: 'info', text })))
        return
      case 'clear':
        setLines([])
        return
      case 'error':
        appendLines([{ kind: 'err', text: parsed.message }])
        return

      case 'get': {
        life.start('get', {
          id: opId(),
          resource: parsed.resource,
          table: formatGet(parsed.resource, base),
        })
        return
      }

      case 'create': {
        const { name, image, replicas } = parsed
        const rsName = `${name}-${rsHash(seq.current.name++)}`
        const podNames = Array.from(
          { length: replicas },
          () => `${rsName}-${podSuffix(seq.current.name++)}`,
        )
        appendLines([{ kind: 'out', text: `deployment.apps/${name} created` }])
        life.start('createDeployment', {
          id: opId(),
          ts: Date.now(),
          name,
          image,
          replicas,
          color: DEPLOYMENT_COLORS[seq.current.dep++ % DEPLOYMENT_COLORS.length],
          rsName,
          podNames,
          placements: planPlacements(base, replicas),
        })
        return
      }

      case 'scale': {
        const { name, replicas, from } = parsed
        const dep = base.deployments[name]
        appendLines([{ kind: 'out', text: `deployment.apps/${name} scaled` }])
        if (replicas === from) {
          appendLines([
            { kind: 'info', text: `(already at ${from} replicas — desired state unchanged, so the controllers have nothing to do)` },
          ])
          return
        }
        if (replicas > from) {
          const count = replicas - from
          const newPodNames = Array.from(
            { length: count },
            () => `${dep.rsName}-${podSuffix(seq.current.name++)}`,
          )
          life.start('scaleUp', {
            id: opId(),
            ts: Date.now(),
            name,
            rsName: dep.rsName,
            image: dep.image,
            color: dep.color,
            from,
            to: replicas,
            newPodNames,
            placements: planPlacements(base, count),
          })
        } else {
          // Victims: the youngest pods of the ReplicaSet (insertion order).
          const victims = podsOfRs(base, dep.rsName)
            .slice(replicas)
            .map((p) => p.name)
          life.start('scaleDown', {
            id: opId(),
            ts: Date.now(),
            name,
            rsName: dep.rsName,
            from,
            to: replicas,
            victims,
          })
        }
        return
      }

      case 'info':
        appendLines([{ kind: 'out', text: parsed.message }])
        return

      case 'expose': {
        appendLines([{ kind: 'out', text: `service/${parsed.name} exposed` }])
        life.start('expose', {
          id: opId(),
          ts: Date.now(),
          name: parsed.name,
          port: parsed.port,
          clusterIP: `10.96.0.${seq.current.svc++}`,
        })
        return
      }

      case 'createIngress': {
        appendLines([
          { kind: 'out', text: `ingress.networking.k8s.io/${parsed.name} created` },
        ])
        life.start('createIngress', {
          id: opId(),
          ts: Date.now(),
          name: parsed.name,
          host: parsed.host,
          path: parsed.path,
          serviceName: parsed.serviceName,
          servicePort: parsed.servicePort,
        })
        return
      }

      case 'deleteService': {
        appendLines([{ kind: 'out', text: `service "${parsed.name}" deleted` }])
        life.start('deleteService', { id: opId(), ts: Date.now(), name: parsed.name })
        return
      }

      case 'deleteIngress': {
        appendLines([
          { kind: 'out', text: `ingress.networking.k8s.io "${parsed.name}" deleted` },
        ])
        life.start('deleteIngress', { id: opId(), ts: Date.now(), name: parsed.name })
        return
      }

      case 'cordon': {
        appendLines([{ kind: 'out', text: `node/${parsed.node} cordoned` }])
        life.start('cordon', { id: opId(), ts: Date.now(), node: parsed.node })
        return
      }

      case 'uncordon': {
        appendLines([{ kind: 'out', text: `node/${parsed.node} uncordoned` }])
        // Plan against the world where this node is schedulable again — that's
        // what the scheduler will see when it re-evaluates the stuck pods.
        const hypo = withNode(base, parsed.node, { unschedulable: false })
        const stuck = stuckPendingPods(base)
        const placements = planPlacements(hypo, stuck.length)
        life.start('uncordon', {
          id: opId(),
          ts: Date.now(),
          node: parsed.node,
          stuckPods: stuck.map((p, i) => ({
            name: p.name,
            placement: placements[i],
          })),
        })
        return
      }

      case 'drain': {
        const victims = podsOnNode(base, parsed.node)
        appendLines([
          { kind: 'out', text: `node/${parsed.node} cordoned` },
          ...victims.map((v) => ({
            kind: 'out',
            text: `evicting pod default/${v.name}`,
          })),
        ])
        const hypo = withNode(base, parsed.node, { unschedulable: true })
        const placements = planPlacements(
          hypo,
          victims.length,
          victims.map((v) => v.name),
        )
        life.start('drain', {
          id: opId(),
          ts: Date.now(),
          node: parsed.node,
          victims: victims.map((v, i) => ({
            name: v.name,
            rsName: v.rs,
            deployment: v.deployment,
            image: v.image,
            color: v.color,
            newName: `${v.rs}-${podSuffix(seq.current.name++)}`,
            placement: placements[i],
          })),
        })
        return
      }

      case 'deletePod': {
        const pod = base.pods[parsed.podName]
        appendLines([{ kind: 'out', text: `pod "${pod.name}" deleted` }])
        life.start('deletePod', {
          id: opId(),
          ts: Date.now(),
          podName: pod.name,
          node: pod.node,
          rsName: pod.rs,
          deployment: pod.deployment,
          image: pod.image,
          color: pod.color,
          newPodName: `${pod.rs}-${podSuffix(seq.current.name++)}`,
          placement: planPlacements(base, 1, pod.name)[0],
        })
        return
      }
    }
  }

  function resetCluster() {
    life.resetTo(initialCluster())
    printed.current.clear()
    setLines([
      { id: `l${seq.current.line++}`, kind: 'info', text: 'cluster reset — empty again' },
    ])
  }

  // Presets adapt to what exists so the demo path is always one click away.
  const presetBase = life.base ?? life.derived
  const firstDep = Object.values(presetBase.deployments)[0]
  const firstRunningPod = Object.values(presetBase.pods).find(
    (p) => p.phase === 'Running',
  )
  const presets = []
  if (!presetBase.deployments.web)
    presets.push({
      label: 'create deployment',
      cmd: 'kubectl create deployment web --image=nginx --replicas=3',
    })
  presets.push({ label: 'get pods', cmd: 'kubectl get pods' })
  if (firstDep)
    presets.push({
      label: `scale to ${firstDep.replicas >= 5 ? 2 : 5}`,
      cmd: `kubectl scale deployment ${firstDep.name} --replicas=${firstDep.replicas >= 5 ? 2 : 5}`,
    })
  if (firstRunningPod)
    presets.push({
      label: 'delete a pod',
      cmd: `kubectl delete pod ${firstRunningPod.name}`,
    })
  const workerStates = WORKER_NODES.map((w) => presetBase.nodes[w.id])
  const drainCandidate = workerStates
    .filter((n) => n.ready && !n.unschedulable)
    .sort(
      (a, b) =>
        podsOnNode(presetBase, b.id).length - podsOnNode(presetBase, a.id).length,
    )[0]
  const cordonedNode = workerStates.find((n) => n.ready && n.unschedulable)
  if (drainCandidate && podsOnNode(presetBase, drainCandidate.id).length > 0)
    presets.push({
      label: `drain ${drainCandidate.id}`,
      cmd: `kubectl drain ${drainCandidate.id} --ignore-daemonsets`,
    })
  if (cordonedNode)
    presets.push({
      label: `uncordon ${cordonedNode.id}`,
      cmd: `kubectl uncordon ${cordonedNode.id}`,
    })
  if (firstDep && !presetBase.services[firstDep.name])
    presets.push({
      label: `expose ${firstDep.name}`,
      cmd: `kubectl expose deployment ${firstDep.name} --port=80`,
    })
  const firstSvc = Object.values(presetBase.services)[0]
  if (firstSvc && Object.keys(presetBase.ingresses).length === 0)
    presets.push({
      label: 'create ingress',
      cmd: `kubectl create ingress ${firstSvc.name} --rule=demo.kubevis.dev/*=${firstSvc.name}:${firstSvc.port}`,
    })
  if (workerStates.some((n) => !n.ready || n.unschedulable))
    presets.push({ label: 'get nodes', cmd: 'kubectl get nodes' })
  if (presetBase.events.length > 0)
    presets.push({ label: 'get events', cmd: 'kubectl get events' })

  // ---- scenarios (the simulate bar) — targets picked at click time --------
  const runningPods = Object.values(presetBase.pods).filter(
    (p) => p.phase === 'Running',
  )
  const notReadyNode = workerStates.find((n) => !n.ready)
  const drainedNode = workerStates.find(
    (n) =>
      n.ready &&
      n.unschedulable &&
      n.version !== UPGRADED_VERSION &&
      podsOnNode(presetBase, n.id).length === 0,
  )

  const scenarioOp = (type, payload, echo) => {
    appendLines([{ kind: 'info', text: echo }])
    life.start(type, { id: `op${seq.current.op++}`, ts: Date.now(), ...payload })
  }

  const scenarios = [
    {
      key: 'podCrash',
      icon: '⚡',
      label: 'Pod Crash',
      enabled: runningPods.length > 0,
      tooltip:
        'A container process exits — the kubelet restarts it in place. No scheduler, no ReplicaSet.',
      run: () => {
        const pods = Object.values(life.base.pods).filter(
          (p) => p.phase === 'Running',
        )
        const pod = pods[Math.floor(Math.random() * pods.length)]
        scenarioOp(
          'podCrash',
          { podName: pod.name, node: pod.node },
          `⚡ scenario: container crash in ${pod.name} on ${pod.node}`,
        )
      },
    },
    {
      key: 'nodeCrash',
      icon: '💥',
      label: 'Node Crash',
      enabled: workerStates.some((n) => n.ready),
      tooltip:
        'A worker goes silent — node controller marks it NotReady, its pods are replaced elsewhere. Stays down until recovered.',
      run: () => {
        const base = life.base
        const candidates = WORKER_NODES.map((w) => base.nodes[w.id]).filter(
          (n) => n.ready,
        )
        let target = candidates[0]
        for (const n of candidates)
          if (podsOnNode(base, n.id).length > podsOnNode(base, target.id).length)
            target = n
        const victims = podsOnNode(base, target.id)
        const placements = planPlacements(
          withNode(base, target.id, { ready: false }),
          victims.length,
          victims.map((v) => v.name),
        )
        scenarioOp(
          'nodeCrash',
          {
            node: target.id,
            victims: victims.map((v, i) => ({
              name: v.name,
              rsName: v.rs,
              deployment: v.deployment,
              image: v.image,
              color: v.color,
              newName: `${v.rs}-${podSuffix(seq.current.name++)}`,
              placement: placements[i],
            })),
          },
          `💥 scenario: ${target.id} crashed with ${victims.length} pod${victims.length === 1 ? '' : 's'} on it`,
        )
      },
    },
    {
      key: 'recover',
      icon: '♻',
      label: 'Recover Node',
      enabled: !!notReadyNode,
      tooltip: notReadyNode
        ? `Reboot ${notReadyNode.id} — it rejoins empty; pods never move back.`
        : 'No node is down. Crash one first.',
      run: () => {
        const base = life.base
        const target = WORKER_NODES.map((w) => base.nodes[w.id]).find(
          (n) => !n.ready,
        )
        const stuck = stuckPendingPods(base)
        const placements = planPlacements(
          withNode(base, target.id, { ready: true }),
          stuck.length,
        )
        scenarioOp(
          'recoverNode',
          {
            node: target.id,
            stuckPods: stuck.map((p, i) => ({
              name: p.name,
              placement: placements[i],
            })),
          },
          `♻ scenario: ${target.id} rebooted and rejoining the cluster`,
        )
      },
    },
    {
      key: 'upgrade',
      icon: '⬆',
      label: 'Upgrade Node',
      enabled: !!drainedNode,
      tooltip: drainedNode
        ? `Upgrade ${drainedNode.id}'s kubelet to ${UPGRADED_VERSION} — it's drained, so nothing can be disrupted.`
        : 'Needs a drained node: kubectl drain <node> first (upgrades happen outside kubectl).',
      run: () => {
        const base = life.base
        const target = WORKER_NODES.map((w) => base.nodes[w.id]).find(
          (n) =>
            n.ready &&
            n.unschedulable &&
            n.version !== UPGRADED_VERSION &&
            podsOnNode(base, n.id).length === 0,
        )
        scenarioOp(
          'upgradeNode',
          {
            node: target.id,
            fromVersion: target.version,
            toVersion: UPGRADED_VERSION,
          },
          `⬆ scenario: upgrading kubelet on ${target.id} to ${UPGRADED_VERSION}`,
        )
      },
    },
  ]

  return (
    <div className="app">
      <header className="topbar">
        <h1>kubevis</h1>
        <span className="sub">
          how a kubectl command becomes running pods — every step of the control plane
        </span>
        <button className="btn reset-btn" onClick={resetCluster}>
          ↺ Reset cluster
        </button>
      </header>

      <div className="main">
        <div className="stage-col">
          <ScenarioBar scenarios={scenarios} disabled={!life.canStartNew} />
          <TrafficRail
            cluster={life.derived}
            traffic={traffic}
            focus={new Set(life.extra.focus ?? [])}
          />
          <ClusterStage cluster={life.derived} extra={life.extra} />
          {traffic.flights.map((f) => (
            <RequestFlight key={f.id} flight={f} />
          ))}
        </div>
        <SidePanel cluster={life.derived} op={life.op} />
      </div>

      <Terminal
        lines={lines}
        onCommand={handleCommand}
        disabled={!life.canStartNew}
        presets={presets}
      />

      <Stepper
        steps={life.op ? stepsFor(life.op.type) : []}
        step={life.op?.step ?? 0}
        opLabel={life.op ? OPS[life.op.type].label : ''}
        playing={life.playing}
        onPrev={() => life.step(-1)}
        onNext={() => life.step(1)}
        onPlay={life.play}
        onPause={life.pause}
      />
    </div>
  )
}
