import { motion } from 'framer-motion'
import { computeShardIdfs } from '../../ops/search'
import { INSPECTOR_DWELL_MS } from '../../timing'
import { idf, fmtScore } from '../../similarity'

// The close-up for the COORDINATOR during the dfs phase: every shard has
// reported what it alone thinks the query's terms are worth, and this is what
// the coordinator does with those numbers.
//
// It is deliberately the same picture, one level up, as the shard's own
// statistics step: per-source figures, a sum, one idf. The shard adds its
// SEGMENTS together; the coordinator adds its SHARDS together. In the model
// those are literally the same call (mergeStats in src/invertedIndex.js), and
// drawing them the same way is the point — nothing new happens up here, the
// scope just widens.
//
// The last step is the one a reader cannot guess: the totals do not stay on the
// coordinator. They ride back out with the query, and each shard then uses them
// to score AND to pick its own top `size` — so dfs can change which documents a
// shard sends, not merely what they are worth.
const STEPS = [
  {
    key: 'arrive',
    title: '1 · Every shard reports its own numbers',
    blurb:
      'Each shard looked the terms up in its own dictionaries and sent back two numbers per term: how many of its documents contain the term, and how many documents it holds. Nothing has been searched yet.',
  },
  {
    key: 'sum',
    title: '2 · Add them together',
    blurb:
      'The same addition each shard just did across its segments, done again across the shards. A term’s document frequency for the whole index is the sum of the per-shard ones, and the index’s document count is the sum of theirs.',
  },
  {
    key: 'send',
    title: '3 · One idf, sent back out with the query',
    blurb:
      'The totals give one idf per term for the entire index, and they go out attached to the query. Each shard scores with these instead of its own — and picks its top hits with them too, so the cut itself can change.',
  },
]

export function build({ search, query, anchor }) {
  const perTerm = computeShardIdfs(search)
  const global = search.globalStats
  return {
    key: 'coord-stats',
    title: (
      <>
        Node 1 · <span className="badge-coord">coordinator</span>
        <span className="si-sub"> — merging term statistics</span>
      </>
    ),
    sub: 'coordinator · term statistics',
    steps: STEPS,
    dwell: () => INSPECTOR_DWELL_MS,
    source: anchor,
    className: 'coord coord-stats',
    Stage: CoordStatsStage,
    stageProps: { perTerm, global, query, terms: search.terms },
  }
}

function CoordStatsStage({ step, perTerm, global, query, terms }) {
  const summed = step >= 1
  const sent = step >= 2

  return (
    <>
      {/* What was asked of every shard — terms, not documents. */}
      <div className="si-querybox">
        <div className="si-query-box">
          <span className="si-query-label">term stats?</span>
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
        <div className="si-block">
          <p className="section-title">
            {sent
              ? 'One idf per term, for the whole index'
              : summed
              ? 'Summed across every shard'
              : 'Reported by each shard'}
          </p>
          {perTerm.length === 0 ? (
            <div className="ss-none">no query term is in this index</div>
          ) : (
            <div className="ci-idf-spread">
              {perTerm.map((x) => {
                const df = global.byTerm.get(x.term)?.docFreq ?? 0
                return (
                  <div className="ci-idf-row" key={x.term}>
                    <span className="term-chip">{x.term}</span>
                    {/* What each shard said — and, beside it, the idf that shard
                        would have used on its own. Struck through once the
                        totals replace it, because being replaced IS the point. */}
                    {x.rows.map((r) => (
                      <span
                        key={r.shard}
                        className={
                          'ci-idf-cell' + (!r.docFreq ? ' dim' : summed ? ' replaced' : '')
                        }
                      >
                        shard {r.shard} ·{' '}
                        {r.docFreq
                          ? `${r.docFreq}/${r.docCount} → idf ${fmtScore(r.idf)}`
                          : 'not held'}
                      </span>
                    ))}
                    {summed && (
                      <motion.span
                        className="ci-idf-cell total"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ type: 'spring', stiffness: 320, damping: 24 }}
                      >
                        Σ {df}/{global.docCount} → idf {fmtScore(idf(df, global.docCount))}
                      </motion.span>
                    )}
                  </div>
                )
              })}
              <div className="si-stat-foot">
                {sent
                  ? `every shard scores — and cuts its top hits — with these, over ${global.docCount} Lucene docs`
                  : summed
                  ? `avg field length ${global.avgFieldLen.toFixed(1)} terms across ${global.docCount} Lucene docs`
                  : 'the same addition a shard does across its segments, one level up'}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
