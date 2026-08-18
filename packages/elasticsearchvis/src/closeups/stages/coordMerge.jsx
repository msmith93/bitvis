import { Fragment } from 'react'
import { motion } from 'framer-motion'
import { COORD_MERGE_STEPS, computeCoordinatorMerge } from '../../ops/search'
import { fmtScore } from '../../relevance'

// The close-up for the coordinator during the gather/fetch phases: how the
// per-shard hit lists become one global ranking, and which full documents get
// fetched from which shards.
//
// Unlike the shard stage, every transition here is a framer `layout` glide —
// each hit chip stays mounted (keyed by docId) while the phases rearrange it
// (per-shard lanes → merged lane → sorted → cut → fetch groups → response).
//
// Step indices into COORD_MERGE_STEPS: arrive(0) merge(1) sort(2) cut(3)
// group(4) fetch(5).

export function build({ search, docs, query, anchor }) {
  const co = computeCoordinatorMerge(search)
  return {
    key: 'coordinator',
    title: (
      <>
        Node 1 · <span className="badge-coord">coordinator</span>
        <span className="si-sub"> — merge, rank &amp; fetch</span>
      </>
    ),
    sub: 'coordinator · merge & fetch',
    steps: COORD_MERGE_STEPS,
    source: anchor,
    className: 'coord',
    Stage: CoordMergeStage,
    stageProps: { co, docs, query, terms: search.terms },
  }
}

function CoordMergeStage({ step, co, docs, query, terms }) {
  return (
    <>
      {/* Persistent query strip — the terms were already analyzed back on the
          coordinator's first step, so no scan animation here. */}
      <div className="si-querybox">
        <div className="si-query-box">
          <span className="si-query-label">query</span>
          <span className="si-query-str">“{query}”</span>
          <span className="si-arrow">→</span>
          {terms.length ? (
            terms.map((t) => (
              <span key={t} className="term-chip">
                {t}
              </span>
            ))
          ) : (
            <em className="empty-note">no terms</em>
          )}
        </div>
      </div>

      <div className="si-scroll">
        <MergeStage step={step} co={co} docs={docs} />
      </div>
    </>
  )
}

// The single stage all six steps share: ONE persistent grid whose column count,
// headers, and chip annotations change per step, while the chips themselves stay
// mounted (keyed by docId) so framer's `layout` prop glides each one from its
// previous position. Chips are deliberately NOT given layoutIds — handing a
// layoutId between parents while the panel unmounts deadlocks framer's
// projection (the old CoordinatorInspector's exit animation never completed and
// the invisible backdrop kept swallowing clicks), which is why they live in one
// container instead.
function MergeStage({ step, co, docs }) {
  // Global rank of each winner, stable across the cut/group/fetch phases.
  const rank = new Map(co.winners.map((w, i) => [w.docId, i + 1]))

  const titles = [
    'Per-shard local hits — ids + scores only',
    'One merged list (concatenated, still unsorted)',
    'Global ranking (sorted by score)',
    `Top ${co.n} survive the cut`,
    'Fetch requests — one per shard holding a winner',
    'Ranked response — full documents in global order',
  ]

  // Per-step arrangement: headers (transient), chips (persistent, keyed by
  // docId), and the divider above the ranked-out hits. In multi-column steps
  // every cell gets an explicit grid position; in single-lane steps placement
  // falls back to chip order.
  let cols = 1
  let heads = []
  let chips = []
  let cutFrom = null // chip index the "ranked out" divider precedes

  if (step === 0) {
    cols = co.arrivals.length
    heads = co.arrivals.map((a, i) => ({
      key: `arr-${a.shard}`,
      cls: 'ci-col-head',
      col: i + 1,
      label: (
        <>
          shard {a.shard} · <span className={'role-badge ' + a.role}>{a.role}</span> on{' '}
          {a.node}
        </>
      ),
    }))
    chips = co.arrivals.flatMap((a, i) =>
      a.hits.map((h, j) => ({
        hit: { ...h, shard: a.shard },
        col: i + 1,
        row: j + 2,
        delay: j * 0.07,
      })),
    )
  } else if (step === 1) {
    chips = co.arrivals.flatMap((a) =>
      a.hits.map((h) => ({ hit: { ...h, shard: a.shard }, showShard: true })),
    )
  } else if (step === 2) {
    chips = co.merged.map((h) => ({ hit: h, showShard: true }))
  } else if (step === 3) {
    chips = co.merged.map((h) => ({
      hit: h,
      showShard: true,
      rank: rank.get(h.docId) ?? null,
      dim: !rank.has(h.docId),
    }))
    if (co.cut.length > 0) cutFrom = co.winners.length
  } else if (step === 4) {
    const sids = Object.keys(co.byShard).map(Number).sort((a, b) => a - b)
    cols = sids.length
    heads = sids.map((sid, i) => {
      const sv = co.arrivals.find((a) => a.shard === sid)
      return {
        key: `get-${sid}`,
        cls: 'ci-fetch-head',
        col: i + 1,
        label: (
          <>
            GET _source → shard {sid}
            {sv && (
              <span className="ci-fetch-addr">
                ({sv.role} on {sv.node})
              </span>
            )}
          </>
        ),
      }
    })
    chips = sids.flatMap((sid, i) =>
      co.byShard[sid].map((h, j) => ({
        hit: h,
        col: i + 1,
        row: j + 2,
        rank: rank.get(h.docId),
      })),
    )
  } else {
    chips = co.winners.map((h) => {
      const d = docs[h.docId]
      return {
        hit: h,
        rank: rank.get(h.docId),
        showShard: true,
        body: d ? `${d.title}${d.body ? ` — ${d.body}` : ''}` : '',
      }
    })
  }

  return (
    <div className="si-block">
      <p className="section-title">{titles[step]}</p>
      <motion.div
        layout
        className="ci-stage"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {heads.map((h) => (
          <motion.div
            key={h.key}
            className={h.cls}
            style={{ gridColumn: h.col, gridRow: 1 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            {h.label}
          </motion.div>
        ))}
        {step === 0 &&
          co.arrivals.map(
            (a, i) =>
              a.hits.length === 0 && (
                <div
                  key={`none-${a.shard}`}
                  className="ss-none"
                  style={{ gridColumn: i + 1, gridRow: 2 }}
                >
                  no hits
                </div>
              ),
          )}
        {chips.map((c, i) => (
          <Fragment key={c.hit.docId}>
            {i === cutFrom && (
              <motion.div
                className="ci-cut-divider"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                ranked out — full doc never fetched:
              </motion.div>
            )}
            <HitChip {...c} docs={docs} />
          </Fragment>
        ))}
      </motion.div>
      {step === 5 && (
        <div className="si-return-note" style={{ marginTop: 10 }}>
          ↩ returned to client
        </div>
      )}
    </div>
  )
}

function HitChip({ hit, docs, rank, showShard, dim, body, delay = 0, col, row }) {
  return (
    <motion.div
      layout
      className={'si-lane-item' + (dim ? ' ci-cut-chip' : '')}
      style={col != null ? { gridColumn: col, gridRow: row } : undefined}
      initial={{ opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: 'spring', stiffness: 360, damping: 28, delay }}
    >
      {rank != null && <span className="si-rank">#{rank}</span>}
      <DocChip id={hit.docId} docs={docs} hit={!dim} />
      {body != null && <span className="ci-doc-body">{body}</span>}
      <span className="score">{fmtScore(hit.score)}</span>
      {showShard && <span className="ci-shard-tag">shard {hit.shard}</span>}
    </motion.div>
  )
}

function DocChip({ id, docs, hit }) {
  const d = docs[id]
  return (
    <span
      className={'doc-chip' + (d?.deleted ? ' deleted' : '') + (hit ? ' hit' : '')}
      style={{ background: d?.color || '#888' }}
    >
      {id}
    </span>
  )
}
