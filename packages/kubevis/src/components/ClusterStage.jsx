import { forwardRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WORKER_NODES } from '../cluster'
import { POD_APPEAR_DELAY_S } from '../timing'
import ChipFlight from './ChipFlight'

// The centre stage: one row of four node columns — the control-plane node
// (its four static-pod actor boxes stacked inside) then the three workers.
// Unscheduled pods appear ONLY in the side panel's etcd tree plus a "waiting"
// counter on the kube-scheduler box: a pod with no node is just a record.
// Highlights and chip flights are driven entirely by the current op's
// extra() — the derived cluster is the single source of what exists; extra
// says what glows and what flies.
export default function ClusterStage({ cluster, extra }) {
  const focus = new Set(extra.focus ?? [])
  const flights = extra.flights ?? []
  const pods = Object.values(cluster.pods)
  const pendingPods = pods.filter((p) => !p.node)
  const cpActive = ['apiserver', 'etcd', 'scheduler', 'controller'].some((id) =>
    focus.has(id),
  )

  return (
    <div className="stage">
      <div className="nodes-row">
        <div className={'node-col control-plane' + (cpActive ? ' active' : '')}>
          <div className="node-head">
            <span className="head-group">
              <span className="node-name">control-plane</span>
            </span>
            <span className="kubelet-badge">kubelet</span>
          </div>
          <div className="badge-row">
            <span className="role-badge">control plane</span>
            <span
              className="taint-badge"
              title="node-role.kubernetes.io/control-plane:NoSchedule — the scheduler filters this node out for user workloads"
            >
              taint: NoSchedule
            </span>
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
              pill={
                pendingPods.length > 0
                  ? `${pendingPods.length} waiting`
                  : undefined
              }
              pillTitle="Pod objects with no node assigned — they exist only in etcd until the scheduler can place them (see the cluster-state panel)"
            />
            <ActorBox
              id="controller"
              label="controller-manager"
              sub="reconciliation loops"
              active={focus.has('controller')}
            />
          </div>
        </div>

        {WORKER_NODES.map((w) => (
          <NodeCol
            key={w.id}
            node={w}
            state={cluster.nodes[w.id]}
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

// In a kubeadm-style cluster these components are static pods on the
// control-plane node, run by its kubelet directly from manifest files —
// the API server can't schedule itself into existence.
function ActorBox({ id, label, sub, active, pill, pillTitle }) {
  return (
    <div className={'actor-box' + (active ? ' active' : '')} data-fly={id}>
      <span className="actor-label-row">
        <span className="actor-label">{label}</span>
        <span className="static-pod-tag">static pod</span>
      </span>
      <span className="actor-sub">
        {sub}
        {pill && (
          <span className="waiting-pill" title={pillTitle}>
            {pill}
          </span>
        )}
      </span>
    </div>
  )
}

function NodeCol({ node, state, pods, active, kubeletActive }) {
  const down = state && !state.ready
  return (
    <div
      className={
        'node-col' +
        (active || kubeletActive ? ' active' : '') +
        (down ? ' down' : '')
      }
      data-fly={node.id}
    >
      <div className="node-head">
        <span className="head-group">
          <span className="node-name">{node.name}</span>
          <span className="role-badge">worker</span>
        </span>
        <span className={'kubelet-badge' + (kubeletActive ? ' active' : '')}>
          kubelet
        </span>
      </div>
      <div className="badge-row">
        <span className="node-version">{state?.version}</span>
        {down && <span className="status-badge notready">NotReady</span>}
        {state?.unschedulable && (
          <span
            className="status-badge cordoned"
            title="spec.unschedulable = true — the scheduler filters this node out"
          >
            SchedulingDisabled
          </span>
        )}
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
