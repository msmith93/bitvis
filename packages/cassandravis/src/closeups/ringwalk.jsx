import { motion } from 'framer-motion'
import { NODE_COLORS, N_REPLICAS, RING_SIZE } from '../cluster'

// Close-up: the partitioner and the clockwise replica walk, digit by digit.
// Data: a put/del/get payload — { key, token, walk, replicas }.
export function build(p) {
  // Re-trace hashKey(key) so every intermediate value is visible.
  const rows = []
  let h = 0
  for (const ch of p.key) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0
    rows.push({ ch, code: ch.charCodeAt(0), h })
  }

  const skips = p.walk.filter((s) => !s.taken).length
  const steps = [
    {
      key: 'hash',
      title: '1 · Hash the key, character by character',
      blurb: `The partitioner reduces "${p.key}" to one number with a rolling hash (ours: h = h×31 + charCode, standing in for Murmur3). Same key ⇒ same number, on every node, every time — that determinism is the whole trick.`,
    },
    {
      key: 'mod',
      title: `2 · mod ${RING_SIZE} → a position on the ring`,
      blurb: `${h} mod ${RING_SIZE} = ${p.token}. The key now has a fixed address on the token ring. No lookup table, no directory service — any node can compute this locally, which is why ANY node can coordinate.`,
    },
    {
      key: 'walk',
      title: '3 · Walk clockwise; skip vnodes of nodes already chosen',
      blurb: skips
        ? `From token ${p.token}, take each vnode's owner in clockwise order — but a vnode whose PHYSICAL node is already in the set is skipped (that's the "distinct nodes" rule; otherwise one machine could hold two of the ${N_REPLICAS} copies).`
        : `From token ${p.token}, take each vnode's owner in clockwise order until ${N_REPLICAS} DISTINCT physical nodes are found. (No skips this time — the first ${N_REPLICAS} vnodes all belonged to different machines.)`,
    },
    {
      key: 'set',
      title: `4 · The replica set: ${p.replicas.join(', ')}`,
      blurb: 'These nodes hold the key — for THIS write and for every future read, because the math is deterministic. Reads re-run the identical hash and walk, which is why no one has to remember where anything lives.',
    },
  ]

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        <div className="cu-hashgrid">
          {rows.map((r, i) => (
            <motion.div
              key={i}
              className="cu-hashrow"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: step === 0 ? i * 0.12 : 0 }}
            >
              <span className="cu-cell mono">"{r.ch}"</span>
              <span className="cu-cell mono dim">×31 + {r.code}</span>
              <span className="cu-cell mono right">h = {r.h}</span>
            </motion.div>
          ))}
        </div>

        {step >= 1 && (
          <motion.div className="cu-banner" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <span className="cu-cell mono">
              {h} mod {RING_SIZE} =
            </span>
            <span className="cu-token">token {p.token}</span>
          </motion.div>
        )}

        {step >= 2 &&
          p.walk.map((s, i) => (
            <motion.div
              key={`${s.token}-${i}`}
              className={'cu-row' + (s.taken ? ' ok' : ' dim')}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: step === 2 ? i * 0.3 : 0 }}
            >
              <span className="cu-cell mono">t{s.token}</span>
              <span className="node-dot" style={{ background: NODE_COLORS[s.node] }} />
              <span className="cu-cell">{s.node}</span>
              <span className="cu-cell right">
                {s.taken
                  ? `✓ R${p.walk.slice(0, i + 1).filter((x) => x.taken).length}`
                  : `skip — ${s.node} already chosen`}
              </span>
            </motion.div>
          ))}

        {step >= 3 && (
          <motion.div className="cu-verdict ok" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            ✓ replicas of {p.key}:{' '}
            {p.replicas.map((nid) => (
              <span key={nid} className="cu-replica" style={{ borderColor: NODE_COLORS[nid] }}>
                {nid}
              </span>
            ))}
          </motion.div>
        )}
      </div>
    )
  }

  return {
    key: `walk-${p.key}-${p.token}`,
    title: `Partitioner · hash(${p.key}) and the ring walk`,
    sub: 'partitioner · hash + walk',
    source: '.ring-svg',
    steps,
    Stage,
  }
}
