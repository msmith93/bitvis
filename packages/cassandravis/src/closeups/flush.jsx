import { motion } from 'framer-motion'
import { NODE_COLORS } from '../cluster'
import { fnv, DictView } from './shared'

const BLOOM_BITS = 16

// Close-up: one node's memtable flushing into an immutable SSTable, including
// the bloom filter's bits being set. `baseNode` is the node BEFORE the flush.
export function build(nodeId, baseNode, sstName, keysMeta) {
  const entries = Object.entries(baseNode.memtable) // insertion order
  const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b))
  // Two "hash functions" per key, like a real bloom filter's k probes.
  const bitsFor = (k) => [fnv(k) % BLOOM_BITS, fnv('probe2:' + k) % BLOOM_BITS]
  const setBits = new Set(sorted.flatMap(([k]) => bitsFor(k)))

  const steps = [
    {
      key: 'sort',
      title: '1 · Sort the memtable by key',
      blurb: 'The memtable already keeps its entries sorted (it is a sorted map — that is the "S" the SSTable inherits). Sorted order is what makes the file cheap to scan, merge, and binary-search later.',
    },
    {
      key: 'write',
      title: `2 · Write ${sstName} — sequentially, immutably`,
      blurb: 'The sorted entries stream to disk as ONE new SSTable: a Sorted String Table. It will never be edited — not by writes, not by deletes. This sequential write is the only way an SSTable is ever born.',
    },
    {
      key: 'bloom',
      title: '3 · Build the bloom filter',
      blurb: `Every key sets a couple of bits in a small bit array (${BLOOM_BITS} bits here). At read time, a key whose bits are not ALL set is definitely absent — skip the file. All-set bits mean only "maybe": another key may have set them (a false positive). Never a false negative.`,
    },
    {
      key: 'clear',
      title: '4 · Clear the memtable, truncate the commit log',
      blurb: `The data is durable in ${sstName}, so the memtable empties and the commit-log segments that covered it (${baseNode.commitLog} entr${baseNode.commitLog === 1 ? 'y' : 'ies'}) are recycled — they existed exactly for the crash-before-flush window that has now closed.`,
    },
  ]

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        <div className="cu-banner">
          <span className="node-dot" style={{ background: NODE_COLORS[nodeId] }} />
          <span className="cu-cell">{nodeId} · memtable → {sstName}</span>
        </div>

        <div className="cu-row block">
          <DictView
            label={`memtable — a sorted map, in memory${step >= 3 ? ' (cleared)' : ''}`}
            rows={
              step >= 3
                ? []
                : sorted.map(([k, e]) => ({
                    k,
                    entry: e,
                    color: keysMeta[k]?.color,
                    state: step === 0 ? undefined : 'dim',
                  }))
            }
            empty="empty — new writes start a fresh one"
          />
        </div>

        {step >= 1 && (
          <motion.div className="cu-row block ok" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <DictView
              label={`🔒 ${sstName} — immutable file on disk`}
              note="same sorted rows, streamed sequentially"
              rows={sorted.map(([k, e]) => ({
                k,
                entry: e,
                color: keysMeta[k]?.color,
                state: step === 1 ? 'new' : 'dim',
              }))}
              empty="empty"
            />
          </motion.div>
        )}

        {step >= 2 && (
          <motion.div className="cu-row" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <span className="cu-cell">◌ bloom filter</span>
            <span className="cu-bits">
              {Array.from({ length: BLOOM_BITS }, (_, i) => (
                <motion.span
                  key={i}
                  className={'cu-bit' + (setBits.has(i) ? ' set' : '')}
                  initial={false}
                  animate={{ scale: step === 2 && setBits.has(i) ? [1, 1.4, 1] : 1 }}
                  transition={{ delay: 0.2 + i * 0.05 }}
                >
                  {setBits.has(i) ? 1 : 0}
                </motion.span>
              ))}
            </span>
            <span className="cu-cell dim right">
              {sorted.map(([k]) => `${k}→{${bitsFor(k).join(',')}}`).join(' · ')}
            </span>
          </motion.div>
        )}

        {step >= 3 && (
          <motion.div className="cu-verdict ok" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            ✓ commit log: {baseNode.commitLog} → 0 — durability now lives in the SSTable
          </motion.div>
        )}
      </div>
    )
  }

  return {
    key: `flush-${nodeId}`,
    title: `${nodeId} · flush: memtable → ${sstName}`,
    sub: `${nodeId} · flush`,
    source: `[data-fly="${nodeId}"]`,
    steps,
    Stage,
  }
}
