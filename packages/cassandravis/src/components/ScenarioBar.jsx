// The "simulate:" bar above the stage — failure scenarios that are NOT client
// requests (a crash isn't a query; recovery happens on the machine). App picks
// the concrete target when a button is clicked; this component only reports
// which scenarios currently have a valid target. Ported from kubevis.
export default function ScenarioBar({ scenarios, disabled }) {
  return (
    <div className="scenario-bar">
      <span className="scenario-label">simulate:</span>
      {scenarios.map((s) => (
        <button
          key={s.key}
          className="scenario-btn"
          data-tour={'scenario-' + s.key}
          disabled={disabled || !s.enabled}
          title={s.tooltip}
          onClick={s.run}
        >
          {s.icon} {s.label}
        </button>
      ))}
    </div>
  )
}
