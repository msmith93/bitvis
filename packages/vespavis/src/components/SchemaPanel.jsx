import { buildProductSchema, INDEXING_LEGEND, USER_SCHEMA } from '../schema'
import { MODES } from '../ranking'
import { REAL_DEFAULTS } from '../constants'

// The application package, rendered rather than described — and editable.
//
// In Vespa the schema IS the application: there is no mapping API and no index
// settings endpoint, you deploy a package and the cluster's behaviour follows
// from the text in it. So the text here is generated from the same config object
// the model reads, and the controls edit that object. Change a line and you are
// changing what the next query actually does, which is the closest this app can
// get to the real experience of working on a Vespa application.
export default function SchemaPanel({ mode, useCase, tab, setTab, config, setConfig }) {
  const m = MODES[mode] || MODES.lexical
  const set = (k) => (v) => setConfig({ ...config, [k]: v })

  return (
    <div className="schema-panel">
      <div className="tabs sub">
        <button
          className={'tab' + (tab === 'schema' ? ' on' : '')}
          onClick={() => setTab('schema')}
        >
          schema
        </button>
        <button
          className={'tab' + (tab === 'profile' ? ' on' : '')}
          onClick={() => setTab('profile')}
        >
          rank-profile
        </button>
        <button
          className={'tab' + (tab === 'legend' ? ' on' : '')}
          onClick={() => setTab('legend')}
        >
          index vs attribute
        </button>
      </div>

      {tab === 'schema' && (
        <>
          <div className="knobs">
            <Toggle
              label="category · attribute: fast-search"
              on={config.categoryFastSearch}
              onChange={set('categoryFastSearch')}
              hint={
                config.categoryFastSearch
                  ? 'The filter is an index lookup, so it runs BEFORE the graph walk. Every neighbour returned is one that matches.'
                  : 'The filter cannot be evaluated cheaply up front, so the graph is walked unrestricted and the filter applied after — and hits the cluster paid to find get thrown away. Run the Filtered vector mode to see it.'
              }
            />
          </div>
          <pre className="code">{buildProductSchema(config)}</pre>
          {useCase === 'recommend' && (
            <>
              <pre className="code">{USER_SCHEMA}</pre>
              <p className="panel-note">
                Two document types, one cluster. A <code>user</code> is placed by
                the same hash into the same buckets on the same nodes as a
                product — Proton just keeps a separate document database per
                type, which is why a product search never walks them.
              </p>
            </>
          )}
        </>
      )}

      {tab === 'profile' && (
        <>
          <div className="knobs">
            {m.usesText && m.usesVector && (
              <Slider
                label="first-phase lexical weight"
                value={config.lexicalWeight}
                min={0}
                max={1}
                step={0.05}
                onChange={set('lexicalWeight')}
                hint="How much BM25 counts against closeness. There is no normalize() to reach for: first-phase runs per document and cannot see the other scores."
              />
            )}
            {m.usesVector && (
              <Stepper
                label="targetHits"
                value={config.targetHits}
                min={1}
                max={8}
                onChange={set('targetHits')}
                hint="Neighbours nearestNeighbor exposes to first-phase, PER CONTENT NODE."
              />
            )}
            {m.secondPhase && (
              <Stepper
                label="second-phase rerank-count"
                value={config.secondPhaseRerankCount}
                min={0}
                max={8}
                onChange={set('secondPhaseRerankCount')}
                hint="Documents each node re-scores with the expensive expression."
              />
            )}
            {m.globalPhase && (
              <Stepper
                label="global-phase rerank-count"
                value={config.globalPhaseRerankCount}
                min={1}
                max={12}
                onChange={set('globalPhaseRerankCount')}
                hint="Documents the container's model sees, out of the merged list."
              />
            )}
          </div>
          <pre className="code">{m.profile(config)}</pre>
          <p className="panel-note">
            <b>{m.label}.</b> {m.blurb}
          </p>
          {(m.secondPhase || m.globalPhase) && (
            <p className="panel-note toy">
              Toy-scaled. Vespa's defaults for these rerank-counts are{' '}
              {REAL_DEFAULTS.secondPhaseRerankCount} and{' '}
              {REAL_DEFAULTS.globalPhaseRerankCount}; the numbers here are small
              so a 14-document corpus still has a head and a tail.
            </p>
          )}
        </>
      )}

      {tab === 'legend' && (
        <div className="legend">
          {INDEXING_LEGEND.map((l) => (
            <div key={l.kw} className="legend-row">
              <code>{l.kw}</code>
              <span className="legend-where">{l.where}</span>
              <p>{l.what}</p>
            </div>
          ))}
          <p className="panel-note">
            One field can be several of these at once — that is what the pipe in
            an indexing statement means. A field that is <code>index</code> can
            be searched with BM25 but costs a read-modify-write to change; a
            field that is <code>attribute</code> can be assigned in place at
            memory speed but costs RAM for every document on the node. Choosing
            between them is most of what schema design in Vespa is — and you can
            watch the difference by pointing the Update control at{' '}
            <code>popularity</code> and then at <code>title</code>.
          </p>
        </div>
      )}
    </div>
  )
}

function Toggle({ label, on, onChange, hint }) {
  return (
    <div className="knob">
      <button className={'knob-toggle' + (on ? ' on' : '')} onClick={() => onChange(!on)}>
        <span className="kt-dot" />
        <span className="kt-label">{label}</span>
        <span className="kt-state">{on ? 'on' : 'off'}</span>
      </button>
      {hint && <p className="knob-hint">{hint}</p>}
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange, hint }) {
  return (
    <div className="knob">
      <label className="knob-head">
        <span>{label}</span>
        <b>{value}</b>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="knob-hint">{hint}</p>}
    </div>
  )
}

function Stepper({ label, value, min, max, onChange, hint }) {
  return (
    <div className="knob">
      <div className="knob-head">
        <span>{label}</span>
        <span className="knob-steps">
          <button onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>
            −
          </button>
          <b>{value}</b>
          <button onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>
            +
          </button>
        </span>
      </div>
      {hint && <p className="knob-hint">{hint}</p>}
    </div>
  )
}
