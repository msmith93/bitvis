import { forwardRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WORKER_NODES } from '../cluster'
import { POD_APPEAR_DELAY_S } from '../timing'
import ChipFlight from './ChipFlight'

// The centre stage: the control plane (four actor boxes + the unscheduled-pod
// tray) above the three worker-node columns. Highlights and chip flights are
// driven entirely by the current op's extra() — the derived cluster is the
// single source of what exists; extra says what glows and what flies.
export default function ClusterStage({ cluster, extra }) {
  const focus = new Set(extra.focus ?? [])
  const flights = extra.flights ?? []
  const pods = Object.values(cluster.pods)
  const pendingPods = pods.filter((p) => !p.node)

  return (
    <div className="stage">
      <div className="control-plane">
        <div className="cp-head">
          <span className="cp-title">control plane</span>
          <span className="cp-sub">every arrow goes through the API server</span>
        </div>
        <div className="cp-actors">
          <ActorBox
            id="apiserver"
            label="kube-apiserver"
            sub="the only front door"
            active={focus.has('apiserver')}
          />
          <ActorBox
            id="etcd"
            label="etcd"
            sub="state of record"
            active={focus.has('etcd')}
          />
          <ActorBox
            id="scheduler"
            label="kube-scheduler"
            sub="binds pods to nodes"
            active={focus.has('scheduler')}
          />
          <ActorBox
            id="controller"
            label="controller-manager"
            sub="reconciliation loops"
            active={focus.has('controller')}
          />
        </div>
        <div
          className={'pending-tray' + (focus.has('tray') ? ' active' : '')}
          data-fly="tray"
        >
          <span className="tray-label">
            unscheduled pods · no node assigned
          </span>
          <div className="tray-chips">
            <AnimatePresence mode="popLayout">
              {pendingPods.length === 0 && (
                <span className="empty-note">none</span>
              )}
              {pendingPods.map((p) => (
                <PodChip key={p.name} pod={p} />
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <div className="nodes-row">
        {WORKER_NODES.map((w) => (
          <NodeCol
            key={w.id}
            node={w}
            pods={pods.filter((p) => p.node === w.id)}
            active={focus.has(w.id)}
            kubeletActive={focus.has(`kubelet:${w.id}`)}
          />
        ))}
      </div>

      {flights.map((f) => (
        <ChipFlight
          key={f.key}
          tokens={f.tokens}
          fromSel={f.fromSel}
          toSel={f.toSel}
        />
      ))}
    </div>
  )
}

function ActorBox({ id, label, sub, active }) {
  return (
    <div className={'actor-box' + (active ? ' active' : '')} data-fly={id}>
      <span className="actor-label">{label}</span>
      <span className="actor-sub">{sub}</span>
    </div>
  )
}

function NodeCol({ node, pods, active, kubeletActive }) {
  return (
    <div
      className={'node-col' + (active || kubeletActive ? ' active' : '')}
      data-fly={node.id}
    >
      <div className="node-head">
        <span className="node-name">{node.name}</span>
        <span className={'kubelet-badge' + (kubeletActive ? ' active' : '')}>
          kubelet
        </span>
      </div>
      <div className="pod-slots">
        <AnimatePresence mode="popLayout">
          {pods.length === 0 && <span className="empty-note">no pods</span>}
          {pods.map((p) => (
            <PodChip key={p.name} pod={p} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

// One pod. Appears with a small delay so a chip seems to materialize as the
// flight that "delivered" it lands (see POD_APPEAR_DELAY_S). forwardRef
// because AnimatePresence popLayout measures exiting children via ref.
const PodChip = forwardRef(function PodChip({ pod }, ref) {
  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.45 } }}
      transition={{
        type: 'spring',
        stiffness: 300,
        damping: 26,
        delay: POD_APPEAR_DELAY_S,
      }}
      className={'pod-chip phase-' + pod.phase.toLowerCase()}
      style={{ '--pod-color': pod.color || 'var(--accent)' }}
    >
      <span className="pod-name">{pod.name}</span>
      <span className="pod-phase">
        <span className="phase-dot" />
        {pod.phase}
        {pod.phase === 'ContainerCreating' && <span className="pulling"> · pulling {pod.image}</span>}
      </span>
    </motion.div>
  )
})
