import { statsForShard } from '../../ops/search'
import { B, K1, fmtScore, scoreDoc } from '../../relevance'
import { CostLine, SectionLabel } from '../shared'

// The deepest zoom on relevance: what one document's BM25 score is actually made
// of. Opened from a scored row in the shard close-up.
//
// This is a PERSISTENT stage in the coordMerge / dictionary style — the three
// factors and the per-term table are on screen for every step, and a step only
// changes what is lit. Swapping the content per step would turn the arithmetic
// into a slideshow, which is exactly what SPEC.md forbids for these panels.
//
// Everything rendered is read out of scoreDoc's perTerm, including the contrast
// score under the other statistics mode, which is computed by running the model
// again rather than being written into the copy.

const STEPS = [
  {
    key: 'tf',
    title: '1 · How often the term occurs here',
    blurb:
      'Term frequency — but SATURATING. k1 caps how much repetition can buy: the second occurrence adds a lot, the tenth adds almost nothing. That is why a page that says a word twenty times does not automatically beat one that says it twice.',
  },
  {
    key: 'idf',
    title: '2 · How rare the term is',
    blurb:
      'Inverse document frequency: a term that appears in nearly every document tells you almost nothing, so it is worth almost nothing. This is the factor that depends on WHOSE collection you ask about — and on a shard that holds fewer documents, the same term looks rarer than it really is.',
  },
  {
    key: 'norm',
    title: '3 · How long this document is',
    blurb:
      'The length norm, controlled by b. A hit in a short document is stronger evidence than the same hit buried in a long one, so the score is damped by this document’s length against the average length of the collection.',
  },
  {
    key: 'total',
    title: '4 · Adding the terms up',
    blurb:
      'Each query term contributes idf × saturation independently, and the document’s score is their sum. Nothing here is normalised to a 0–1 range: a BM25 score is only meaningful compared with other scores for the SAME query.',
  },
]

export function build({ shard, docId, search, docs, anchor }) {
  const doc = docs[docId]
  const stats = statsForShard(search, shard.id)
  const scored = scoreDoc(doc, search.patterns, stats)

  // The same document scored against the OTHER collection — this shard alone
  // versus the whole index. Derived by re-running the model, never asserted.
  const dfs = search.stats?.mode === 'global'
  const otherStats = dfs ? search.stats.perShard[shard.id] : search.stats?.global
  const other = otherStats ? scoreDoc(doc, search.patterns, otherStats) : null

  const rows = Object.entries(scored.perTerm)
    .map(([term, f]) => ({ term, ...f }))
    .sort((a, b) => b.contribution - a.contribution || a.term.localeCompare(b.term))

  return {
    key: `scoring-${shard.id}-${docId}`,
    title: (
      <>
        {docId} on shard {shard.id}
        <span className="si-sub"> — why it scored {fmtScore(scored.score)}</span>
      </>
    ),
    sub: `${docId} · BM25`,
    steps: STEPS,
    source: anchor,
    className: 'cu-panel sc-panel',
    Stage: ScoringStage,
    stageProps: {
      doc,
      rows,
      scored,
      stats,
      other,
      otherStats,
      dfs,
      shardId: shard.id,
      at: Object.fromEntries(STEPS.map((s, i) => [s.key, i])),
    },
  }
}

function ScoringStage({ step, rows, scored, stats, other, otherStats, dfs, shardId, at, doc }) {
  const lit = (key) => (step === at[key] ? ' lit' : '')
  // One shared scale so the contribution bars are comparable across terms.
  const widest = Math.max(...rows.map((r) => r.contribution), 0.0001)

  return (
    <>
      <div className="si-querybox">
        <div className="si-query-box">
          <span className="si-query-label">document</span>
          <span className="si-query-str">{doc.title}</span>
          <span className="si-arrow">→</span>
          <span className="score">{fmtScore(scored.score)}</span>
        </div>
      </div>

      <div className="si-scroll cu-scroll">
        <SectionLabel note="every term contributes idf × saturation, independently">
          the three factors
        </SectionLabel>

        {/* Persistent: all three are always drawn; the step only lights one. */}
        <div className="sc-factors">
          <Factor
            className={'sc-factor' + lit('tf')}
            name="saturation"
            formula={<>tf · (k₁+1) / (tf + norm)</>}
            note={<>k₁ = {K1}</>}
          >
            {rows.map((r) => (
              <div key={r.term} className="sc-mini">
                <span className="si-tf">{r.term}</span>
                <span className="sc-mini-num">tf {r.tf}</span>
                <span className="sc-mini-num">{r.saturation.toFixed(3)}</span>
              </div>
            ))}
          </Factor>

          <Factor
            className={'sc-factor' + lit('idf')}
            name="idf"
            formula={<>ln(1 + (N − n + 0.5) / (n + 0.5))</>}
            note={
              <>
                N = {stats.docCount}{' '}
                {dfs ? '(whole index)' : `(shard ${shardId} only)`}
              </>
            }
          >
            {rows.map((r) => (
              <div key={r.term} className="sc-mini">
                <span className="si-tf">{r.term}</span>
                <span className="sc-mini-num">n {r.docFreq}</span>
                <span className="sc-mini-num">{r.idf.toFixed(3)}</span>
              </div>
            ))}
          </Factor>

          <Factor
            className={'sc-factor' + lit('norm')}
            name="length norm"
            formula={<>k₁ · (1 − b + b · |D| / avgdl)</>}
            note={<>b = {B}</>}
          >
            <div className="sc-mini">
              <span className="sc-mini-key">|D|</span>
              <span className="sc-mini-num">{scored.length} terms</span>
            </div>
            <div className="sc-mini">
              <span className="sc-mini-key">avgdl</span>
              <span className="sc-mini-num">{scored.avgdl.toFixed(1)}</span>
            </div>
            <div className="sc-mini">
              <span className="sc-mini-key">norm</span>
              <span className="sc-mini-num">{(rows[0]?.norm ?? 0).toFixed(3)}</span>
            </div>
          </Factor>
        </div>

        <SectionLabel note={`${rows.length} matched term${rows.length === 1 ? '' : 's'}`}>
          what each term contributed
        </SectionLabel>

        <table className="sc-table">
          <thead>
            <tr>
              <th>term</th>
              <th className={'sc-col' + lit('tf')}>tf</th>
              <th className={'sc-col' + lit('idf')}>n</th>
              <th className={'sc-col' + lit('idf')}>idf</th>
              <th className={'sc-col' + lit('tf')}>sat</th>
              <th className={'sc-col' + lit('total')}>= contribution</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.term}>
                <td className="term">{r.term}</td>
                <td className={'sc-col' + lit('tf')}>{r.tf}</td>
                <td className={'sc-col' + lit('idf')}>{r.docFreq}</td>
                <td className={'sc-col' + lit('idf')}>{r.idf.toFixed(3)}</td>
                <td className={'sc-col' + lit('tf')}>{r.saturation.toFixed(3)}</td>
                <td className={'sc-col' + lit('total')}>
                  <span className="sc-bar-wrap">
                    <span
                      className="sc-bar"
                      style={{ width: `${(r.contribution / widest) * 100}%` }}
                    />
                  </span>
                  {fmtScore(r.contribution)}
                </td>
              </tr>
            ))}
            <tr className={'sc-total' + lit('total')}>
              <td colSpan={5}>score</td>
              <td>{fmtScore(scored.score)}</td>
            </tr>
          </tbody>
        </table>

        <StepNote
          step={step}
          at={at}
          rows={rows}
          scored={scored}
          stats={stats}
          other={other}
          otherStats={otherStats}
          dfs={dfs}
          shardId={shardId}
        />
      </div>
    </>
  )
}

function Factor({ className, name, formula, note, children }) {
  return (
    <section className={className}>
      <header className="sc-factor-head">
        <span className="sc-factor-name">{name}</span>
        <span className="sc-factor-formula">{formula}</span>
      </header>
      <div className="sc-factor-body">{children}</div>
      <footer className="sc-factor-foot">{note}</footer>
    </section>
  )
}

// The one line of copy that depends on where we are. Every number in it comes
// from the model above, including the contrast score.
function StepNote({ step, at, rows, scored, stats, other, otherStats, dfs, shardId }) {
  if (step === at.tf) {
    const top = rows[0]
    if (!top) return null
    // What a second copy of the top term would actually be worth, run through
    // the same formula rather than described.
    const next =
      ((top.tf + 1) * (K1 + 1)) / (top.tf + 1 + top.norm) - top.saturation
    return (
      <CostLine tone="good">
        “{top.term}” occurs <b>{top.tf}×</b> here, which saturates to{' '}
        <b>{top.saturation.toFixed(3)}</b> — and one more occurrence would add only{' '}
        <b>{next.toFixed(3)}</b>. Without k₁ this factor would just be {top.tf}.
      </CostLine>
    )
  }

  if (step === at.idf) {
    if (!other || !otherStats)
      return (
        <CostLine>
          Scored against <b>{stats.docCount}</b> documents.
        </CostLine>
      )
    const delta = scored.score - other.score
    const same = Math.abs(delta) < 1e-9
    return (
      <CostLine tone={same ? 'good' : 'warn'}>
        Scored against <b>{stats.docCount}</b> documents{' '}
        {dfs ? '(the whole index)' : `(shard ${shardId}’s own)`} this is{' '}
        <b>{fmtScore(scored.score)}</b>. Against <b>{otherStats.docCount}</b>{' '}
        {dfs ? `(shard ${shardId} alone)` : '(the whole index)'} the same document
        scores <b>{fmtScore(other.score)}</b>
        {same ? '.' : ` — a difference of ${fmtScore(Math.abs(delta))} that nothing about this document explains.`}
      </CostLine>
    )
  }

  if (step === at.norm)
    return (
      <CostLine tone={scored.length < scored.avgdl ? 'good' : undefined}>
        This document is <b>{scored.length}</b> terms against an average of{' '}
        <b>{scored.avgdl.toFixed(1)}</b>, so it is{' '}
        {scored.length < scored.avgdl ? 'rewarded' : 'damped'} relative to a
        typical one. Lucene stores this norm quantised into a single byte, so real
        scores step in coarser increments than these exact lengths give.
      </CostLine>
    )

  return (
    <CostLine>
      <b>{rows.length}</b> term{rows.length === 1 ? '' : 's'} summing to{' '}
      <b>{fmtScore(scored.score)}</b>. Comparable with other documents answering
      this query — and with nothing else.
    </CostLine>
  )
}
