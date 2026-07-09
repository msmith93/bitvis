import { stepsFor, OPS } from '../ops'
import { EVENTS_SHOWN } from '../constants'

// Right-hand panel: the current step's explanation, the etcd desired-state
// tree (Deployment → ReplicaSet → Pods), and the recent event stream. All
// rendered from the DERIVED cluster so it scrubs with the stepper.
export default function SidePanel({ cluster, op }) {
  const steps = op ? stepsFor(op.type) : []
  const current = op ? steps[op.step] : null

  return (
    <div className="side-panel">
      <div className="explain-card">
        {current ? (
          <>
            <div className="explain-op">{OPS[op.type].label}</div>
            <h2>{current.title}</h2>
            <p>{current.blurb}</p>
          </>
        ) : (
          <>
            <div className="explain-op">welcome</div>
            <h2>Run a kubectl command below</h2>
            <p>
              This is a simulated Kubernetes cluster: four nodes, nothing
              running yet. The control plane is itself a node — kube-apiserver,
              etcd, the scheduler, and the controller-manager run on it as
              static pods, and its NoSchedule taint keeps your workloads on the
              three workers. Type a command in the terminal (or click a preset)
              and step through what the control plane actually does with it.
              Start with{' '}
              <code>kubectl create deployment web --image=nginx --replicas=3</code>.
            </p>
          </>
        )}
      </div>

      <div className="etcd-card">
        <h3 className="section-title">cluster state · what etcd knows</h3>
        {Object.keys(cluster.deployments).length === 0 ? (
          <p className="empty-note">no objects yet — desired state is empty</p>
        ) : (
          Object.values(cluster.deployments).map((d) => (
            <DeploymentTree key={d.name} dep={d} cluster={cluster} />
          ))
        )}
      </div>

      <div className="events-card">
        <h3 className="section-title">events</h3>
        {cluster.events.length === 0 ? (
          <p className="empty-note">nothing has happened yet</p>
        ) : (
          <div className="event-list">
            {cluster.events
              .slice(-EVENTS_SHOWN)
              .reverse()
              .map((e) => (
                <div key={e.id} className="event-row">
                  <span className="event-reason">{e.reason}</span>
                  <span className="event-obj">{e.obj}</span>
                  <span className="event-msg">{e.message}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DeploymentTree({ dep, cluster }) {
  const rs = cluster.replicaSets[dep.rsName]
  const pods = Object.values(cluster.pods).filter((p) => p.deployment === dep.name)
  return (
    <div className="dep-tree">
      <div className="tree-row tree-dep">
        <span className="kind">Deployment</span>
        <span className="obj-name">{dep.name}</span>
        <span className="obj-meta">replicas: {dep.replicas} · {dep.image}</span>
      </div>
      {rs && (
        <div className="tree-row tree-rs">
          <span className="tree-elbow">└─</span>
          <span className="kind">ReplicaSet</span>
          <span className="obj-name">{rs.name}</span>
          <span className="obj-meta">desired: {rs.replicas}</span>
        </div>
      )}
      {pods.map((p, i) => (
        <div key={p.name} className="tree-row tree-pod">
          <span className="tree-elbow">{'   '}{i === pods.length - 1 ? '└─' : '├─'}</span>
          <span className="kind">Pod</span>
          <span className="obj-name" style={{ color: p.color }}>
            {p.name}
          </span>
          <span
            className={
              'obj-meta phase-text-' +
              p.phase.toLowerCase() +
              (p.node ? '' : ' unscheduled')
            }
          >
            {p.phase}
            {p.node ? ` · ${p.node}` : ' · unscheduled'}
          </span>
        </div>
      ))}
    </div>
  )
}
