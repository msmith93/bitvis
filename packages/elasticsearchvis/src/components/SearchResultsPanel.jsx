import { SHARD_PLACEMENT } from '../cluster'

// Right-panel view during a search. Reveals the two-phase query-then-fetch flow
// step by step: per-shard local hits, then the coordinator's merged ranking,
// then fetched bodies, then "returned to client".
//
// A shard with no entry in `serving` was never asked — that only happens when
// the query carried a routing key, and showing those shards sitting idle is the
// whole point of the routing lesson.
export default function SearchResultsPanel({ search, step, docs }) {
  if (!search) return null
  const { terms, serving, perShard, merged, routing, wildcard } = search

  return (
    <div>
      <p className="section-title">Search · scatter / gather</p>
      <div className="ii-meta">
        {wildcard ? 'pattern: ' : 'query terms: '}
        {terms.length ? (
          terms.map((t) => (
            <span key={t} className="term-chip">
              {t}
            </span>
          ))
        ) : (
          <em>none</em>
        )}
        {routing && (
          <span className="routing-tag">
            routing <b>{routing}</b> → shard {search.routedShard}
          </span>
        )}
      </div>

      <div className="search-shards">
        {SHARD_PLACEMENT.map(({ id: sid }) => {
          const sv = serving[sid]
          const hits = perShard[sid] || []
          if (!sv)
            return (
              <div className="search-shard skipped" key={sid}>
                <div className="ss-head">shard {sid}</div>
                <div className="ss-skipped">
                  not queried — routing “{routing}” can’t be on this shard
                </div>
              </div>
            )
          return (
            <div className="search-shard" key={sid}>
              <div className="ss-head">
                shard {sid} · <span className={'role-badge ' + sv.role}>{sv.role}</span> on{' '}
                {sv.node}
              </div>
              {step < 2 ? (
                <div className="ss-wait">querying…</div>
              ) : hits.length === 0 ? (
                <div className="ss-none">no local hits</div>
              ) : (
                <div className="ss-hits">
                  {hits.map((h) => (
                    <div className="ss-hit" key={h.docId}>
                      <Chip id={h.docId} docs={docs} />
                      <span className="score">score {h.score}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {step >= 3 && (
        <div className="merged-block">
          <p className="section-title">Coordinator · merged &amp; ranked</p>
          {merged.length === 0 ? (
            <div className="empty-note">no matching documents</div>
          ) : (
            <ol className="results">
              {merged.map((h) => (
                <li key={h.docId}>
                  <div className="result-head">
                    <Chip id={h.docId} docs={docs} />
                    <span className="result-from">shard {h.shard}</span>
                    <span className="score">score {h.score}</span>
                  </div>
                  {step >= 4 && docs[h.docId] && (
                    <div className="result-body">{docs[h.docId].title}</div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {step >= 5 && <div className="returned">↩ returned to client</div>}
        </div>
      )}
    </div>
  )
}

function Chip({ id, docs }) {
  const d = docs[id]
  return (
    <span className="doc-chip" style={{ background: d?.color || '#888' }}>
      {id}
    </span>
  )
}
