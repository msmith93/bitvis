// Generic stepper, driven by whatever operation is active (index / refresh /
// flush / merge / search). `steps` is the current op's step list.
export default function Stepper({
  steps,
  step,
  opLabel,
  playing,
  onPrev,
  onNext,
  onPlay,
  onPause,
  dataTour,
  highlightPlay,
}) {
  const active = steps.length > 0
  const atStart = !active || step <= 0
  const atEnd = !active || step >= steps.length - 1

  return (
    <div className="stepper" data-tour={dataTour}>
      <div className="op-label">{active ? opLabel : 'idle'}</div>

      <div className="controls">
        <button className="btn" onClick={onPrev} disabled={atStart}>
          ‹ Prev
        </button>
        {playing ? (
          <button className="btn" onClick={onPause} disabled={!active}>
            ❚❚ Pause
          </button>
        ) : (
          <button
            className={'btn' + (highlightPlay ? ' tour-pulse' : '')}
            data-tour={dataTour ? dataTour + '-play' : undefined}
            onClick={onPlay}
            disabled={!active || atEnd}
          >
            ▶ Play
          </button>
        )}
        <button className="btn" onClick={onNext} disabled={atEnd}>
          Next ›
        </button>
      </div>

      <div className="step-track">
        {steps.map((s, i) => (
          <div
            key={s.key}
            className={
              'step-pip ' + (i < step ? 'done' : i === step ? 'current' : '')
            }
          >
            <div className="bar" />
            <span>{s.title.replace(/^\d+ · /, '')}</span>
          </div>
        ))}
      </div>

      <div className="step-count">
        {active ? `Step ${step + 1} / ${steps.length}` : '—'}
      </div>
    </div>
  )
}
