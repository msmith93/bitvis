// The `_source` renderer, shared by the search-response overlay and the doc-pill
// peek on the cluster stage. Both draw the same thing through the same code so
// the two can never disagree about what a document IS.
//
// `_source` is the original JSON, stashed verbatim on the BLOCK ROOT by
// buildBlock and returned identically under `object` and `nested` mapping —
// sub-objects stay paired either way. That sameness is the point: it is why an
// object-mapping false positive is so easy to miss from a response alone. The
// flattened indexed form (`fields`) is a different thing, shown one zoom down in
// the shard close-up.

const isSubObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isSubObjectArray = (v) => Array.isArray(v) && v.some(isSubObject)

// One `_source` field: a scalar / multi-valued scalar renders as a key + value
// row; an array of sub-objects (the `variants` of an object- OR nested-mapped
// product) renders as a paired list, one line per sub-object. Both mappings hand
// back the same thing here — the pairing only breaks in the indexed form.
export function SourceField({ name, value }) {
  if (isSubObjectArray(value) || isSubObject(value)) {
    const items = Array.isArray(value) ? value : [value]
    return (
      <div className="source-nested">
        <span className="source-key">{name}</span>
        <ol className="source-nested-list">
          {items.map((obj, i) => (
            <li key={i}>
              {Object.entries(obj).map(([k, v]) => (
                <span className="source-subfield" key={k}>
                  <span className="source-subkey">{k}</span>
                  <span className="source-val">{String(v)}</span>
                </span>
              ))}
            </li>
          ))}
        </ol>
      </div>
    )
  }
  return (
    <div className="source-field">
      <span className="source-key">{name}</span>
      <span className="source-val">
        {Array.isArray(value) ? value.join(', ') : String(value)}
      </span>
    </div>
  )
}

// The rows to draw for one document: its `_source` when the block root carried
// one, falling back to the flattened indexed `fields` for a doc built before
// blocks carried their source (none, in practice).
export function sourceEntries(doc) {
  if (doc?.source) {
    return Object.entries(doc.source).filter(([, v]) => v != null && v !== '')
  }
  return doc?.fields ? Object.entries(doc.fields) : []
}
