import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { deriveDictionary, narrateDictionary, FstTile, BlocksTile } from './dictionary'
import { buildPostings, postingsWalk, hexFp as docHex } from '../../postings'
import { buildStoredFields, hexFp as fdtHex } from '../../storedFields'
import { SourceField, sourceEntries } from '../../components/sourceView'
import { matchesAny } from '../../wildcard'
import { hexAddr, scrollTileTo, useReveal } from '../shared'
import {
  CU_DWELL_MS,
  BLOCK_READ_MS,
  POSTING_STEP_MS,
  FETCH_STEP_MS,
  SEG_ZOOM_OUT_MS,
  SEG_GRID_DWELL_MS,
  SEG_ZOOM_IN_MS,
} from '../../timing'

// The deepest zoom: INSIDE one segment. Four tiles — the term index (.tip, in
// memory), the term blocks (.tim), the postings (.doc) and the stored fields
// (.fdt) — laid out as a grid, and a tour that dives into them in the order a
// query reads them. The lesson is the chain: .tip finds a BLOCK, .tim finds the
// TERM ROW, .doc turns it into ORDINALS, and .fdt is where those ordinals are
// row addresses — read later, in the fetch phase, for the winners only.
// Collapsing that chain ("the index points at the document") is the natural
// mistake, and the tiles exist so a reader cannot make it.
//
// Two rules, both inherited from the rest of the app:
//
//   ONE PICTURE, PER TILE. Every tile is mounted for every step (at grid scale
//   it shows its glyph, name and a status line that advances with the tour); a
//   step only changes which tile the camera is on and what is lit inside it.
//   Nothing swaps content per step — see SPEC.md for why that rule exists.
//
//   THE ZOOM LOOKS LIKE THE ZOOM. Diving into a tile is the same choreography
//   App uses to dive into a shard: the grid rushes toward the tile and fades
//   (the .layout tween, transform-origin at the tile) while the tile's panel
//   springs out of it (the CloseUp entrance spring). Zooming back is the tween
//   reversed. Between two tiles the grid is held for a beat so the hand-off can
//   be read off the status lines. That is a CAMERA inside one close-up panel,
//   not a stack of nested panels: one clock, one stepper, and Prev/Next can
//   scrub across a tile boundary.
//
// Two phases share the panel. The QUERY phase (opened from the shard close-up's
// segment 🔍 during local search) tours .tip → .tim → .doc and leaves .fdt
// dimmed with "later" on it. The FETCH phase (opened from the fetch-step 🔍 on
// a shard, via stages/shardFetch.jsx) arrives with the winners' ids, dims the
// three tiles the query phase already used, and dives into .fdt alone.

const TILES = [
  { id: 'fst', ext: '.tip', name: 'term index', where: 'ram', what: 'a small automaton over block prefixes' },
  { id: 'tim', ext: '.tim', name: 'term blocks', where: 'disk', what: 'the dictionary, in prefix-compressed blocks' },
  { id: 'doc', ext: '.doc', name: 'postings', where: 'disk', what: 'per term: which ordinals, and how often' },
  { id: 'fdt', ext: '.fdt', name: 'stored fields', where: 'disk', what: '_id and _source, by ordinal' },
]
// Grid quadrant of each tile — the camera aims by geometry, not by measuring a
// grid that may be mid-tween.
const QUADRANT = { fst: [0, 0], tim: [1, 0], doc: [0, 1], fdt: [1, 1] }

const QUERY_STEPS = [
  {
    key: 'overview',
    tile: null,
    title: '1 · Inside a segment',
    blurb:
      'Four of the main segment structure are shown below: The term index, the term blocks, the postings (the real inverted index), and the stored fields (unused until the fetch phase).',
  },
  { key: 'walk', tile: 'fst', title: '2 · Follow the query through the index' },
  { key: 'read', tile: 'tim', title: '3 · Only what survives leaves the disk' },
  { key: 'found', tile: 'tim', title: '4 · What that bought you' },
  { key: 'postings', tile: 'doc', title: '5 · Follow the pointer into the postings' },
  {
    key: 'done',
    tile: null,
    title: '6 · The query phase, inside one segment',
    blurb:
      'An in-memory walk, one block read, one posting list — and the shard now holds ordinals and scores, nothing else. The stored fields, where the _source you will see in the response actually lives, stay on disk until the coordinator has cut the global ranking and comes back for the winners: that is the fetch phase, one 🔍 later in this search.',
  },
]

// Plain-term mode splits those two middle steps differently from a pattern: the
// FST walk finishes with ONE block address in hand and nothing off the disk yet
// (`read`, still on the .tip tile), and reading that block is its own step
// (`found`, the dive into .tim). A pattern/fuzzy keeps the names above.
const TERM_STEP_OVERRIDES = {
  read: { tile: 'fst', title: '3 · Term address is found' },
  found: { tile: 'tim', title: '4 · Reading the term block' },
}

const POSTINGS_BLURBS = {
  term:
    'Follow the pointer the term row carried. What sits at that address is the posting list: the segment-local ORDINAL of every Lucene doc containing the term, with how often it occurs there — read forwards, one entry at a time. The documents themselves are never touched. The scorer only ever sees these numbers, and the ordinal is also the row address in the stored-fields file, which is where the text is.',
  pattern:
    'The pattern expanded to several terms, so several posting lists are read and their ordinals unioned — that OR is the whole query from here on. Each entry is an ordinal and a frequency, and nothing about the text: the scorer works on these numbers alone.',
  fuzzy:
    'Every term within the edit budget has a posting list of its own, and each is read and unioned — the fuzzy query is an OR over them from here on. Each entry is an ordinal and a frequency, and nothing about the text: the scorer works on these numbers alone.',
}

const FETCH_STEPS = [
  {
    key: 'overview',
    tile: null,
    title: '1 · Back inside the segment, for the winners',
    blurb:
      'The query phase already turned the term into ordinals and scores here, and the coordinator has picked the winners. Now it wants their documents, and only theirs. The request names ordinals, and the only structure opened is the one the query phase never touched: the stored fields.',
  },
  {
    key: 'locate',
    tile: 'fdt',
    title: '2 · Look the ordinal up in .fdx',
    blurb:
      'The stored fields are written in compressed chunks, and .fdx is the small index beside them: for an ordinal it names the chunk that holds the row. One lookup per requested ordinal, and nothing else in the file is considered.',
  },
  {
    key: 'read',
    tile: 'fdt',
    title: '3 · Decompress the chunk, read the row',
    blurb:
      'The chunk comes off the disk and is decompressed, and the row for the ordinal comes out: _id, and _source — the original JSON exactly as it was indexed, untouched by the mapping. The neighbouring rows in the chunk were decompressed too, and thrown away. A nested child has nothing here worth returning; its document’s _source is on the block root.',
  },
  {
    key: 'done',
    tile: null,
    title: '4 · Only the winners were fetched',
    blurb:
      'Documents the coordinator ranked out never left the disk — that is the point of two phases. The _source of each winner flies back to the coordinator, which slots it into the ranked response.',
  },
]

export function build({ shard, seg, segId, rows, docs, term, patterns, phase = 'query', ids = [], anchor }) {
  const postings = buildPostings(seg, rows, docs)
  const sf = buildStoredFields(seg, docs)
  const fetch = phase === 'fetch'

  // The dictionary models run for the query tour only. A fetch-phase visit
  // dims those tiles and needs nothing from them.
  const d = fetch ? null : deriveDictionary({ shard, segId, rows, term, patterns })
  const walk = d ? postingsWalk(postings, d.matchedTerms) : null

  // The ordinals the fetch asks for, in the coordinator's rank order.
  const wanted = fetch
    ? ids.map((id) => sf.rows.find((r) => r.id === id)).filter(Boolean)
    : []

  const steps = (fetch ? FETCH_STEPS : QUERY_STEPS).map((s) => {
    if (fetch || s.blurb) return s
    const base = d.mode === 'term' && TERM_STEP_OVERRIDES[s.key] ? { ...s, ...TERM_STEP_OVERRIDES[s.key] } : s
    if (s.key === 'postings') return { ...base, blurb: POSTINGS_BLURBS[d.mode] }
    return { ...base, blurb: d.blurbs[s.key] }
  })
  const at = Object.fromEntries(steps.map((s, i) => [s.key, i]))
  const tileOf = (i) => {
    const s = steps[i]
    if (!s) return null
    // The fuzzy payoff is the machine finishing the word, which lives in the
    // automaton grid — so its found step dives back to the in-memory tile.
    if (s.key === 'found' && d?.mode === 'fuzzy' && d.matched) return 'fst'
    return s.tile
  }

  // How long the camera needs to reach step i from step i-1 (see cameraBeats).
  const camMs = (i) => cameraBeats(tileOf(i), i > 0 ? tileOf(i - 1) : null).total

  const replayMs = (i) => {
    const key = steps[i].key
    if (fetch) {
      if (key === 'locate') return Math.max(CU_DWELL_MS, wanted.length * FETCH_STEP_MS + 900)
      if (key === 'read') return Math.max(CU_DWELL_MS, wanted.length * FETCH_STEP_MS + 1200)
      return CU_DWELL_MS
    }
    // Floored: a follows-only pattern walk can be three arcs long, which would
    // otherwise hurry the step past its own blurb.
    if (key === 'walk') return Math.max(CU_DWELL_MS, Math.min(d.units, 40) * d.tick + 900)
    // The block-read replay is budgeted on whichever step actually reads it
    // (`found` for a plain term, `read` otherwise — see d.blockReadStep).
    if (key === d.blockReadStep)
      return Math.max(CU_DWELL_MS, Math.min(d.reads.rowUnits, 40) * BLOCK_READ_MS + 900)
    if (key === 'found' && d.mode === 'fuzzy' && d.matched)
      return Math.max(CU_DWELL_MS, d.matched.path.steps.length * d.tick + 1200)
    if (key === 'postings') return Math.max(CU_DWELL_MS, Math.min(walk.units, 40) * POSTING_STEP_MS + 900)
    if (key === 'overview') return CU_DWELL_MS + 1500
    return CU_DWELL_MS
  }
  const dwell = (i) => camMs(i) + replayMs(i)

  // How many sub-units each step's replay has — what the mini-stepper's
  // Prev/Next scrub through one at a time. A fresh closure on every re-derive,
  // so the shell must not put it in a dep array.
  const units = (i) => {
    const key = steps[i].key
    if (fetch) return key === 'locate' || key === 'read' ? Math.max(1, wanted.length) : 1
    if (key === 'walk') return d.units
    if (key === d.blockReadStep) return d.reads.rowUnits
    if (key === 'found' && d.mode === 'fuzzy' && d.matched) return d.matched.path.steps.length
    if (key === 'postings') return walk.units
    return 1
  }

  const title = fetch ? (
    <>
      {segId} · inside the segment
      <span className="si-sub"> — fetching {wanted.length} winner{wanted.length === 1 ? '' : 's'}’ _source</span>
    </>
  ) : (
    <>{segId} · inside the segment</>
  )

  return {
    key: `segment-${shard.id}-${segId}-${phase}-${fetch ? ids.join(',') : d.mode === 'term' ? term : d.pattern.raw}`,
    title,
    sub: segId,
    steps,
    dwell,
    units,
    narrate: d ? (i, subAt) => narrateDictionary(d, at, i, subAt) : null,
    source: anchor,
    className: 'cu-panel',
    Stage: SegmentStage,
    stageProps: { d, postings, walk, sf, wanted, phase, at, tileOf, patterns, docs, segId, steps },
  }
}

// The camera's beats for moving from tile `from` to tile `to`: zoom back out
// (unless already on the grid), hold the grid, dive (unless the target is the
// grid). Shared by the stage's effect and build()'s dwell so the two agree.
function cameraBeats(to, from) {
  if (to === from) return { out: 0, hold: 0, dive: 0, total: 0 }
  const out = from != null ? SEG_ZOOM_OUT_MS : 0
  const hold = from != null && to != null ? SEG_GRID_DWELL_MS : 0
  const dive = to != null ? SEG_ZOOM_IN_MS : 0
  return { out, hold, dive, total: out + hold + dive }
}

function SegmentStage({
  step,
  sub,
  active,
  d,
  postings,
  walk,
  sf,
  wanted,
  phase,
  at,
  tileOf,
  patterns,
  docs,
  segId,
  steps,
}) {
  const fetch = phase === 'fetch'
  const target = tileOf(step)
  const box = useRef(null)

  // ---- the camera --------------------------------------------------------
  // `focus` is the tile the panel is on (null = the grid); `landed` flips once
  // its spring has settled, and replays wait for it. `origin` is the grid's
  // transform-origin (the tile being dived into or out of) and `from` the
  // spring's start offset, both from the tile's quadrant of the stage box.
  const [cam, setCam] = useState({ focus: null, landed: true, origin: '50% 50%', from: null })
  const prevStep = useRef(step)
  const subRef = useRef(sub)
  subRef.current = sub

  useEffect(() => {
    const forward = step > prevStep.current
    prevStep.current = step
    if (!active) return
    let timers = []
    const later = (fn, ms) => timers.push(setTimeout(fn, ms))
    const aim = (tile) => {
      const [col, row] = QUADRANT[tile]
      const r = box.current?.getBoundingClientRect()
      const w = r?.width ?? 800
      const h = r?.height ?? 500
      return {
        origin: `${(col + 0.5) * 50}% ${(row + 0.5) * 50}%`,
        from: { x: ((col + 0.5) / 2 - 0.5) * w, y: ((row + 0.5) / 2 - 0.5) * h },
      }
    }
    const dive = (tile) => {
      setCam({ focus: tile, landed: false, ...aim(tile) })
      later(() => setCam((c) => (c.focus === tile ? { ...c, landed: true } : c)), SEG_ZOOM_IN_MS)
    }

    setCam((c) => {
      if (c.focus === target) return c
      if (target == null) return { ...c, focus: null, landed: true, origin: c.focus ? aim(c.focus).origin : c.origin }
      // Backward, a jump, or the reader scrubbing by hand: straight there —
      // the grid beat is for watching, not for navigating.
      const manual = subRef.current != null
      if (!forward || manual || c.focus == null) {
        later(() => dive(target), 0)
        return c
      }
      // Forward under the clock, from one tile to another: zoom back to the
      // grid, hold it so the hand-off can be read, then dive.
      later(() => dive(target), SEG_ZOOM_OUT_MS + SEG_GRID_DWELL_MS)
      return { ...c, focus: null, landed: true, origin: aim(c.focus).origin }
    })
    return () => timers.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, active])

  const focus = cam.focus
  const live = active && focus === target && cam.landed
  // The camera is still on its way to this step's view (zooming out, holding
  // the grid, or springing into the tile) and the replay has yet to run. A
  // reveal that is off parks at the END, which is right for a scrub or a
  // covered panel but wrong here: the tile would spring in showing its finished
  // state and then snap back to the start when the camera landed. So while
  // pending, each replay rests at its START instead. (Every reveal is only read
  // on its own step, so resting the others at 0 changes nothing.)
  const pending = active && sub == null && !live

  // ---- the replays that live outside the dictionary tiles ------------------
  const posted = useReveal(
    !fetch && step === at.postings && live && sub == null,
    walk?.units ?? 0,
    POSTING_STEP_MS,
    pending ? 0 : (walk?.units ?? 0),
  )
  const located = useReveal(
    fetch && step === at.locate && live && sub == null,
    wanted.length,
    FETCH_STEP_MS,
    pending ? 0 : wanted.length,
  )
  const fetched = useReveal(
    fetch && step === at.read && live && sub == null,
    wanted.length,
    FETCH_STEP_MS,
    pending ? 0 : wanted.length,
  )
  const postedShown = !fetch && step === at.postings ? (sub ?? posted) : step > (at.postings ?? Infinity) ? Infinity : 0
  const locatedShown = fetch ? (step === at.locate ? (sub ?? located) : step > at.locate ? Infinity : 0) : 0
  const fetchedShown = fetch ? (step === at.read ? (sub ?? fetched) : step > at.read ? Infinity : 0) : 0

  const status = tileStatus({ d, walk, postings, sf, wanted, fetch, step, at, postedShown, locatedShown, fetchedShown })

  const body = (tile) => {
    if (tile === 'fst') return <FstTile d={d} step={step} sub={sub} live={live} pending={pending} at={at} />
    if (tile === 'tim')
      return <BlocksTile d={d} step={step} sub={sub} live={live} pending={pending} at={at} postings={postings} />
    if (tile === 'doc')
      return (
        <PostingsTile postings={postings} walk={walk} shown={postedShown} patterns={patterns} docs={docs} live={live} />
      )
    return (
      <StoredFieldsTile
        sf={sf}
        wanted={wanted}
        fetch={fetch}
        located={locatedShown}
        fetched={fetchedShown}
        docs={docs}
        live={live}
      />
    )
  }

  return (
    <>
      <div className="si-scroll seg-stage" ref={box}>
        <motion.div
          className={'seg-grid' + (focus ? ' behind' : '')}
          style={{ transformOrigin: cam.origin }}
          initial={false}
          animate={focus ? { scale: 1.7, opacity: 0 } : { scale: 1, opacity: 1 }}
          transition={{ type: 'tween', ease: 'easeInOut', duration: SEG_ZOOM_OUT_MS / 1000 }}
        >
          {TILES.map((t) => (
            <Tile key={t.id} tile={t} status={status[t.id]} current={target === t.id} />
          ))}
        </motion.div>

        {focus && (
          <motion.div
            key={focus}
            className={'seg-tile-panel ' + focus}
            initial={{ opacity: 0, scale: 0.25, x: cam.from?.x ?? 0, y: cam.from?.y ?? 0 }}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
          >
            <TilePanelHead tile={TILES.find((t) => t.id === focus)} status={status[focus]} />
            {body(focus)}
          </motion.div>
        )}
      </div>
    </>
  )
}

// One tile at grid scale: glyph, name, file, where it lives, and the line that
// advances with the tour. `dim` is a tile this phase never reads.
function Tile({ tile, status, current }) {
  return (
    <div
      className={
        'seg-tile ' +
        tile.id +
        ' ' +
        tile.where +
        (status.dim ? ' dim' : '') +
        (status.done ? ' done' : '') +
        (current ? ' current' : '')
      }
      data-seg-tile={tile.id}
    >
      <div className="seg-tile-head">
        <span className="seg-tile-ext">{tile.ext}</span>
        <span className="seg-tile-name">{tile.name}</span>
        <span className={'seg-tile-where ' + tile.where}>{tile.where === 'ram' ? 'in memory' : 'on disk'}</span>
      </div>
      <Glyph id={tile.id} />
      <div className="seg-tile-what">{tile.what}</div>
      <div className={'seg-tile-status' + (status.hot ? ' hot' : '')}>{status.text}</div>
    </div>
  )
}

function TilePanelHead({ tile, status }) {
  return (
    <div className="seg-panel-head">
      <span className="seg-tile-ext">{tile.ext}</span>
      <span className="seg-tile-name">{tile.name}</span>
      <span className={'seg-tile-where ' + tile.where}>{tile.where === 'ram' ? 'in memory' : 'on disk'}</span>
      <span className="seg-panel-status">{status.text}</span>
    </div>
  )
}

// Small inline pictures of what each tile holds — a picture, not a screenshot,
// because at grid scale the real content is unreadable.
function Glyph({ id }) {
  if (id === 'fst')
    return (
      <svg className="seg-glyph" viewBox="0 0 120 56">
        <g className="g-arc">
          <line x1="18" y1="28" x2="50" y2="12" />
          <line x1="18" y1="28" x2="50" y2="44" />
          <line x1="58" y1="12" x2="92" y2="12" />
          <line x1="58" y1="44" x2="92" y2="28" />
          <line x1="58" y1="44" x2="92" y2="46" />
        </g>
        <g className="g-node">
          <circle cx="14" cy="28" r="6" />
          <circle cx="54" cy="12" r="6" />
          <circle cx="54" cy="44" r="6" />
          <circle cx="96" cy="12" r="6" className="out" />
          <circle cx="96" cy="28" r="6" className="out" />
          <circle cx="96" cy="46" r="6" className="out" />
        </g>
      </svg>
    )
  if (id === 'tim')
    return (
      <svg className="seg-glyph" viewBox="0 0 120 56">
        {[0, 1, 2, 3].map((i) => (
          <g key={i} className="g-block">
            <rect x="14" y={6 + i * 12} width="92" height="9" rx="2" />
            <rect x="18" y={8 + i * 12} width={14 + (i % 2) * 6} height="5" rx="1" className="prefix" />
            <rect x={38 + (i % 2) * 6} y={8 + i * 12} width="20" height="5" rx="1" />
            <rect x={62 + (i % 2) * 6} y={8 + i * 12} width="26" height="5" rx="1" />
          </g>
        ))}
      </svg>
    )
  if (id === 'doc')
    return (
      <svg className="seg-glyph" viewBox="0 0 120 56">
        {[0, 1, 2].map((i) => (
          <g key={i} className="g-post">
            <rect x="14" y={8 + i * 15} width="22" height="9" rx="2" className="term" />
            {[0, 1, 2, 3].slice(0, 4 - (i % 3)).map((j) => (
              <rect key={j} x={42 + j * 16} y={8 + i * 15} width="12" height="9" rx="4" />
            ))}
          </g>
        ))}
      </svg>
    )
  return (
    <svg className="seg-glyph" viewBox="0 0 120 56">
      {[0, 1, 2].map((i) => (
        <g key={i} className="g-row">
          <rect x="14" y={8 + i * 15} width="10" height="9" rx="2" className="ord" />
          <rect x="30" y={8 + i * 15} width="76" height="9" rx="2" />
          <rect x="34" y={11 + i * 15} width={30 + i * 10} height="3" rx="1" className="text" />
        </g>
      ))}
    </svg>
  )
}

// The status line on each tile, per step: what the tour has done to it so far,
// and what it hands to the next tile. Everything here is read off the models.
function tileStatus({ d, walk, postings, sf, wanted, fetch, step, at, postedShown, locatedShown, fetchedShown }) {
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`
  if (fetch) {
    const loc = Math.min(locatedShown, wanted.length)
    const rd = Math.min(fetchedShown, wanted.length)
    const ords = wanted.map((r) => r.ord)
    let text
    if (step >= at.done || rd >= wanted.length && step >= at.read)
      text = `${n(wanted.length, 'row', 'rows')} read · ${n(new Set(wanted.map((r) => r.chunk)).size, 'chunk', 'chunks')} decompressed`
    else if (step >= at.read) text = `reading row${rd ? ` ${wanted[rd - 1].ord}` : 's'}… ${rd} of ${wanted.length}`
    else if (step >= at.locate)
      text = loc ? `ordinal ${wanted[loc - 1].ord} → chunk ${fdtHex(sf.chunks[wanted[loc - 1].chunk].fp)}` : 'looking up .fdx…'
    else text = `asked for ordinal${ords.length === 1 ? '' : 's'} ${ords.join(', ')}`
    return {
      fst: { dim: true, text: 'read in the query phase' },
      tim: { dim: true, text: 'read in the query phase' },
      doc: { dim: true, text: 'read in the query phase' },
      fdt: { text, hot: step >= at.locate && step < at.done, done: step >= at.done },
    }
  }

  const { index, mode, trace, hits, matchedTerms } = d
  const walked = step > at.walk
  // The step that actually reads the block(s): `found` for a plain term (its
  // `read` step just concludes the in-memory walk), `read` otherwise.
  const readAt = at[d.blockReadStep]
  const carried = mode === 'term' && trace.block ? hexAddr(trace.block.fp) : null
  const fst = !walked && step < at.walk
    ? { text: `${index.fst.fstStates} states · not walked yet` }
    : step === at.walk
      ? { text: 'walking…', hot: true }
      : mode === 'term'
        ? { text: carried ? `walked · carrying ${carried}` : 'walked · nothing to read', done: true }
        : {
            text: `walked · ${n(hits.prunedArcs + hits.arcsSkipped, 'arc', 'arcs')} skipped unread`,
            done: true,
          }
  const blocksRead = mode === 'term' ? trace.blocksRead : hits.blocksLoaded
  const tim =
    step < readAt
      ? { text: `${n(index.blocks.length, 'block', 'blocks')} · none read${carried && walked ? ` · ${carried} next` : ''}` }
      : step === readAt
        ? { text: `reading ${mode === 'term' ? carried ?? '' : `${blocksRead} of ${index.blocks.length}`}…`, hot: true }
        : matchedTerms.length
          ? {
              text: `${blocksRead} of ${index.blocks.length} read · ${matchedTerms.length === 1 ? `“${matchedTerms[0]}”` : n(matchedTerms.length, 'term', 'terms')} → ${
                matchedTerms.length === 1 ? docHex(postings.byTerm.get(matchedTerms[0]).fp) : '.doc'
              }`,
              done: true,
            }
          : { text: `${blocksRead} of ${index.blocks.length} read · no match`, done: true }
  const shown = Math.min(postedShown, walk.units)
  const doc =
    step < at.postings
      ? { text: `${n(postings.total, 'posting', 'postings')} in ${n(postings.order.length, 'list', 'lists')} · not read` }
      : step === at.postings && shown < walk.units
        ? { text: `reading… ${shown} of ${walk.units}`, hot: true }
        : walk.units
          ? {
              text: `${n(walk.units, 'posting', 'postings')} read → ordinal${walk.units === 1 ? '' : 's'} ${[...new Set(walk.order.map((e) => e.ord))].join(', ')}`,
              done: true,
            }
          : { text: 'nothing to read — no term matched', done: true }
  return {
    fst,
    tim,
    doc,
    fdt: { dim: true, text: step >= at.done ? 'not yet — read in the fetch phase, for the winners' : 'not read in the query phase' },
  }
}

// ---------------------------------------------------------------------------
// The postings tile — .doc
// ---------------------------------------------------------------------------

// Every term's list, in file order, with the ones the query resolved to lit and
// replayed one posting at a time. Unread lists are dimmed, not hidden: they are
// the cost the walk avoided. A posting is drawn as its ORDINAL first, because
// that is what the file holds; the doc chip beside it is the reader's bridge to
// the level above, where the same doc was a coloured id.
function PostingsTile({ postings, walk, shown, patterns, docs, live }) {
  const start = new Map()
  for (const e of walk.order) if (!start.has(e.term)) start.set(e.term, e.i)
  const revealed = walk.order.slice(0, shown)
  const ords = [...new Set(revealed.map((e) => e.ord))].sort((a, b) => a - b)
  const walkedSet = new Set(walk.terms)
  const anyWalked = walk.terms.length > 0
  const ref = useRef(null)

  // Keep the list being read in view; the strip is long and the walked lists
  // sit wherever the dictionary order puts them. Before the first posting is
  // revealed, bring the first list to be read into view instead.
  // Gated on `live` (and re-run when it flips): before the camera has landed
  // the panel is still scaling in, and a measurement then scrolls by the wrong
  // amount — which is exactly what a scrub-back into this tile used to do.
  useEffect(() => {
    if (!live) return
    const term = revealed[revealed.length - 1]?.term ?? walk.terms[0]
    if (!term) return
    return scrollTileTo(ref.current, `[data-post-term="${CSS.escape(term)}"]`, { centre: true })
  }, [shown, live])

  return (
    <>
      <section className="cu-side disk seg-doc" ref={ref}>
        <header className="cu-side-head">
          <span className="cu-side-title">on disk · .doc</span>
          <span className="cu-side-sub">
            {postings.order.length} lists · {postings.total} postings
            {anyWalked && <> · {Math.min(shown, walk.units)} read</>}
          </span>
        </header>
        <div className="seg-post-rows">
          {postings.order.map((term) => {
            const row = postings.byTerm.get(term)
            const isWalked = walkedSet.has(term)
            const first = start.get(term) ?? Infinity
            const opened = isWalked && shown > first
            const isQuery = !isWalked && matchesAny(term, patterns ?? [])
            return (
              <div
                key={term}
                data-post-term={term}
                className={
                  'seg-post-row' +
                  (isWalked ? ' walked' : anyWalked ? ' unread' : '') +
                  (opened ? ' open' : '') +
                  (isQuery ? ' query' : '')
                }
              >
                <span className="seg-post-term">{term}</span>
                <span className="seg-post-fp">{docHex(row.fp)}</span>
                {/* The list's length, NOT a stored field: .doc holds (ordinal,
                    freq) pairs and nothing else. docFreq itself is a per-term
                    statistic in the .tim row (see the term-blocks tile), which
                    is exactly why a scorer can read it without walking this
                    list. */}
                <span
                  className="seg-post-df"
                  title="one entry per document that contains the term — this count equals the docFreq stored in the .tim term row"
                >
                  {row.docFreq} {row.docFreq === 1 ? 'doc' : 'docs'}
                </span>
                <span className="seg-post-entries">
                  {row.entries.map((e, k) => {
                    const idx = first + k
                    const on = opened && shown > idx
                    const pending = isWalked && !on
                    return (
                      <span key={e.ord} className={'seg-post-entry' + (on ? ' read' : '') + (pending ? ' pending' : '')}>
                        <b className="seg-ord">{e.ord}</b>
                        <i className="seg-freq">×{e.freq}</i>
                        <DocChip id={e.id} docs={docs} />
                      </span>
                    )
                  })}
                </span>
                {isQuery && <span className="seg-post-note">also a query term — same walk, not replayed</span>}
              </div>
            )
          })}
        </div>
      </section>

      <div className={'cu-isect ' + (anyWalked ? 'exact' : 'dead')}>
        <div className="cu-isect-cell">
          <span className="cu-isect-k">lists read</span>
          <b className="cu-isect-prefix">{walk.terms.length ? walk.terms.map((t) => `“${t}”`).join(', ') : 'none'}</b>
        </div>
        <div className="cu-isect-cell grow">
          <span className="cu-isect-k">candidates so far · segment-local ordinals</span>
          <span className="cu-isect-states">
            {ords.length ? (
              ords.map((o) => (
                <i key={o} className="cu-isect-state accept">
                  {o}
                </i>
              ))
            ) : (
              <i className="cu-isect-state none">—</i>
            )}
          </span>
        </div>
        <div className={'cu-isect-verdict ' + (anyWalked ? 'exact' : 'dead')}>
          {anyWalked ? `${Math.min(shown, walk.units)} of ${walk.units} postings` : 'no posting list to read'}
          <i>{anyWalked ? 'numbers and frequencies — the text was never read' : 'the term is not in this segment'}</i>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// The stored-fields tile — .fdx + .fdt
// ---------------------------------------------------------------------------

// The `.fdx` index across the top (one cell per chunk), then the chunks, each a
// box of rows addressed by ordinal. In the query phase the whole thing is
// dimmed under a banner: nothing here is read to answer a query. In the fetch
// phase the wanted ordinals light their index cell, then their chunk, then
// their row's _source, one winner at a time.
function StoredFieldsTile({ sf, wanted, fetch, located, fetched, docs, live }) {
  const locSet = new Set(wanted.slice(0, located).map((r) => r.chunk))
  const readSet = new Set(wanted.slice(0, fetched).map((r) => r.ord))
  const wantedOrds = new Set(wanted.map((r) => r.ord))
  const ref = useRef(null)

  // Follow the row being fetched; before the first, the first wanted row.
  useEffect(() => {
    if (!live) return
    const row = wanted[Math.max(0, Math.min(fetched, wanted.length) - 1)]
    if (!row) return
    return scrollTileTo(ref.current, `[data-fdt-ord="${row.ord}"]`, { centre: true })
  }, [fetched, located, live])

  return (
    <section className={'cu-side disk seg-fdt' + (fetch ? '' : ' idle')} ref={ref}>
      <header className="cu-side-head">
        <span className="cu-side-title">on disk · .fdx + .fdt</span>
        <span className="cu-side-sub">
          {sf.maxDoc} Lucene doc{sf.maxDoc === 1 ? '' : 's'} in {sf.chunks.length} compressed chunk
          {sf.chunks.length === 1 ? '' : 's'}
          {fetch && <> · {Math.min(fetched, wanted.length)} of {wanted.length} read</>}
        </span>
      </header>

      {!fetch && (
        <div className="seg-fdt-banner">
          Not read in the query phase. A shard answers a query with ordinals and scores; the rows below are opened
          later, in the fetch phase, and only for the winners.
        </div>
      )}

      <div className="seg-fdx">
        <span className="seg-fdx-label">.fdx · ordinal → chunk</span>
        {sf.chunks.map((c) => (
          <span
            key={c.index}
            className={'seg-fdx-cell' + (locSet.has(c.index) ? ' hit' : '') + (fetch && wanted.some((r) => r.chunk === c.index) ? ' wanted' : '')}
          >
            <b>
              {c.first === c.last ? c.first : `${c.first}–${c.last}`}
            </b>
            <i>→ {fdtHex(c.fp)}</i>
          </span>
        ))}
      </div>

      <div className="seg-fdt-chunks">
        {sf.chunks.map((c) => (
          <div
            key={c.index}
            className={'seg-fdt-chunk' + (locSet.has(c.index) ? ' located' : '') + (c.ords.some((o) => readSet.has(o)) ? ' open' : '')}
          >
            <div className="seg-fdt-chunk-head">
              <span className="cu-block-fp">{fdtHex(c.fp)}</span>
              <span className="seg-fdt-chunk-note">
                {locSet.has(c.index)
                  ? c.ords.some((o) => readSet.has(o))
                    ? 'decompressed — every row in it came off the disk'
                    : 'located — about to be decompressed'
                  : `chunk ${c.index} · ${c.ords.length} row${c.ords.length === 1 ? '' : 's'}`}
              </span>
            </div>
            {c.ords.map((o) => {
              const r = sf.rows[o]
              const isRead = readSet.has(o)
              const isWanted = wantedOrds.has(o)
              return (
                <div
                  key={o}
                  data-fdt-ord={o}
                  className={'seg-fdt-row' + (isRead ? ' read' : '') + (isWanted ? ' wanted' : '') + (r.isRoot ? '' : ' child')}
                >
                  <b className="seg-ord">{o}</b>
                  <span className="seg-fdt-id">
                    <span className="seg-fdt-k">_id</span>
                    {r.isRoot ? <DocChip id={r.id} docs={docs} /> : <em className="seg-fdt-none">not stored</em>}
                  </span>
                  <span className="seg-fdt-source">
                    <span className="seg-fdt-k">_source</span>
                    {r.isRoot ? (
                      isRead || !fetch ? (
                        <span className="seg-fdt-json">
                          {sourceEntries({ source: r.source }).map(([k, v]) => (
                            <SourceField key={k} name={k} value={v} />
                          ))}
                        </span>
                      ) : (
                        <em className="seg-fdt-none">{isWanted ? 'compressed — not read yet' : 'compressed'}</em>
                      )
                    ) : (
                      <em className="seg-fdt-none">none — a nested child; the document’s _source is on its root</em>
                    )}
                  </span>
                  {isRead && <span className="cu-suffix-flag">← returned</span>}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </section>
  )
}

function DocChip({ id, docs }) {
  const d = docs[id]
  return (
    <span
      className={'doc-chip' + (d?.deleted ? ' deleted' : '') + (d?.purged ? ' purged' : '')}
      style={{ background: d?.color || '#888' }}
    >
      {id}
    </span>
  )
}
