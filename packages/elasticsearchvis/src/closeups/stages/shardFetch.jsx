import { computeCoordinatorMerge } from '../../ops/search'
import { segmentAnatomy } from '../../invertedIndex'
import { locateInShard } from '../../storedFields'
import { INSPECTOR_DWELL_MS } from '../../timing'
import { AnatomyCard, DocChip } from '../anatomy'

// The close-up for a shard during the FETCH phase: the coordinator has cut the
// global ranking and asks this shard for the _source of the winners it holds.
//
// It draws the SAME segment anatomy as the query-phase close-up
// (stages/shardLocal.jsx) — the same cards, in the same place — because it is
// the same shard and the same segments, and the reader has to see that the
// second phase reaches into the part of them the first phase left alone. The
// query phase lights the term dictionary and then the postings and never
// touches the stored `_source`; here nothing above is lit and the `_source`
// rows are the whole job. That contrast IS the two-phase lesson, and it only
// lands if both phases draw one picture.
//
// The step in between is the one thing a reader would not guess: the query
// phase handed back ids and scores and forgot everything else, so before this
// shard can open a file it has to turn each id back into a segment and an
// ordinal within it. Each segment then carries a 🔍 into the segment close-up
// (stages/segment.jsx, `phase: 'fetch'`), where the stored fields are read.

const STEPS = [
  {
    key: 'request',
    title: '1 · GET _source arrives',
    blurb:
      'The coordinator names the winners this shard holds — and only those. Everything this shard reported that was ranked out never comes up again; its documents stay on disk unread. Note what the request contains: ids. That is all the coordinator ever had.',
  },
  {
    key: 'resolve',
    title: '2 · Turn each id back into a segment + ordinal',
    blurb:
      'The query phase handed back ids and scores and forgot everything else. A shard is several segments, so each id is mapped to the one segment that holds it and to its ordinal there — the row number the stored-fields file is indexed by.',
  },
  {
    key: 'read',
    title: '3 · Read the stored _source',
    blurb:
      'This is the column the query phase never touched. The term dictionary and the posting lists above it did their work already and are not consulted again; what the client is owed is the document, and the document is down here. Click a segment’s 🔍 to watch that read happen on disk.',
  },
]

export function build({ shard, search, docs, query, anchor }) {
  const co = computeCoordinatorMerge(search)
  const winners = co.byShard[shard.id] ?? []
  const rank = new Map(co.winners.map((w, i) => [w.docId, i + 1]))
  const rows = winners.map((w) => {
    const at = locateInShard(shard, w.docId)
    return {
      id: w.docId,
      score: w.score,
      rank: rank.get(w.docId),
      segId: at?.seg?.id ?? null,
      ord: at?.ord ?? null,
    }
  })
  // The same anatomy the query-phase close-up draws — every searchable segment,
  // not only the ones holding a winner, because a shard that has to look in one
  // of several segments is exactly what the resolve step is about.
  const anatomy = shard.segments
    .filter((s) => s.searchable)
    .map((s) => segmentAnatomy(s, docs))
  const idsBySeg = {}
  for (const r of rows) if (r.segId) (idsBySeg[r.segId] ||= []).push(r)
  const sv = search.serving[shard.id]
  return {
    key: `fetch-${shard.id}`,
    title: (
      <>
        shard {shard.id} · <span className={'role-badge ' + sv.role}>{sv.role}</span> on {sv.node}
        <span className="si-sub"> — fetch phase</span>
      </>
    ),
    sub: `shard ${shard.id} · fetch phase`,
    steps: STEPS,
    dwell: () => INSPECTOR_DWELL_MS,
    source: anchor,
    Stage: ShardFetchStage,
    stageProps: { shardId: shard.id, rows, anatomy, idsBySeg, docs, query },
  }
}

function ShardFetchStage({ step, openCloseUp, shardId, rows, anatomy, idsBySeg, docs, query }) {
  const resolved = step >= 1
  const reading = step >= 2
  // Nothing above the stored fields is ever lit here: that is the point.
  const focus = {
    matches: () => false,
    candidateSet: new Set(),
    joins: new Map(),
    joinHL: false,
    dictHL: false,
    postingsHL: false,
    sourceHL: reading,
    fetchIds: reading ? new Set(rows.map((r) => r.id)) : new Set(),
  }

  return (
    <>
      {/* Persistent request strip, the fetch phase's answer to the query box:
          what was asked for, and by whom. */}
      <div className="si-querybox">
        <div className="si-query-box">
          <span className="si-query-label">GET _source</span>
          <span className="si-query-str">winners of “{query}”</span>
          <span className="si-arrow">→</span>
          {rows.length ? (
            rows.map((r) => (
              <span key={r.id} className="si-lane-item sf-winner">
                <span className="si-rank">#{r.rank}</span>
                <DocChip id={r.id} docs={docs} hit />
                <span className="score">{r.score}</span>
              </span>
            ))
          ) : (
            <em className="empty-note">no winners on this shard</em>
          )}
        </div>
      </div>

      <div className="si-scroll">
        <div className="si-block">
          <p className="section-title">
            {resolved
              ? 'Each id → the segment that holds it, and its ordinal there'
              : `${rows.length} winning id${rows.length === 1 ? '' : 's'} — no positions yet`}
          </p>
          <div className="sf-rows">
            {rows.map((r) => (
              <div key={r.id} className={'sf-row' + (resolved ? ' resolved' : '')}>
                <span className="si-rank">#{r.rank}</span>
                <DocChip id={r.id} docs={docs} hit />
                <span className="si-join-arrow">→</span>
                {resolved ? (
                  r.segId ? (
                    <span className="sf-where">
                      <span className="lock">🔒</span> {r.segId} · ordinal{' '}
                      <b className="seg-ord">{r.ord}</b>
                    </span>
                  ) : (
                    <span className="sf-where none">no searchable segment holds it</span>
                  )
                ) : (
                  <span className="sf-where pending">which segment? which row?</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <p className="section-title">Segment anatomy — what this shard stores</p>
        <div className="si-anatomy">
          {anatomy.length === 0 ? (
            <div className="empty-note small">nothing searchable on this shard</div>
          ) : (
            anatomy.map((seg) => {
              const mine = idsBySeg[seg.id] ?? []
              return (
                <AnatomyCard
                  key={seg.id}
                  seg={seg}
                  focus={{ ...focus, fetchIds: mine.length ? focus.fetchIds : new Set() }}
                  docs={docs}
                  note={
                    resolved &&
                    (mine.length
                      ? `ordinal${mine.length === 1 ? '' : 's'} ${mine.map((r) => r.ord).join(', ')} wanted`
                      : 'no winner here — never opened')
                  }
                  magnify={
                    openCloseUp &&
                    mine.length > 0 && {
                      attr: 'data-anat-fetch',
                      pulse: reading,
                      title: 'Watch the stored fields being read for these ordinals',
                      onClick: () =>
                        openCloseUp({
                          kind: 'segment',
                          shard: shardId,
                          seg: seg.id,
                          phase: 'fetch',
                          ids: mine.map((r) => r.id),
                        }),
                    }
                  }
                />
              )
            })
          )}
        </div>
      </div>
    </>
  )
}
