// What a segment's term dictionary REALLY is on disk, and how a term is found in
// it. This is the model behind the `dictionary` close-up.
//
// One level up (ShardInspector's anatomy card, src/wildcard.js) the dictionary is
// drawn as a flat sorted table and a lookup is a binary search over it. That
// teaches the cost story but not the structure. Lucene actually stores the
// dictionary as TWO files:
//
//   .tip — the term INDEX: an FST (finite state transducer) held in memory,
//          mapping a term PREFIX to the file pointer of the on-disk block that
//          holds every term starting with that prefix. It is a *minimized*
//          automaton, so shared tails collapse onto shared states — that is why
//          it is a DAG rather than a trie, and why it is small enough to stay
//          resident. It also answers "no such term" with ZERO disk reads.
//
//   .tim — the term DICTIONARY: blocks of 25–48 entries, where an entry is
//          either a term or a pointer to a SUB-BLOCK. Terms inside a block are
//          stored as SUFFIXES after the block's shared prefix (prefix
//          compression). A block that would exceed the maximum is split into
//          FLOOR BLOCKS, and the FST output for that prefix then records the
//          leading byte and file pointer of each floor block.
//
// Flagged simplification (see SPEC.md): the block sizes here are toy-scaled —
// 2–4 entries instead of Lucene's 25–48 — so the tree, its sub-blocks and its
// floor splits all fit on one screen. The ALGORITHM is the real one; only the
// constants shrink. Every panel that renders these carries a badge saying so.

export const BLOCK_MIN = 2
export const BLOCK_MAX = 4
export const LUCENE_BLOCK_MIN = 25
export const LUCENE_BLOCK_MAX = 48

// Fake-but-stable file offsets, so the views can show ".tim @0x1a0" and have the
// same block always carry the same address. Blocks are laid out in emit order.
const BLOCK_STRIDE = 0x40
const fpOf = (i) => 0x100 + i * BLOCK_STRIDE
export const hexFp = (fp) => '0x' + fp.toString(16).toUpperCase().padStart(3, '0')

// ---------------------------------------------------------------------------
// .tim — cutting the sorted terms into blocks
// ---------------------------------------------------------------------------

// rows: [{ term, docIds }] sorted by term — exactly what segmentInvertedIndex
// returns. Returns { blocks, byFp, rootFp, fst, terms }.
export function buildTermIndex(rows) {
  const blocks = []

  // Emit one block and hand back the block. `entries` are already built.
  const emit = (prefix, isLeaf, entries, floor) => {
    const fp = fpOf(blocks.length)
    const block = {
      fp,
      prefix,
      isLeaf,
      entries,
      floor: floor || null,
      floors: null, // set below when this prefix had to be floor-split
      // What the block costs to store: the shared prefix once, plus each suffix.
      bytes: prefix.length + entries.reduce((n, e) => n + e.suffix.length + 1, 0),
      // What it WOULD cost if every term were written out in full.
      bytesUncompressed: entries.reduce(
        (n, e) => n + (e.kind === 'term' ? e.term.length : e.suffix.length) + 1,
        0,
      ),
    }
    blocks.push(block)
    return block
  }

  const termEntry = (row, prefixLen) => ({
    kind: 'term',
    term: row.term,
    suffix: row.term.slice(prefixLen),
    docFreq: row.docIds.length,
    // Lucene stores total term frequency too; we only model per-doc presence, so
    // this is honest only as "at least docFreq". Kept out of the UI.
    docIds: row.docIds,
  })

  // Build the block covering `group` (all sharing group[0].term[0..prefixLen)).
  // Returns the file pointer of the block a seek should land on for that prefix.
  function build(group, prefixLen) {
    const prefix = group[0].term.slice(0, prefixLen)

    // Small enough to be one on-disk read: a LEAF block of plain term entries.
    if (group.length <= BLOCK_MAX)
      return emit(prefix, true, group.map((r) => termEntry(r, prefixLen))).fp

    // Too many terms. Split by the next byte: a byte-group big enough to be
    // worth its own read becomes a SUB-BLOCK; anything smaller is inlined here
    // as ordinary term entries (Lucene's minItemsInBlock rule).
    const exact = group.find((r) => r.term.length === prefixLen) || null
    const byByte = []
    for (const row of group) {
      if (row === exact) continue
      const byte = row.term[prefixLen]
      const last = byByte[byByte.length - 1]
      if (last && last.byte === byte) last.rows.push(row)
      else byByte.push({ byte, rows: [row] })
    }

    const entries = []
    if (exact) entries.push(termEntry(exact, prefixLen))
    for (const g of byByte) {
      if (g.rows.length >= BLOCK_MIN) {
        const subFp = build(g.rows, prefixLen + 1)
        entries.push({
          kind: 'sub',
          suffix: g.byte,
          subFp,
          count: g.rows.length,
          // the prefix every term behind this pointer shares
          subPrefix: prefix + g.byte,
        })
      } else {
        for (const row of g.rows) entries.push(termEntry(row, prefixLen))
      }
    }

    // Still too wide for one read: FLOOR BLOCKS. One prefix now spans several
    // blocks, so the prefix's FST output has to name the leading byte + file
    // pointer of EACH of them; the seek picks the floor whose byte range covers
    // the term instead of just following a single pointer.
    if (entries.length > BLOCK_MAX) {
      const emitted = []
      for (let i = 0; i < entries.length; i += BLOCK_MAX) {
        const chunk = entries.slice(i, i + BLOCK_MAX)
        emitted.push(
          emit(prefix, false, chunk, {
            leadByte: chunk[0].suffix[0] ?? '',
            index: emitted.length,
          }),
        )
      }
      // Every floor block carries the whole roster, because that roster IS the
      // FST's output for this prefix and the seek needs it to choose.
      const roster = emitted.map((b) => ({ leadByte: b.floor.leadByte, fp: b.fp }))
      for (const b of emitted) b.floors = roster
      return emitted[0].fp
    }

    return emit(prefix, false, entries).fp
  }

  const rootFp = rows.length ? build(rows, 0) : null
  const byFp = Object.fromEntries(blocks.map((b) => [b.fp, b]))
  return {
    blocks,
    byFp,
    rootFp,
    terms: rows.map((r) => r.term),
    // Lucene keeps the field's min and max term alongside the dictionary, so a
    // term outside that range is rejected with no disk access at all.
    minTerm: rows.length ? rows[0].term : null,
    maxTerm: rows.length ? rows[rows.length - 1].term : null,
    fst: buildFst(blocks, rows),
  }
}

// ---------------------------------------------------------------------------
// Views onto a built index, for the close-up
// ---------------------------------------------------------------------------

// The span of terms a block is responsible for, as plain text — far easier to
// read than a bare file offset. Includes everything reachable through its
// sub-blocks, which is what "this block covers…" has to mean for an inner block.
export function blockRange(index, block) {
  const terms = []
  const walk = (b) => {
    for (const e of b.entries) {
      if (e.kind === 'term') terms.push(e.term)
      else walk(index.byFp[e.subFp])
    }
  }
  walk(block)
  terms.sort()
  return terms.length ? { first: terms[0], last: terms[terms.length - 1], count: terms.length } : null
}

// ---------------------------------------------------------------------------
// .tip — the FST over block prefixes
// ---------------------------------------------------------------------------

// A trie over every block's prefix, carrying that block's file pointer as the
// output of the state the prefix ends on, then MINIMIZED so states with
// identical continuations are shared.
//
// Two honest notes:
//  - Real Lucene FSTs hang outputs on ARCS and accumulate them along a path. We
//    hang the whole file pointer on the STATE, which reads the same in a diagram
//    and keeps the walk easy to follow. The zero-length prefix (the root block)
//    only works this way, since no arc completes it.
//  - Minimization is real but rarely finds anything at this scale: each block has
//    a distinct file pointer, so the states that would merge don't. It is what
//    keeps a real .tip resident in memory; `trieStates`/`fstStates` report what
//    it actually saved here so the UI can tell the truth either way.
function buildFst(blocks, rows) {
  let next = 1
  const states = [{ id: 0, arcs: [], out: null, terms: 0 }]
  const mkState = () => {
    states.push({ id: next, arcs: [], out: null, terms: 0 })
    return states[next++]
  }

  // 1. raw trie over block prefixes
  for (const b of blocks) {
    let s = states[0]
    for (const ch of b.prefix) {
      let arc = s.arcs.find((a) => a.label === ch)
      if (!arc) {
        arc = { label: ch, to: mkState().id }
        s.arcs.push(arc)
      }
      s = states[arc.to]
    }
    // The state this prefix ends on carries the block pointer. A floor-split
    // prefix records its FIRST floor block; the roster of the rest travels on the
    // block itself (see `floors`), which is what the seek consults to choose.
    if (s.out == null) s.out = b.fp
  }

  // How many dictionary terms live under each state — what a pruned subtree
  // costs you nothing to skip, which the automaton close-up counts.
  for (const term of rows.map((r) => r.term)) {
    let s = states[0]
    s.terms += 1
    for (const ch of term) {
      const arc = s.arcs.find((a) => a.label === ch)
      if (!arc) break
      s = states[arc.to]
      s.terms += 1
    }
  }

  return minimize(states)
}

// Merge structurally identical states, deepest-first: two states are the same if
// they carry the same output and the same set of (label → target) arcs. This is
// the suffix sharing that turns the trie into a DAG.
function minimize(states) {
  const order = []
  const seen = new Set()
  ;(function post(id) {
    if (seen.has(id)) return
    seen.add(id)
    for (const a of states[id].arcs) post(a.to)
    order.push(id)
  })(0)

  const canon = new Map() // signature -> canonical state id
  const remap = new Map() // original id -> canonical id
  const resolve = (id) => remap.get(id) ?? id

  for (const id of order) {
    const s = states[id]
    for (const a of s.arcs) a.to = resolve(a.to)
    const sig = JSON.stringify([s.out, s.arcs.map((a) => [a.label, a.to]).sort()])
    if (canon.has(sig)) remap.set(id, canon.get(sig))
    else canon.set(sig, id)
  }

  // Keep only the surviving states, renumbered so the view can index them.
  const kept = [...new Set(order.map(resolve))]
  const id2ix = new Map(kept.map((id, i) => [id, i]))
  const out = kept.map((id) => {
    const s = states[id]
    return {
      id: id2ix.get(id),
      out: s.out,
      terms: s.terms,
      arcs: s.arcs.map((a) => ({ label: a.label, to: id2ix.get(resolve(a.to)) })),
    }
  })
  return {
    states: out,
    root: id2ix.get(resolve(0)),
    // How much the minimization actually saved — the "it's a DAG" evidence.
    trieStates: states.length,
    fstStates: out.length,
  }
}

// ---------------------------------------------------------------------------
// Seeking
// ---------------------------------------------------------------------------

// Walk the .tip FST one byte at a time, remembering the deepest block pointer
// seen. Running out of arcs with no pointer at all means the term CANNOT be in
// this segment — answered entirely in memory, no disk read.
export function fstSeek(index, term) {
  const { states, root } = index.fst
  const arcs = []
  let state = root
  // The root block (zero-length prefix) is the fallback for any term whose first
  // byte no arc covers — those terms are inlined in the root block itself.
  let blockFp = states[root].out
  let missAt = null

  for (let i = 0; i < term.length; i++) {
    const label = term[i]
    const arc = states[state].arcs.find((a) => a.label === label)
    if (!arc) {
      arcs.push({ label, from: state, to: null, missing: true })
      missAt = i
      break
    }
    // `from` is the state this arc LEAVES, which is what the diagram keys walked
    // arcs by — so it has to be read before `state` advances.
    const from = state
    state = arc.to
    const out = states[state].out
    if (out != null) blockFp = out
    arcs.push({ label, from, to: arc.to, out: out ?? null })
  }

  return { arcs, blockFp, missAt, endState: state }
}

// Which floor block of a floor-split prefix holds `want`: the last one whose
// leading byte is still <= the suffix we're looking for. This roster IS the FST's
// output for a prefix that outgrew a single block.
export function pickFloor(floors, want) {
  const lead = want[0] ?? ''
  let chosen = floors[0]
  for (const f of floors) if (f.leadByte <= lead) chosen = f
  return chosen
}

// Scan ONE block for a term. Entries are suffixes after the block's shared
// prefix and are kept in sorted order, so the scan can stop as soon as it passes
// where the suffix would sit. The block holds only a couple dozen entries in
// real Lucene, and the FST has already proved the term can only be here.
export function blockScan(block, term) {
  const want = term.slice(block.prefix.length)
  const rows = []
  let hit = null
  for (let i = 0; i < block.entries.length; i++) {
    const e = block.entries[i]
    const cmp = e.suffix < want ? -1 : e.suffix > want ? 1 : 0
    const isHit = cmp === 0 && e.kind === 'term'
    rows.push({ i, entry: e, cmp, hit: isHit, stop: cmp > 0 })
    if (isHit) {
      hit = e
      break
    }
    if (cmp > 0) break
  }
  return { rows, hit, want }
}

// The whole replayable trace: FST walk (in memory) → one block read → in-block
// scan. `blocksRead` is the honest cost, and it is 1 or 0.
export function seekTrace(index, term) {
  // Cheapest rejection there is: the field's min/max term bracket this segment's
  // whole dictionary, so anything outside it is answered without touching disk.
  if (index.minTerm == null || term < index.minTerm || term > index.maxTerm)
    return {
      term,
      outOfRange: true,
      fst: { arcs: [], blockFp: null, missAt: null, endState: index.fst.root },
      floorPick: null,
      block: null,
      inBlock: null,
      found: false,
      meta: null,
      blocksRead: 0,
      entriesRead: 0,
      flatProbes: index.terms.length ? Math.ceil(Math.log2(index.terms.length)) : 0,
    }

  const fst = fstSeek(index, term)
  let block = fst.blockFp != null ? index.byFp[fst.blockFp] : null

  // A floor-split prefix means the FST handed back a roster, not one pointer:
  // choose the floor block whose byte range covers this term.
  let floorPick = null
  if (block?.floors) {
    floorPick = pickFloor(block.floors, term.slice(block.prefix.length))
    block = index.byFp[floorPick.fp]
  }

  let inBlock = block ? blockScan(block, term) : null

  // A miss inside an inner block can still be behind a sub-block pointer when
  // the FST's deepest output was an ancestor. Follow it — that is a second read.
  let extraReads = 0
  while (inBlock && !inBlock.hit) {
    const last = inBlock.rows[inBlock.rows.length - 1]
    const sub = last?.entry.kind === 'sub' && last.cmp === 0 ? last.entry : null
    if (!sub) break
    block = index.byFp[sub.subFp]
    inBlock = blockScan(block, term)
    extraReads += 1
  }

  return {
    term,
    outOfRange: false,
    fst,
    floorPick,
    block,
    inBlock,
    found: !!inBlock?.hit,
    meta: inBlock?.hit || null,
    blocksRead: block ? 1 + extraReads : 0,
    entriesRead: inBlock ? inBlock.rows.length : 0,
    // The contrast the level above draws: a flat binary search over every term.
    flatProbes: index.terms.length ? Math.ceil(Math.log2(index.terms.length)) : 0,
  }
}
