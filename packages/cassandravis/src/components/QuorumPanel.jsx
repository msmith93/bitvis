import { N_REPLICAS, CL_NAMES, NODE_COLORS } from '../cluster'

// Right-panel view during a put/del/get: the per-replica outcomes and the
// quorum math, revealed step by step. Driven by opExtra's `quorum`.
export default function QuorumPanel({ quorum }) {
  if (!quorum) return null
  return quorum.kind === 'write' ? <WritePanel q={quorum} /> : <ReadPanel q={quorum} />
}

function NodeTag({ id }) {
  return (
    <span className="node-tag">
      <span className="node-dot" style={{ background: NODE_COLORS[id] }} />
      {id}
    </span>
  )
}

function WritePanel({ q }) {
  return (
    <div className="quorum-panel">
      <p className="section-title">Write · quorum math</p>
      <div className="quorum-rows">
        {q.replicas.map((r) => (
          <div className="quorum-row" key={r.node}>
            <NodeTag id={r.node} />
            {!q.revealed ? (
              <span className="q-wait">…</span>
            ) : r.down ? (
              <span className="q-down">
                ✗ down{q.hinted ? ' · hint stored 📩' : ''}
              </span>
            ) : (
              <span className="q-ack">✓ ack (commit log + memtable)</span>
            )}
          </div>
        ))}
      </div>
      {q.verdict && (
        <div className={'quorum-verdict' + (q.ok ? ' ok' : ' fail')}>
          {q.acks} live ack{q.acks === 1 ? '' : 's'} {q.ok ? '≥' : '<'} W={q.w} ({CL_NAMES[q.w]}) →{' '}
          {q.ok ? 'write OK' : 'write FAILS (no rollback!)'}
        </div>
      )}
      {q.hinted && (
        <p className="q-note">Hints do NOT count toward W — Cassandra keeps a strict quorum.</p>
      )}
    </div>
  )
}

function ReadPanel({ q }) {
  const isWinner = (e) => e && q.winner && e.ts === q.winner.ts
  return (
    <div className="quorum-panel">
      <p className="section-title">Read · replica responses</p>
      <div className="quorum-rows">
        {q.replicas.map((r) => {
          const resp = q.responses.find((x) => x.node === r.node)
          const stale = q.repairs.includes(r.node)
          return (
            <div className="quorum-row" key={r.node}>
              <NodeTag id={r.node} />
              {r.down ? (
                <span className="q-down">✗ down</span>
              ) : !r.contacted ? (
                <span className="q-skip">not contacted (R={q.r})</span>
              ) : !q.revealed ? (
                <span className="q-wait">querying…</span>
              ) : (
                <span
                  className={
                    'q-resp' + (isWinner(resp?.entry) ? ' winner' : '') + (stale ? ' stale' : '')
                  }
                >
                  {resp?.entry
                    ? resp.entry.tombstone
                      ? `🪦 tombstone · t${resp.entry.ts}`
                      : `${resp.entry.value} · t${resp.entry.ts}`
                    : '∅ no data'}
                  {isWinner(resp?.entry) && ' ← newest'}
                  {stale && (q.repaired ? ' · repaired ✓' : ' · STALE')}
                </span>
              )}
            </div>
          )
        })}
      </div>
      {q.verdict && (
        <div className={'quorum-verdict' + (q.ok ? ' ok' : ' fail')}>
          {q.ok
            ? `${q.contacted.length} response${q.contacted.length === 1 ? '' : 's'} ≥ R=${q.r} (${CL_NAMES[q.r]}) → ${
                q.winner ? (q.winner.tombstone ? 'not found (tombstone wins)' : `answer: ${q.winner.value}`) : 'not found'
              }`
            : `only ${q.contacted.length} live replica${q.contacted.length === 1 ? '' : 's'} < R=${q.r} (${CL_NAMES[q.r]}) → read FAILS`}
        </div>
      )}
      <p className="q-note">
        W + R &gt; N = {N_REPLICAS} guarantees the read overlaps the latest write's quorum.
      </p>
    </div>
  )
}
