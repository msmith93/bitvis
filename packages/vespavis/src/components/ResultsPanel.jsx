import { MODES } from '../ranking'

// The ranking phases, as one table that gains a column each time a phase runs.
//
// Drawing them as one table rather than as five separate lists is the point: it
// is the SAME hits all the way down, being re-scored by progressively more
// expensive models over progressively fewer documents. A reader who sees five
// lists learns that Vespa does five searches, which is the opposite of true.
export default function ResultsPanel({ search, at, docs, onEngage }) {
  if (!search) return null
  const m = MODES[search.mode]
  const cfg = search.config
  const showMatch = at.match
  const showFirst = at.first
  const showSecond = at.second && m.secondPhase
  const showMerge = at.merge
  const showGlobal = at.global && m.globalPhase
  const showFinal = at.fill

  // Before the merge the hits are still per node; after it they are one list.
  const rows = showMerge
    ? (showGlobal ? search.global : search.merged)
    : Object.values(search.perNode).flatMap((p) => p.scored)

  if (!showMatch)
    return (
      <div className="results">
        <p className="empty-note">
          Nothing has been matched yet — the query is still in the container.
        </p>
        <Yql search={search} />
      </div>
    )

  return (
    <div className="results">
      <Yql search={search} />

      <div className="results-meta">
        {showMerge ? (
          <>
            <b>{search.merged.length}</b> hits merged from{' '}
            {Object.keys(search.perNode).length} content nodes
            {showGlobal && (
              <>
                {' '}· global-phase reranked the top <b>{search.globalReranked}</b>
              </>
            )}
          </>
        ) : (
          <>
            <b>{search.totalMatched}</b> documents matched across the cluster
            {search.preFilter && (
              <>
                {' '}· <b>{search.totalFilteredOut}</b> excluded by the filter
                before the walk
              </>
            )}
            {search.postFilter && (
              <>
                {' '}· <b>{search.totalPostFilterDropped}</b> found, then thrown
                away by the filter
              </>
            )}
          </>
        )}
      </div>

      <div className="hits-wrap">
      <table className="hits">
        <thead>
          <tr>
            <th className="c-doc">document</th>
            {m.usesText && <th title="bm25(title) + bm25(description), on node-local statistics">bm25</th>}
            {m.usesVector && <th title="closeness(field, embedding) = 1 / (1 + angular distance)">close</th>}
            {showFirst && <th>1st</th>}
            {showSecond && <th>2nd</th>}
            {showGlobal && <th title="the global-phase model's own score">glob</th>}
            {showMerge && <th>score</th>}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 12).map((h, i) => {
            const d = docs[h.id]
            if (!d) return null
            const final = showFinal && i < search.final.length
            const cut = showSecond && !showMerge && h.second === null
            return (
              <tr
                key={h.id + h.node}
                className={
                  (final ? 'final ' : '') + (cut ? 'below-cut ' : '')
                }
              >
                <td className="c-doc">
                  <span className="dot" style={{ background: d.color }} />
                  <span className="c-title">{d.title}</span>
                  <span className="c-node">{h.node}</span>
                  {h.via && (
                    <span className="via" title="which retriever found it">
                      {h.via.lexical ? 'L' : '·'}
                      {h.via.ann ? 'V' : '·'}
                    </span>
                  )}
                </td>
                {m.usesText && <td className="num">{h.bm25}</td>}
                {m.usesVector && <td className="num">{h.closeness}</td>}
                {showFirst && <td className="num">{h.first}</td>}
                {showSecond && (
                  <td className="num">{h.second === null ? '—' : h.second}</td>
                )}
                {showGlobal && (
                  <td className="num">{h.global === undefined ? '—' : h.global}</td>
                )}
                {showMerge && <td className="num strong">{h.score}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>

      {showSecond && !showMerge && (
        <p className="cut-note">
          Only each node's top {cfg.secondPhaseRerankCount} were re-scored. The
          rest keep their first-phase score — second-phase reorders the head, it
          does not throw away the tail.
        </p>
      )}
      {showGlobal && search.merged.length > cfg.globalPhaseRerankCount && (
        <p className="cut-note">
          {search.merged.length - cfg.globalPhaseRerankCount} hits fell outside
          global-phase's rerank-count of {cfg.globalPhaseRerankCount} and were
          never shown to the model. They stay below the reranked ones: the two
          groups' scores came out of different expressions and are not
          comparable.
        </p>
      )}

      {showFinal && (
        <div className="response">
          <div className="response-head">
            response · {search.final.length} hits, summaries fetched
          </div>
          {search.final.map((h, i) => {
            const d = docs[h.id]
            if (!d) return null
            return (
              <div key={h.id} className="rhit">
                <span className="rank">{i + 1}</span>
                <span className="dot" style={{ background: d.color }} />
                <div className="rbody">
                  <div className="rtitle">{d.title}</div>
                  <div className="rdesc">{d.description}</div>
                  <div className="rmeta">
                    <span>{d.category}</span>
                    <span>popularity {d.popularity}</span>
                    <span>relevance {h.score}</span>
                  </div>
                  {/* The recommendation loop, closed. Engaging writes a new
                      profile tensor into one attribute cell — no reindex, no
                      graph to repair — and the next query uses it. */}
                  {onEngage && (
                    <button className="engage" onClick={() => onEngage(d)}>
                      ♥ engage — nudge the profile toward this
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {!search.final.length && (
            <p className="empty-note">
              No hits. Nothing matched, and Vespa returns that in a few
              milliseconds rather than failing.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Yql({ search }) {
  return (
    <div className="yql">
      <div className="yql-head">yql</div>
      <pre>{search.yql}</pre>
      {search.queryVector && (
        <div className="qvec">
          query(q) = [{search.queryVector.map((v) => v.toFixed(2)).join(', ')}]
          {search.topic && <i> · {search.topic.label}</i>}
        </div>
      )}
    </div>
  )
}
