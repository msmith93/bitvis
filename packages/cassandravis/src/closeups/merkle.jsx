import { motion } from 'framer-motion'
import { NODE_COLORS } from '../cluster'
import { fnv, hex4 } from './shared'

// Close-up: the Merkle exchange as actual trees — leaves hash the data, a root
// hashes the leaves, and comparison descends root → leaves. Data: the repair
// payload { comparisons, diffs }.
export function build(p) {
  const leafHash = (e) => (e ? hex4(fnv(`${e.value}|${e.ts}|${e.tombstone ? 1 : 0}`)) : '––––')

  // One tree per up replica: its leaves are the keys it replicates.
  const nodes = [...new Set(p.comparisons.flatMap((c) => c.replicas))].sort()
  const trees = nodes.map((nid) => {
    const leaves = p.comparisons
      .filter((c) => c.replicas.includes(nid))
      .map((c) => ({
        key: c.key,
        hash: leafHash(c.entries[nid]),
        mismatch: !c.match,
      }))
    return {
      nid,
      leaves,
      root: hex4(fnv(leaves.map((l) => `${l.key}:${l.hash}`).join('|'))),
      diverged: leaves.some((l) => l.mismatch),
    }
  })
  const anyDiff = p.diffs.length > 0

  const steps = [
    {
      key: 'leaves',
      title: '1 · Leaves: hash the data itself',
      blurb: 'For the token range being repaired, each replica hashes its rows into leaf buckets — a fingerprint per bucket (per key, in this small demo). Hashing is local and cheap; no data leaves the node yet.',
    },
    {
      key: 'root',
      title: '2 · Hash upward to a single root',
      blurb: 'Parents hash their children until one root remains. Now each replica\'s ENTIRE dataset for the range is summarized in one small value — two replicas can compare terabytes by exchanging a handful of bytes.',
    },
    {
      key: 'roots',
      title: '3 · Compare roots first',
      blurb: anyDiff
        ? 'The replicas swap roots. Equal roots would have ended the repair right here — but some differ, so SOMETHING diverges underneath. Where exactly? Descend.'
        : 'The replicas swap roots — and they all match. Identical roots mean identical data (up to hash collision), so the repair ends here having moved zero rows. That cheapness is the point of Merkle trees.',
    },
  ]
  if (anyDiff) {
    steps.push({
      key: 'descend',
      title: '4 · Descend into the mismatching branches',
      blurb: `Comparing child hashes narrows the search level by level, exchanging only hashes on the way down. The trail ends at ${p.diffs.length} divergent leaf${p.diffs.length === 1 ? '' : 'ves'}: ${p.diffs.map((d) => d.key).join(', ')}. Everything that matched along the way is never touched.`,
    })
    steps.push({
      key: 'stream',
      title: '5 · Stream only those entries',
      blurb: 'Now — and only now — actual data moves: the divergent entries stream between replicas, and on each side the newer timestamp wins, same LWW rule as reads. Hashes found the needle; the haystack stayed home.',
    })
  }
  const rootsIdx = 2
  const descendIdx = anyDiff ? 3 : -1
  const streamIdx = anyDiff ? 4 : -1

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        <div className="cu-tree">
          {trees.map((t, ti) => (
            <div key={t.nid} className="cu-tree-col">
              <div className="cu-tree-head">
                <span className="node-dot" style={{ background: NODE_COLORS[t.nid] }} />
                {t.nid}
              </div>
              {step >= 1 && (
                <motion.div
                  className={
                    'cu-root' +
                    (step >= rootsIdx ? (t.diverged ? ' mismatch' : ' match') : '')
                  }
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: step === 1 ? 0.2 : 0 }}
                >
                  root {t.root}
                </motion.div>
              )}
              {step >= 1 && <div className="cu-tree-trunk" />}
              <div className="cu-leaves">
                {t.leaves.map((l, i) => (
                  <motion.div
                    key={l.key}
                    className={
                      'cu-leaf' +
                      (descendIdx >= 0 && step >= descendIdx
                        ? l.mismatch
                          ? ' mismatch'
                          : ' match'
                        : '')
                    }
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: step === 0 ? ti * 0.15 + i * 0.1 : 0 }}
                  >
                    <span className="mono">{l.key}</span>
                    <span className="mono dim">{l.hash}</span>
                  </motion.div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {step >= rootsIdx && !anyDiff && (
          <motion.div className="cu-verdict ok" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            ✓ all roots equal — in sync, repair done, zero rows moved
          </motion.div>
        )}

        {streamIdx >= 0 &&
          step >= streamIdx &&
          p.diffs.map((d, i) => (
            <motion.div
              key={d.key}
              className="cu-row ok"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.2 }}
            >
              <span className="cu-cell mono">{d.key}</span>
              <span className="cu-cell dim">
                winner t{d.winner.ts} streams: {d.from} → {d.targets.join(', ')}
              </span>
              <span className="cu-cell right">✓ converged</span>
            </motion.div>
          ))}
      </div>
    )
  }

  return {
    key: `merkle-${p.id}`,
    title: 'Repair · the Merkle trees, root to leaf',
    sub: 'repair · Merkle compare',
    source: '.merkle-panel',
    steps,
    Stage,
  }
}
