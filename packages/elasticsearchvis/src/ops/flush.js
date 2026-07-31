// The `flush` op: commit segments to disk (durability) and clear the translog.
// Refresh ≠ flush — refresh made docs searchable; flush makes them durable.

const STEPS = [
  {
    key: 'commit',
    ms: 1200,
    title: '1 · Flush: commit segments to disk',
    blurb:
      'A flush fsyncs the segments to disk so they are durable. Refresh ≠ flush: refresh made docs searchable; flush makes them durable.',
  },
  {
    key: 'clear',
    ms: 1200,
    title: '2 · Translog cleared',
    blurb:
      'Because the data now lives in committed segments on disk, the translog can be safely cleared.',
  },
]

export default {
  type: 'flush',
  label: 'Flush / commit',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    for (const shard of c.shards) {
      if (s >= 0)
        shard.segments = shard.segments.map((seg) => ({ ...seg, committed: true }))
      if (s >= 1) shard.translog = []
    }
  },
}
