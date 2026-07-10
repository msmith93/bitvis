import { flightAwareDuration } from './shared'

// The `repair` (anti-entropy) op: replicas compare Merkle trees of their data
// per key range and stream only the divergent entries; newest timestamp wins.
// This catches divergence that hints and read repair missed. Payload, built by
// App from the folded cluster:
//   { id,
//     comparisons: [{ key, token, replicas, entries: {node: entry|null}, match }],
//     diffs: [{ key, winner, from, targets: [node], color }] }
// comparisons cover every key, restricted to UP replicas; diffs are the keys
// where an up replica is stale/missing (winner = newest entry, from = a node
// that holds it).

const makeSteps = (p) => {
  const steps = [
    {
      key: 'build',
      ms: 3000,
      title: '1 · Each replica builds a Merkle tree',
      blurb:
        'For each token range, every replica hashes its data into a small Merkle tree — leaves hash buckets of keys, parents hash their children, up to one root. Comparing two trees top-down finds WHERE two replicas differ while exchanging only hashes, not data. (Real trees are deeper; we show 2 levels.)',
    },
    {
      key: 'compare',
      ms: 3000,
      title: '2 · Compare the trees',
      blurb:
        p.diffs.length === 0
          ? 'Root hashes match everywhere — the replicas hold identical data for these ranges, and the repair is done without moving a single row. That cheapness is the point of the Merkle exchange.'
          : `Some roots differ: descending into the mismatching branches pins the divergence down to ${p.diffs.length} key${p.diffs.length === 1 ? '' : 's'} (${p.diffs.map((d) => d.key).join(', ')}). Only those need to move.`,
    },
  ]
  if (p.diffs.length > 0) {
    steps.push({
      key: 'stream',
      ms: 2200, // overridden by duration() (streaming flights)
      title: '3 · Stream the differences',
      blurb:
        'The replicas exchange just the divergent entries; each side keeps the newer timestamp (last-write-wins, same rule as reads). Stale copies catch up, missing copies appear.',
    })
    steps.push({
      key: 'synced',
      ms: 2600,
      title: '4 · In sync',
      blurb:
        'Every up replica now agrees. Repair is the backstop of the three anti-entropy mechanisms — hints heal short outages, read repair heals what reads touch, and repair heals everything else. Operators run it on a schedule (and must, within gc_grace_seconds, so deletes propagate before tombstones are reclaimed).',
    })
  }
  return steps
}

export default {
  type: 'repair',
  label: 'Repair (anti-entropy)',
  steps: makeSteps,

  derive(c, op) {
    const p = op.payload
    if (p.diffs.length > 0 && op.step >= 2) {
      for (const d of p.diffs) {
        for (const nid of d.targets) {
          const n = c.nodes[nid]
          const cur = n.memtable[d.key]
          if (!cur || d.winner.ts > cur.ts) {
            n.memtable[d.key] = { ...d.winner }
            n.commitLog += 1
          }
        }
      }
    }
  },

  extra(cluster, op) {
    const s = op.step
    const p = op.payload
    const upNodes = Object.values(cluster.nodes)
      .filter((n) => n.up)
      .map((n) => n.id)

    let flights = []
    if (s === 2 && p.diffs.length > 0) {
      flights = p.diffs.flatMap((d, i) =>
        d.targets.map((nid, j) => ({
          key: `repair:${p.id}:${i}:${j}`,
          tokens: [
            {
              id: `repair-${p.id}-${i}-${j}`,
              term: d.winner.tombstone ? '🪦 ' + d.key : d.key,
              color: d.color,
            },
          ],
          fromSel: `[data-fly="${d.from}"]`,
          toSel: `[data-fly="${nid}"]`,
        })),
      )
    }

    return {
      focus: s === 2 ? [...new Set(p.diffs.flatMap((d) => [d.from, ...d.targets]))] : upNodes,
      flights,
      merkle: { comparisons: p.comparisons, compared: s >= 1, streamed: s >= 3 || (s >= 2 && p.diffs.length === 0) },
    }
  },

  duration: flightAwareDuration(),
}
