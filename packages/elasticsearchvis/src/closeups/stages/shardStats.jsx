import { motion } from 'framer-motion'
import { segmentAnatomy, segmentStats, shardStats } from '../../invertedIndex'
import { INSPECTOR_DWELL_MS } from '../../timing'
import { idf, fmtScore } from '../../similarity'
import { matchesAny } from '../../wildcard'
import { AnatomyCard } from '../anatomy'

// The close-up for a shard during the DFS phase: dfs_query_then_fetch has asked
// it what the query's terms are worth, and this is what it does to answer.
//
// It draws the SAME segment anatomy the query-phase and fetch-phase close-ups
// draw (see anatomy.jsx) — the same cards, in the same place — because the whole
// lesson is a comparison between what the three phases REACH INTO. The query
// phase lights the term dictionary and then the postings; the fetch phase lights
// only the stored fields; this phase lights the dictionary and stops there.
//
// That stopping is the accurate picture, not a simplification. Elasticsearch's
// DfsPhase calls createWeight() on a searcher wrapped to record statistics, and
// Lucene's TermStates.build() seeks each segment's term dictionary and reads
// docFreq() / totalTermFreq() out of the term's metadata — it never obtains a
// PostingsEnum. No document is scored and no hit is collected. The `.doc`
// pointer sitting in the term row goes unfollowed, which is exactly why that
// statistic is stored in the term metadata at all (see src/postings.js).
const STEPS = [
  {
    key: 'request',
    title: '1 · A statistics request arrives',
    blurb:
      'Not a search: the coordinator is asking what the query’s terms are worth, not which documents match them. What comes back will be numbers — no ids, no scores, no documents.',
  },
  {
    key: 'seek',
    title: '2 · Look each term up, and stop there',
    blurb:
      'Every segment’s term dictionary is seeked exactly as a search would seek it — and then it ends. The term’s row already carries how many documents contain it, so the posting list beside it is never opened. Click a segment’s 🔍 to watch where it stops.',
  },
  {
    key: 'report',
    title: '3 · Sum and report',
    blurb:
      'The per-segment figures are added up and the totals go back to the coordinator, which sums them again across every shard. Nothing else leaves this shard — and nothing here was scored.',
  },
]

export function build({ shard, search, docs, query, anchor }) {
  const anatomy = shard.segments.filter((s) => s.searchable).map((s) => segmentAnatomy(s, docs))
  const own = shardStats(shard, docs)
  // The terms this shard can actually report on: the ones the query matched in
  // its dictionaries. For a pattern that is the expansion, each with its own
  // frequencies — see SPEC.md on how real Elasticsearch rewrites those.
  const terms = [...own.byTerm.keys()].filter((t) => matchesAny(t, search.patterns)).sort()
  const perSeg = shard.segments
    .filter((s) => s.searchable)
    .map((s) => ({ id: s.id, ...segmentStats(s, docs) }))
  const sv = search.serving[shard.id]
  return {
    key: `stats-${shard.id}`,
    title: (
      <>
        shard {shard.id} · <span className={'role-badge ' + sv.role}>{sv.role}</span> on {sv.node}
        <span className="si-sub"> — term statistics</span>
      </>
    ),
    sub: `shard ${shard.id} · term statistics`,
    steps: STEPS,
    dwell: () => INSPECTOR_DWELL_MS,
    source: anchor,
    Stage: ShardStatsStage,
    stageProps: { shardId: shard.id, anatomy, own, perSeg, terms, docs, query, global: search.globalStats },
  }
}

function ShardStatsStage({ step, openCloseUp, shardId, anatomy, own, perSeg, terms, docs, query, global }) {
  const sought = step >= 1
  const reported = step >= 2
  // The dictionary, and nothing under it. `postingsHL` stays false on every
  // step — a statistics request never reaches the posting lists, and this is
  // the one picture where that can be seen.
  const focus = {
    matches: (term) => terms.includes(term),
    candidateSet: new Set(),
    joins: new Map(),
    joinHL: false,
    dictHL: sought,
    postingsHL: false,
    sourceHL: false,
  }

  return (
    <>
      {/* What was asked for: terms, not documents. */}
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
            <em className="empty-note">no query term is in this shard</em>
          )}
        </div>
      </div>

      <div className="si-scroll">
        {sought && (
          <div className="si-block">
            <p className="section-title">
              {reported ? 'Summed, and sent to the coordinator' : 'Read off each segment’s term row'}
            </p>
            {terms.length === 0 ? (
              <div className="ss-none">nothing to report</div>
            ) : (
              <div className="si-stats">
                {terms.map((term) => {
                  const df = own.byTerm.get(term)?.docFreq ?? 0
                  return (
                    <motion.div
                      className="si-stat-row"
                      key={term}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ type: 'spring', stiffness: 340, damping: 28 }}
                    >
                      <span className="term-chip">{term}</span>
                      <span className="si-stat-sum">
                        {perSeg.map((seg, i) => (
                          <span key={seg.id}>
                            {i > 0 && <span className="si-stat-plus">+</span>}
                            <span className="si-stat-seg" title={`docFreq in ${seg.id}`}>
                              {seg.id} {seg.byTerm.get(term)?.docFreq ?? 0}
                            </span>
                          </span>
                        ))}
                        {reported && (
                          <>
                            <span className="si-stat-eq">=</span>
                            <span className="si-stat-df">
                              docFreq {df} of {own.docCount}
                            </span>
                          </>
                        )}
                      </span>
                      {/* The idf this shard would have used ALONE, which is the
                          number dfs exists to replace. Only shown once the
                          totals are in, and only as the contrast. */}
                      {reported && (
                        <span className="score">
                          alone: idf {fmtScore(idf(df, own.docCount))}
                        </span>
                      )}
                    </motion.div>
                  )
                })}
                {reported && global && (
                  <div className="si-stat-foot">
                    the coordinator adds this to every other shard’s and sends back one set of
                    totals — {global.docCount} Lucene docs across the index
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <p className="section-title">Segment anatomy — what this shard stores</p>
        <div className="si-anatomy">
          {anatomy.length === 0 ? (
            <div className="empty-note small">nothing searchable on this shard</div>
          ) : (
            anatomy.map((seg) => (
              <AnatomyCard
                key={seg.id}
                seg={seg}
                focus={focus}
                docs={docs}
                note={
                  sought
                    ? 'the posting lists below are NOT read to answer this — the count is in the term row'
                    : null
                }
                magnify={
                  openCloseUp && sought
                    ? {
                        attr: 'data-anat-stats',
                        title: 'Inside this segment: where a statistics request stops',
                        onClick: () =>
                          openCloseUp({ kind: 'segment', shard: shardId, seg: seg.id, phase: 'stats' }),
                      }
                    : null
                }
              />
            ))
          )}
        </div>
      </div>
    </>
  )
}
