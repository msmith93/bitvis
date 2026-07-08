// The "simulate:" bar above the stage — chaos and ops scenarios that are NOT
// kubectl commands (a crash isn't typed into a terminal; an upgrade happens
// on the machine). App picks the concrete target when a button is clicked;
// this component only reports which scenarios currently have a valid target.
export default function ScenarioBar({ scenarios, disabled }) {
  return (
    <div className="scenario-bar">
      <span className="scenario-label">simulate:</span>
      {scenarios.map((s) => (
        <button
          key={s.key}
          className="scenario-btn"
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
