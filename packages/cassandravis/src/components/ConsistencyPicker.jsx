import { CL, CL_NAMES } from '../cluster'

// Segmented ONE/QUORUM/ALL control for a consistency level (W or R).
export default function ConsistencyPicker({ label, value, onChange, disabled, dataTour }) {
  return (
    <div className="cl-picker" data-tour={dataTour}>
      <span className="cl-label">{label}</span>
      {Object.values(CL).map((v) => (
        <button
          key={v}
          className={'cl-btn' + (value === v ? ' selected' : '')}
          disabled={disabled}
          onClick={() => onChange(v)}
        >
          {CL_NAMES[v]}
        </button>
      ))}
    </div>
  )
}
