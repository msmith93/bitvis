import { useEffect, useRef, useState } from 'react'
import {
  initialCluster,
  planPlacements,
  podsOfRs,
  podSuffix,
  rsHash,
} from './cluster'
import { formatGet, HELP_LINES, parseCommand } from './kubectl'
import { OPS, stepsFor } from './ops'
import { useOpLifecycle } from './useOpLifecycle'
import ClusterStage from './components/ClusterStage'
import SidePanel from './components/SidePanel'
import Stepper from './components/Stepper'
import Terminal from './components/Terminal'

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
  const seq = useRef({ line: 0, op: 0, name: 0, dep: 0 })
  const printed = useRef(new Set())

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
  if (presetBase.events.length > 0)
    presets.push({ label: 'get events', cmd: 'kubectl get events' })

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
          <ClusterStage cluster={life.derived} extra={life.extra} />
        </div>
        <SidePanel cluster={life.derived} op={life.op} />
      </div>

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

      <Terminal
        lines={lines}
        onCommand={handleCommand}
        disabled={!life.canStartNew}
        presets={presets}
      />
    </div>
  )
}
