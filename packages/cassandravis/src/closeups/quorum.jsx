import { motion } from 'framer-motion'
import { CL_NAMES, N_REPLICAS, NODE_COLORS } from '../cluster'
import { Mut } from './shared'

// Close-up: the coordinator counting acks against W at the end of a write.
// Data: the put/del payload — { key, value, ts, tombstone, color, w, replicas,
// down, acks, ok }.
export function build(p, verb) {
  const w = CL_NAMES[p.w]
  const hasDown = p.down.length > 0
  const steps = [
    {
      key: 'stamp',
      title: '1 · One mutation, one timestamp',
      blurb: `Before anything is sent, the coordinator stamps the ${verb === 'del' ? 'tombstone' : 'mutation'} with t${p.ts}. Every replica will store this exact timestamp — it is what last-write-wins compares later, so the decision made here follows the data everywhere.`,
    },
    {
      key: 'fanout',
      title: `2 · Sent to all ${N_REPLICAS} replicas — W changes nothing here`,
      blurb: `The request goes to every replica of the key, always. W=${p.w} (${w}) is NOT "write to ${p.w} nodes" — it is a promise about how long the coordinator will wait before answering the client.`,
    },
    {
      key: 'acks',
      title: '3 · Acks come back',
      blurb: hasDown
        ? `Each live replica applies the write locally (commit log + memtable) and acks. ${p.down.join(', ')} is down — its ack will never come, and the coordinator knows it.`
        : 'Each replica applies the write locally (commit log + memtable) and acks the coordinator. With every replica up, all acks arrive.',
    },
  ]
  if (hasDown)
    steps.push({
      key: 'hint',
      title: '4 · A hint is parked — it is NOT an ack',
      blurb: `The coordinator stores a hint for ${p.down.join(', ')} to deliver later. Cassandra keeps a STRICT quorum: the hint never counts toward W. (Dynamo's sloppy quorum differs — there, a stand-in node's write counts.)`,
    })
  steps.push({
    key: 'verdict',
    title: `${steps.length + 1} · Count: ${p.acks} ack${p.acks === 1 ? '' : 's'} vs W=${p.w}`,
    blurb: p.ok
      ? `${p.acks} ≥ ${p.w}, so the client is acked now — the coordinator does not wait for the rest. That gap between "client acked" and "all replicas have it" is exactly what read consistency (R) has to bridge.`
      : `${p.acks} < ${p.w}: the write fails back to the client — but the replicas that applied it keep it, and the hint remains. Real Cassandra would have failed fast (Unavailable) knowing too few replicas were up; a mid-flight TIMEOUT behaves like this.`,
  })
  const verdictIdx = steps.length - 1
  const hintIdx = hasDown ? 3 : -1

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        <div className="cu-banner">
          <Mut k={p.key} value={p.value} ts={p.ts} tombstone={p.tombstone} color={p.color} />
          <span className="cu-note">write CL: {w} (wait for {p.w} ack{p.w === 1 ? '' : 's'})</span>
        </div>

        {step >= 1 &&
          p.replicas.map((nid, i) => {
            const isDown = p.down.includes(nid)
            return (
              <motion.div
                key={nid}
                className={
                  'cu-row' + (step >= 2 ? (isDown ? ' bad' : ' ok') : '')
                }
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.18 }}
              >
                <span className="node-dot" style={{ background: NODE_COLORS[nid] }} />
                <span className="cu-cell">{nid}</span>
                <span className="cu-cell dim">← mutation (t{p.ts})</span>
                <motion.span
                  key={`st-${step >= 2}`}
                  className="cu-cell right"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: step === 2 ? 0.3 + i * 0.35 : 0 }}
                >
                  {step < 2 ? 'sending…' : isDown ? '✗ down — no response' : '✓ ack (log + memtable)'}
                </motion.span>
              </motion.div>
            )
          })}

        {hintIdx >= 0 && step >= hintIdx && (
          <motion.div className="cu-row hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <span className="cu-cell">📩 hint for {p.down.join(', ')}</span>
            <span className="cu-cell dim right">held on the coordinator · counts for 0 acks</span>
          </motion.div>
        )}

        {step >= verdictIdx && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="cu-meter">
              {p.replicas.map((nid, i) => (
                <span
                  key={nid}
                  className={
                    'cu-meter-cell' +
                    (i < p.acks ? ' filled' : p.down.includes(nid) ? ' dead' : '') +
                    (i + 1 === p.w ? ' threshold' : '')
                  }
                  title={i + 1 === p.w ? `W = ${p.w}` : undefined}
                />
              ))}
              <span className="cu-meter-label">
                W = {p.w} ({w})
              </span>
            </div>
            <div className={'cu-verdict' + (p.ok ? ' ok' : ' bad')}>
              {p.ok
                ? `✓ ${p.acks} ≥ W=${p.w} — client acked; remaining replication continues in the background`
                : `✗ ${p.acks} < W=${p.w} — write FAILS to the client · no rollback on the replicas that took it`}
            </div>
          </motion.div>
        )}
      </div>
    )
  }

  return {
    key: `quorum-${p.ts}`,
    title: `Coordinator · quorum math for ${verb === 'del' ? 'delete' : 'put'}(${p.key})`,
    sub: 'coordinator · count acks vs W',
    source: '[data-fly="node-1"]',
    steps,
    Stage,
  }
}
