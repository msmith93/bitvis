import { useEffect, useRef } from 'react'

// One segment's stored structures, as the shard-level close-ups draw them: the
// inverted index (term dictionary | postings) and the stored `_source` rows.
// This is the SAME card in both shard zooms, which is the point — a reader who
// learned the picture during the query phase must recognise it during the fetch
// phase rather than meeting a new one. Only the lighting differs:
//
//   query phase (stages/shardLocal.jsx)   the dictionary, then the postings.
//                                         `sourceHL` is FALSE — a query returns
//                                         ids and scores and opens no stored
//                                         field.
//   fetch phase (stages/shardFetch.jsx)   `sourceHL`, plus the winners' own
//                                         rows. The dictionary and the postings
//                                         are already done; the stored fields
//                                         are the whole job.
//
// `focus` is that per-step lighting, `magnify` is the 🔍 the host stage puts on
// the segment head (each opens the segment close-up in its own phase), and
// `scan`/`probeIdx` drive the wildcard probe replay, which only the query phase
// has.

// Which dictionary rows the replay has touched so far, for one segment. Returns
// null unless a probe replay is running, in which case the term dictionary is
// rendered from THIS rather than from "every matching term".
function probeView(scan, probeIdx) {
  if (!scan || probeIdx == null) return null
  const played = Math.min(probeIdx, scan.probes.length)
  const examined = new Set()
  const matched = new Set()
  for (let i = 0; i < played; i++) {
    const p = scan.probes[i]
    examined.add(p.i)
    if (p.match) matched.add(p.i)
  }
  const cur = played > 0 && probeIdx <= scan.probes.length ? scan.probes[played - 1] : null
  return {
    examined,
    matched,
    cursor: cur ? cur.i : null,
    phase: cur ? cur.phase : null,
    lo: cur && cur.phase === 'seek' ? cur.lo : null,
    hi: cur && cur.phase === 'seek' ? cur.hi : null,
    count: examined.size,
    done: played >= scan.probes.length,
  }
}

// One segment's stored structures: inverted index (term dictionary | postings)
// and the stored _source. The same card lights up differently depending on
// `focus` (which query step we're on) and, for a wildcard, on how far the
// dictionary probe replay has got.
export function AnatomyCard({
  seg,
  focus,
  docs,
  scan,
  probeIdx,
  showCost,
  wildcard,
  magnify,
  note,
}) {
  const { matches, dictHL, postingsHL, sourceHL, candidateSet } = focus
  // The Lucene docs a fetch is asking this segment for. Empty in the query
  // phase, which never opens a stored field at all.
  const fetching = focus.fetchIds ?? new Set()
  const rowsRef = useRef(null)
  const matchRef = useRef(null)
  const cursorRef = useRef(null)
  const view = probeView(scan, probeIdx)
  const cursor = view?.cursor ?? null

  // When the lookup highlight activates, scroll this segment's term dictionary so
  // its first matching term is in view. Contained to the .anat-ii-rows scroller.
  // Skipped while a probe replay is running — the cursor effect below owns
  // scrolling then.
  useEffect(() => {
    if (view || !dictHL || !rowsRef.current || !matchRef.current) return
    const rows = rowsRef.current
    const top =
      rows.scrollTop +
      (matchRef.current.getBoundingClientRect().top - rows.getBoundingClientRect().top)
    rows.scrollTo({ top, behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictHL, !!view])

  // Follow the probe. Instant, and only when the cursor has left the visible
  // box — a smooth scroll per tick would never settle at scan speed.
  useEffect(() => {
    if (cursor == null || !rowsRef.current || !cursorRef.current) return
    const rows = rowsRef.current
    const box = rows.getBoundingClientRect()
    const row = cursorRef.current.getBoundingClientRect()
    if (row.top < box.top || row.bottom > box.bottom)
      rows.scrollTop += row.top - box.top - box.height / 2 + row.height / 2
  }, [cursor])

  // Which rows of this segment's _source the block join touches: the children
  // that matched, and the documents they rolled up to. Empty on a flat dataset,
  // where a match is already the document you asked about.
  const joined = { children: new Set(), roots: new Set(), note: null }
  if (focus.joinHL) {
    for (const d of seg.docs)
      if (focus.joins.has(d.id)) {
        joined.children.add(d.id)
        joined.roots.add(focus.joins.get(d.id))
      }
    const n = joined.children.size
    if (n)
      joined.note = `${n} match${n === 1 ? '' : 'es'} on a variant · joined up to ${
        joined.roots.size
      } document${joined.roots.size === 1 ? '' : 's'}`
  }

  let firstMatchSeen = false
  return (
    <div className="anat-card">
      <div className="anat-card-head">
        <span className="anat-seg-id">
          <span className="lock">🔒</span> {seg.id}
          {magnify && (
            <button
              className={'magnify-btn inline' + (magnify.pulse ? ' tour-pulse' : '')}
              // The tour and the close-up anchor both find the 🔍 by this
              // attribute, and each phase has its own so a tip can name the one
              // it means.
              {...{ [magnify.attr]: seg.id }}
              title={magnify.title}
              onClick={magnify.onClick}
            >
              🔍
            </button>
          )}
        </span>
        {note && <span className="anat-card-note">{note}</span>}
      </div>

      <div className="anat-body">
        {/* inverted index: term dictionary | postings */}
        <div className="anat-ii" data-anat-ii={seg.id}>
          <div className="anat-ii-label">
            inverted index
            {showCost && scan && (
              <span className={'dict-cost' + (view?.done === false ? ' live' : '')}>
                {scan.mode === 'seek' ? 'seek · ' : 'full scan · '}
                examined {view ? view.count : scan.examined} / {scan.total}
              </span>
            )}
          </div>
          <div className="anat-ii-cols">
            <div className="anat-col-head">term dictionary</div>
            {/* No 🔍 of its own: the postings are the third tile of the segment
                close-up the 🔍 by the segment id opens, reached after the term
                index and the blocks the same way Lucene reaches them. The
                on-disk ENCODING of a list is still deliberately not modelled
                (see SPEC.md). */}
            <div className="anat-col-head">postings</div>
          </div>
          <div className="anat-ii-rows" ref={rowsRef}>
            {seg.terms.map(({ term, docIds }, i) => {
              const isQ = matches(term)
              // While the replay runs, a term only lights up once the scan has
              // actually reached it — that IS the lesson.
              const hit = view ? view.matched.has(i) : isQ && dictHL
              const dim = view ? !view.matched.has(i) : dictHL && !isQ
              const isFirstMatch = !view && isQ && !firstMatchSeen
              if (isFirstMatch) firstMatchSeen = true
              const isCursor = view && view.cursor === i
              return (
                <div
                  key={term}
                  ref={isCursor ? cursorRef : isFirstMatch ? matchRef : null}
                  className={
                    'anat-row' +
                    (hit ? ' term-active' : '') +
                    (dim ? ' dim' : '') +
                    (view?.examined.has(i) ? ' examined' : '') +
                    (isCursor ? ` probe-${view.phase}` : '') +
                    (view && view.lo === i ? ' probe-lo' : '') +
                    (view && view.hi === i ? ' probe-hi' : '')
                  }
                >
                  <span className="anat-term">{term}</span>
                  <span className="anat-postings">
                    {docIds.map((id) => {
                      const isCand = isQ && postingsHL && candidateSet.has(id)
                      return (
                        <DocChip key={id} id={id} docs={docs} hit={isCand} anchor={isCand} />
                      )
                    })}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* stored _source — also where the block join is shown, because these
            rows are the only place a Lucene doc appears WITH ITS CONTENT. A
            match lands on a variant; the client asked about a product; the two
            rows light up together and the note says how many rolled up. */}
        <div className={'anat-source' + (sourceHL ? ' active' : '')}>
          <div className="anat-ii-label">
            stored _source
            {joined.note && <span className="anat-join-note">{joined.note}</span>}
          </div>
          {seg.docs.map((d) => (
            <div
              className={
                'anat-doc' +
                (joined.children.has(d.id) ? ' matched-child' : '') +
                (joined.roots.has(d.id) ? ' joined-root' : '') +
                (fetching.has(d.id) ? ' fetching' : '')
              }
              key={d.id}
            >
              <DocChip id={d.id} docs={docs} />
              <span className="anat-doc-text">
                {d.label}
                {d.valueBags.length === 0 && d.detail ? ` — ${d.detail}` : ''}
              </span>
              {joined.children.has(d.id) && (
                <span className="anat-join-arrow" title="joined up to its document">
                  ↳
                </span>
              )}
              {fetching.has(d.id) && <span className="anat-fetch-flag">← this row</span>}
              {/* What `object` mapping produced: each sub-object's values poured
                  into a per-field list, the lists the same length, and nothing
                  saying which entry of one belongs with which entry of the next.
                  That missing link is why a two-clause query answers wrongly. */}
              {d.valueBags.length > 0 && (
                <div className="anat-bags">
                  {d.valueBags.map((f) => (
                    <div className="anat-bag" key={f.name}>
                      <span className="anat-bag-name">{f.name}</span>
                      <span className="anat-bag-vals">
                        {f.values.map((v, i) => (
                          <span className="anat-bag-val" key={`${v}-${i}`}>
                            {v}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                  <div className="anat-bag-note">
                    one list per field — nothing records which value went with which
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function DocChip({ id, docs, hit, anchor }) {
  const d = docs[id]
  return (
    <span
      data-posting-chip={anchor ? id : undefined}
      className={
        'doc-chip' +
        (d?.deleted ? ' deleted' : '') +
        (d?.purged ? ' purged' : '') +
        (hit ? ' hit' : '')
      }
      style={{ background: d?.color || '#888' }}
      title={
        d?.purged
          ? 'deleted — a refresh dropped it from search; still on disk until the next merge'
          : d?.deleted
          ? 'deleted — still searchable until the next refresh applies it'
          : undefined
      }
    >
      {id}
    </span>
  )
}
