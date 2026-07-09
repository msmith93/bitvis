import { serviceEndpoints } from '../cluster'

// The traffic rail: the synthetic user, the ingress controller (always
// running — with or without rules), and one chip per Service showing its live
// endpoint count. Sits between the scenario bar and the node row. The rail
// renders from the DERIVED cluster so it scrubs with the stepper, while the
// request ticker itself lives in useTraffic.
export default function TrafficRail({ cluster, traffic, focus }) {
  const ingresses = Object.values(cluster.ingresses)
  const services = Object.values(cluster.services)
  const { stats, recent, paused, setPaused } = traffic

  return (
    <div className="traffic-rail">
      {/* Column 1 sits above the control-plane card and stays EMPTY of
          traffic on purpose: user requests are data plane and never pass
          through the control plane. */}
      <div className="rail-note">
        user traffic is the <b>data plane</b> — it never passes through the
        control plane below
      </div>
      <div className="rail-flow">
      <div
        className={'rail-box rail-user' + (focus.has('user') ? ' active' : '')}
        data-fly="user"
      >
        <span className="rail-title">👤 user</span>
        <span className="rail-sub">
          <span className="ticker">
            {recent.length === 0 && <span className="empty-note">…</span>}
            {recent.map((r, i) => (
              <span key={i} className={r === 'ok' ? 'tick-ok' : 'tick-fail'}>
                {r === 'ok' ? '✓' : '✗'}
              </span>
            ))}
          </span>
          <span className="counts">
            {stats.ok} ok · {stats.fail} failed
          </span>
        </span>
      </div>

      <span className="rail-arrow">→</span>

      <div
        className={'rail-box rail-ingress' + (focus.has('ingress') ? ' active' : '')}
        data-fly="ingress"
      >
        <span className="rail-title">ingress controller</span>
        <span className="rail-sub">
          {ingresses.length === 0 ? (
            <span className="rail-warn">no rules · answers 404</span>
          ) : (
            ingresses.map((i) => (
              <span key={i.name} className="rail-rule">
                {i.host} → {i.serviceName}:{i.servicePort}
              </span>
            ))
          )}
        </span>
      </div>

      <span className="rail-arrow">→</span>

      {services.length === 0 ? (
        <div className="rail-box rail-empty">
          <span className="rail-title">no services</span>
          <span className="rail-sub">
            <span className="rail-warn">kubectl expose deployment …</span>
          </span>
        </div>
      ) : (
        services.map((s) => {
          const eps = serviceEndpoints(cluster, s).length
          return (
            <div
              key={s.name}
              className={
                'rail-box rail-svc' + (focus.has(`svc:${s.name}`) ? ' active' : '')
              }
              data-fly={`svc-${s.name}`}
            >
              <span className="rail-title">svc/{s.name}</span>
              <span className="rail-sub">
                {s.clusterIP} ·{' '}
                <span className={eps === 0 ? 'rail-warn' : 'rail-good'}>
                  endpoints: {eps}
                </span>
              </span>
            </div>
          )
        })
      )}

      <button
        className="btn rail-pause"
        title={paused ? 'resume the synthetic user (1 request / 5s)' : 'pause traffic'}
        onClick={() => setPaused(!paused)}
      >
        {paused ? '▶' : '❚❚'}
      </button>
      </div>
    </div>
  )
}
