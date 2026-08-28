// How a pattern is REALLY resolved: it is compiled to a finite automaton, which
// is then run against the term index's arcs so whole subtrees of the dictionary
// are never read. This is the model behind the `dictionary` close-up.
//
// A wildcard and a fuzzy differ ONLY in which NFA gets built. Everything after
// that — determinization, the arc walk, pruning, floor selection — is shared,
// because to Lucene both are just an AutomatonQuery. That is why a fuzzy query
// gets the same picture rather than a new one.
//
// One level up, src/wildcard.js resolves a pattern by testing every term (or, for
// a literal prefix, binary-searching to the range first). That gets the cost
// story right but makes the pruning look like a special case. Lucene's
// WildcardQuery and FuzzyQuery are both AutomatonQuery: the pattern becomes a
// DFA, and `TermsEnum.intersect` walks the .tip FST and the DFA in lockstep. An
// FST arc the DFA has no transition for is a dead end, so every term behind it
// is skipped without a single byte being read.
//
// That is what makes the cost lesson STRUCTURAL rather than asserted:
//   `sc*`     the DFA's start state only accepts 's', so every other arc out of
//             the root dies immediately — most of the dictionary is never visited.
//   `*search` the DFA's start state has an any-character SELF LOOP, so every arc
//             is live. Nothing can ever be pruned, and every block gets read.
//   `serch~1` at prefix_length 0 the start state may already spend its edit on
//             any character, so it too survives everything and prunes nothing.
//             Raise prefix_length and edits are forbidden at the front: the
//             start state narrows to one letter and the pruning comes back. The
//             fuzzy cost story IS the leading-wildcard cost story.
//
// Flagged simplification (see SPEC.md): Lucene determinizes up front with a cap
// (`maxDeterminizedStates`, 10000) and also compiles special cases (a pure prefix
// becomes a seek). We do the same subset construction over a tiny alphabet and
// skip the special-casing, so the general machinery stays visible.

import { matchTerm } from './wildcard'

// The "any character" label, in NFA/DFA transitions. It leads with a NUL so it
// can never collide with a real term character. Spelled as an escape rather
// than typed: the committed version carried a literal NUL, which made the
// sentinel invisible in the source and made git treat this file as binary.
export const ANY = '\u0000ANY'

export const LUCENE_MAX_DETERMINIZED_STATES = 10000

// ---------------------------------------------------------------------------
// Pattern -> NFA -> DFA
// ---------------------------------------------------------------------------

// The glob as a nondeterministic automaton, with no epsilon transitions:
//   a literal char c  — consume c, advance
//   ?                 — consume anything, advance
//   *                 — consume anything, STAY (a self loop), and also allow
//                       advancing without consuming, which is the nondeterminism
//                       that forces determinization below.
function buildGlobNfa(literal) {
  // A '*' folds into the state it sits on (as a self loop) rather than consuming
  // a state of its own, so state numbers track the literal characters only.
  const states = [{ id: 0, trans: [], star: false }]
  let cur = 0
  for (const ch of literal) {
    if (ch === '*') {
      states[cur].star = true
      continue
    }
    states.push({ id: states.length, trans: [], star: false })
    states[cur].trans.push({ label: ch === '?' ? ANY : ch, to: states.length - 1 })
    cur = states.length - 1
  }
  // No epsilon edges and no grid to draw: a glob goes straight to determinization.
  return { states, start: [0], accept: new Set([cur]), grid: null }
}

// The Levenshtein automaton for `term`: it accepts exactly the strings within
// `maxEdits` edits of it. A state is (i, e) — "matched term[0..i), having spent
// e edits" — and the edit operations ARE its transitions:
//
//   match          input term[i]  → (i+1, e)     the character was right
//   substitution   input anything → (i+1, e+1)   the character was wrong
//   insertion      input anything → (i,   e+1)   an extra character
//   deletion       ε              → (i+1, e+1)   a missing character
//   transposition  term[i+1] then term[i] → (i+2, e+1)   (Damerau, one edit)
//
// A state accepts when the term's remaining characters could all be deleted
// within the remaining budget: n - i <= maxEdits - e.
//
// `prefixLength` forbids every edit at positions below it. That single guard is
// what narrows the start state, and therefore the entire reason a fuzzy query
// can prune the dictionary at all.
function buildLevenshteinNfa(term, maxEdits, { transpositions = true, prefixLength = 0 } = {}) {
  const n = term.length
  const id = (i, e) => e * (n + 1) + i
  const states = []
  const mk = (sid) => {
    while (states.length <= sid) states.push({ id: states.length, trans: [], eps: [], star: false })
    return states[sid]
  }
  mk(id(n, maxEdits)) // allocate the whole (n+1) x (maxEdits+1) grid up front

  // The DRAWING model, built from the PRE-elimination graph so the picture shows
  // all five kinds of edit rather than the epsilon-folded result. The view reads
  // (i, e) out of here and never reverse-engineers it from a state id.
  const nodes = []
  const edges = []
  const accept = new Set()

  for (let e = 0; e <= maxEdits; e++)
    for (let i = 0; i <= n; i++) {
      const s = mk(id(i, e))
      const accepting = n - i <= maxEdits - e
      if (accepting) accept.add(s.id)
      nodes.push({ id: s.id, i, e, accept: accepting, bridge: false })

      if (i < n) {
        s.trans.push({ label: term[i], to: id(i + 1, e) })
        edges.push({ from: s.id, to: id(i + 1, e), label: term[i], kind: 'match' })
      }

      // Edits are only allowed past the pinned prefix.
      if (e >= maxEdits || i < prefixLength) continue

      s.trans.push({ label: ANY, to: id(i, e + 1) })
      edges.push({ from: s.id, to: id(i, e + 1), label: ANY, kind: 'insert' })

      if (i < n) {
        s.trans.push({ label: ANY, to: id(i + 1, e + 1) })
        edges.push({ from: s.id, to: id(i + 1, e + 1), label: ANY, kind: 'substitute' })
        s.eps.push(id(i + 1, e + 1))
        edges.push({ from: s.id, to: id(i + 1, e + 1), label: null, kind: 'delete' })
      }

      // Damerau: two characters arriving in the wrong order cost ONE edit, not
      // two. That needs a state of its own to remember it saw the second one
      // first, so these sit off the grid, between the layers they bridge.
      if (transpositions && i + 1 < n && term[i] !== term[i + 1]) {
        const bridge = mk(states.length)
        s.trans.push({ label: term[i + 1], to: bridge.id })
        bridge.trans.push({ label: term[i], to: id(i + 2, e + 1) })
        nodes.push({ id: bridge.id, i: i + 1, e: e + 0.5, accept: false, bridge: true })
        edges.push({ from: s.id, to: bridge.id, label: term[i + 1], kind: 'transpose' })
        edges.push({ from: bridge.id, to: id(i + 2, e + 1), label: term[i], kind: 'transpose' })
      }
    }

  const grid = { term, n, maxEdits, prefixLength, transpositions, nodes, edges }
  return { ...eliminateEpsilons({ states, start: [id(0, 0)], accept }), grid }
}

// nfaStep below has no notion of epsilon, deliberately — the glob NFA never
// needed one. Rather than complicate it for fuzzy's deletion edges, fold them
// away here: a transition now lands on its target's whole epsilon closure, and
// the start set and accepting set are closed the same way.
//
// State IDS ARE PRESERVED, which is what lets the drawing model above and the
// DFA's nfaSet below address the same states.
function eliminateEpsilons(nfa) {
  const closure = (start) => {
    const seen = new Set(start)
    const stack = [...start]
    while (stack.length) {
      const s = nfa.states[stack.pop()]
      for (const t of s.eps ?? []) if (!seen.has(t)) { seen.add(t); stack.push(t) }
    }
    return seen
  }
  const closures = nfa.states.map((s) => closure([s.id]))
  const states = nfa.states.map((s) => {
    const trans = []
    const seen = new Set()
    for (const src of closures[s.id])
      for (const t of nfa.states[src].trans)
        for (const dst of closures[t.to]) {
          // Join on a NUL — no real character can be mistaken for the
          // separator. Spelled as an escape rather than typed, which would
          // make it invisible in the source.
          const k = `${t.label}\u0000${dst}`
          if (seen.has(k)) continue
          seen.add(k)
          trans.push({ label: t.label, to: dst })
        }
    return { id: s.id, trans, star: s.star ?? false }
  })
  const accept = new Set()
  for (const s of nfa.states)
    for (const c of closures[s.id]) if (nfa.accept.has(c)) { accept.add(s.id); break }
  return { states, start: [...closure(nfa.start)], accept }
}

// Where an NFA state set goes on `label`. A starred state keeps itself alive.
function nfaStep(nfa, set, label) {
  const out = new Set()
  for (const id of set) {
    const st = nfa.states[id]
    if (st.star) out.add(id) // the '*' self loop: anything, stay put
    for (const t of st.trans)
      if (t.label === label || t.label === ANY) out.add(t.to)
  }
  return out
}

// Subset construction: each DFA state is a SET of NFA states. `alphabet` is the
// set of concrete characters we care about (the labels actually present in the
// term index); everything else is handled by the ANY fallback, which is what lets
// one small table cover the whole byte range.
export function compileAutomaton(pattern, alphabet = []) {
  // The only thing a pattern's kind decides. Everything below is shared.
  const nfa =
    pattern.kind === 'fuzzy'
      ? buildLevenshteinNfa(pattern.literal, pattern.maxEdits, {
          transpositions: pattern.transpositions,
          prefixLength: pattern.prefixLength,
        })
      : buildGlobNfa(pattern.literal)
  const labels = [...new Set(alphabet)].sort()

  const key = (set) => [...set].sort((a, b) => a - b).join(',')
  const start = new Set(nfa.start)
  const states = []
  const byKey = new Map()
  let capped = false

  const intern = (set) => {
    const k = key(set)
    if (byKey.has(k)) return byKey.get(k)
    const st = {
      id: states.length,
      nfaSet: [...set].sort((a, b) => a - b),
      accept: [...set].some((id) => nfa.accept.has(id)),
      trans: {}, // label -> dfa state id
      other: null, // where an unlisted character goes (the ANY fallback)
      dead: set.size === 0,
    }
    states.push(st)
    byKey.set(k, st.id)
    return st.id
  }

  const startId = intern(start)
  const queue = [startId]
  while (queue.length) {
    // Lucene refuses to determinize past maxDeterminizedStates rather than let a
    // pathological pattern eat the heap. Nothing at this scale comes close, but
    // the limit is real and fuzzy is where it would bite, so honour it.
    if (states.length > LUCENE_MAX_DETERMINIZED_STATES) {
      capped = true
      break
    }
    const st = states[queue.shift()]
    if (st.dead) continue
    const set = new Set(st.nfaSet)
    for (const label of labels) {
      const next = nfaStep(nfa, set, label)
      const before = states.length
      const id = intern(next)
      st.trans[label] = id
      if (states.length > before) queue.push(id)
    }
    const other = nfaStep(nfa, set, ANY)
    const before = states.length
    st.other = intern(other)
    if (states.length > before) queue.push(st.other)
  }

  return {
    pattern,
    states,
    start: startId,
    alphabet: labels,
    capped,
    // The (i, e) drawing model, for a fuzzy — null for a glob, which has no grid
    // to draw.
    grid: nfa.grid,
    // A start state that survives any character is exactly what a leading
    // wildcard produces — and what a fuzzy with prefix_length 0 produces, since
    // its first move can always be an edit. Either way: nothing can be pruned.
    startAcceptsAnything: !states[startId].dead && !states[states[startId].other].dead,
  }
}

// Follow one character. Returns null when the DFA dies — that is a PRUNE.
export function dfaStep(dfa, stateId, label) {
  const st = dfa.states[stateId]
  if (!st || st.dead) return null
  const next = label in st.trans ? st.trans[label] : st.other
  return next != null && !dfa.states[next].dead ? next : null
}

// WHY one decision of the walk went the way it did, as structured facts a view
// can put into words. Everything here is read off the compiled machine and the
// visit — nothing is inferred from the query string or written into copy.
//
// The load-bearing fact, and the reason a fuzzy query can prune at all: a
// reading that still has budget can ALWAYS buy the next character (an insertion
// costs one edit and consumes anything), so an arc can only die once every live
// reading has spent its last edit. `allSpent` is therefore true for every prune
// — `npm run check` asserts it — and the pruning that makes the walk cheap can
// only begin below the depth where the budget runs out.
//
// A transposition bridge sits between layers and has already committed its
// edit: it has one transition, on the FIRST of the two swapped characters, so
// its expected character is term[i-1] rather than term[i].
export function explainDecision(dfa, visit) {
  const grid = dfa.grid
  if (!grid || !visit) return null
  const byId = new Map(grid.nodes.map((n) => [n.id, n]))
  const setOf = (id) =>
    (id == null ? [] : dfa.states[id]?.nfaSet ?? []).map((x) => byId.get(x)).filter(Boolean)

  const expected = (n) => (n.bridge ? grid.term[n.i - 1] : n.i < grid.n ? grid.term[n.i] : null)
  const hasBudget = (n) => !n.bridge && n.e < grid.maxEdits

  const from = setOf(visit.dfaFrom)
  const to = setOf(visit.dfaTo)
  const label = visit.label ?? visit.ch ?? null
  const real = from.filter((n) => !n.bridge)

  return {
    label,
    from,
    to,
    // Readings for which this character was the one expected: they advance a
    // column and pay nothing.
    matched: from.filter((n) => expected(n) === label),
    // Readings that could still buy it with an edit (substitute or insert).
    payers: from.filter(hasBudget),
    expecting: [...new Set(from.map(expected).filter(Boolean))],
    allSpent: real.length > 0 && real.every((n) => !hasBudget(n)),
    accepted: to.length > 0,
    accepting: to.some((n) => n.accept),
  }
}

// Which drawn grid edges could have carried the walk from `fromSet` into `toSet`
// on `ch`. A deletion is an epsilon, so it fires INSIDE the new set rather than
// out of the old one — which is exactly how it is drawn. This is a statement
// about the grid model, shared by every view that lights edges; note that
// scripts/check-models.mjs keeps its own independent copy on purpose, so the
// assertion there is not checking this function against itself.
export function gridEdgesCarrying(grid, fromSet, toSet, ch) {
  const taken = new Set()
  for (const ed of grid.edges) {
    const ok =
      ed.kind === 'delete'
        ? toSet.has(ed.from) && toSet.has(ed.to)
        : fromSet.has(ed.from) && toSet.has(ed.to) && (ed.label === ch || ed.label === ANY)
    if (ok) taken.add(`${ed.from}:${ed.to}:${ed.kind}`)
  }
  return taken
}

// ---------------------------------------------------------------------------
// Intersecting the DFA with the term index
// ---------------------------------------------------------------------------

// Walk the .tip FST and the DFA together, depth-first in dictionary order. Every
// arc is either FOLLOWED (the DFA has a live transition) or PRUNED (it doesn't) —
// and a pruned arc costs nothing, skipping every term behind it. Blocks are only
// loaded where the walk actually lands.
//
// Returns a replayable list of visits plus the honest cost numbers.
// Each floor block covers the byte range [its lead byte, the next floor's). A
// floor is worth reading only if the DFA has a live transition on some byte in
// that range — which is why a leading wildcard (whose start state survives every
// byte) ends up reading all of them.
function liveFloors(floors, dfa, dfaState) {
  const st = dfa.states[dfaState]
  if (!st || st.dead) return []
  // A live ANY fallback means every byte is reachable: no floor can be skipped.
  if (st.other != null && !dfa.states[st.other].dead) return floors
  const live = dfa.alphabet.filter((c) => dfaStep(dfa, dfaState, c) != null)
  return floors.filter((f, i) => {
    const lo = f.leadByte
    const hi = floors[i + 1]?.leadByte ?? null
    return live.some((c) => c >= lo && (hi == null || c < hi))
  })
}

// Every visit carries BOTH cursors — which FST state and which DFA state it
// moved from and to. The dictionary close-up animates its two panels off exactly
// this; without it the view has to re-walk the prefix to work out where it is,
// which is a second implementation of the same walk and free to drift from it.
// The automaton's walk through the REST of a term, starting from the state the
// block's prefix left it in.
//
// This matters more than it looks. The arc walk below consumes BLOCK PREFIXES —
// one to three characters on this data — so on its own it can never reach an
// accepting state: for `serch~` it never gets past "3 characters matched" of 5.
// The match is actually decided here, when a block is read and its terms are
// completed one at a time. Without this the automaton panel looks stuck partway
// across the grid, because it is: the rest of the word had not been fed to it.
function termPath(dfa, from, prefix, term) {
  // Floor blocks and the contents block don't always share the walked prefix;
  // when they don't, the term has to be run from the start state instead.
  const usable = term.startsWith(prefix)
  const rest = usable ? term.slice(prefix.length) : term
  let s = usable ? from : dfa.start
  const steps = []
  for (const ch of rest) {
    const to = s == null ? null : dfaStep(dfa, s, ch)
    steps.push({ ch, from: s, to })
    s = to
    if (s == null) break // died: no continuation can match, stop feeding it
  }
  return {
    prefix: usable ? prefix : '',
    rest,
    steps,
    end: s,
    accepts: s != null && dfa.states[s].accept,
  }
}

export function intersectTrace(index, dfa) {
  const visits = []
  const loadedFps = new Set()
  const prunedTerms = []
  let termsRead = 0
  const matched = []

  const walk = (fstState, dfaState, prefix) => {
    const state = index.fst.states[fstState]
    const here = { fstFrom: fstState, fstTo: fstState, dfaFrom: dfaState, dfaTo: dfaState }

    // Landing on a state with a block pointer means a block must be read. When
    // the prefix was floor-split, only the floors whose byte RANGE the DFA can
    // still reach are worth reading — the rest are skipped like any other prune.
    if (state.out != null && !loadedFps.has(state.out)) {
      loadedFps.add(state.out)
      const block = index.byFp[state.out]
      const blocks = block?.floors
        ? liveFloors(block.floors, dfa, dfaState).map((f) => index.byFp[f.fp])
        : [block]
      for (const b of blocks) {
        if (!b) continue
        loadedFps.add(b.fp)
        visits.push({ action: 'load', prefix, fp: b.fp, entries: b.entries.length, ...here })
        for (const e of b.entries) {
          if (e.kind !== 'term') continue
          termsRead += 1
          const hit = matchTerm(e.term, dfa.pattern)
          visits.push({
            action: hit ? 'accept' : 'reject',
            prefix,
            term: e.term,
            fp: b.fp,
            ...here,
            // How the machine finished this word — the half of the story the
            // arc walk cannot show. `accepts` must agree with `hit`; npm run
            // check asserts it.
            path: termPath(dfa, dfaState, prefix, e.term),
          })
          if (hit) matched.push(e.term)
        }
      }
    }

    for (const arc of state.arcs) {
      const next = dfaStep(dfa, dfaState, arc.label)
      const under = index.fst.states[arc.to].terms
      if (next == null) {
        visits.push({
          action: 'prune',
          prefix,
          label: arc.label,
          termsSkipped: under,
          fstFrom: fstState,
          fstTo: arc.to,
          dfaFrom: dfaState,
          dfaTo: null, // nothing survived — that is what a prune IS
        })
        prunedTerms.push(under)
        continue
      }
      visits.push({
        action: 'follow',
        prefix,
        label: arc.label,
        dfaState: next,
        fstFrom: fstState,
        fstTo: arc.to,
        dfaFrom: dfaState,
        dfaTo: next,
      })
      walk(arc.to, next, prefix + arc.label)
    }
  }

  if (index.fst.states.length) walk(index.fst.root, dfa.start, '')

  const blocksLoaded = new Set(
    visits.filter((v) => v.action === 'load').map((v) => v.fp),
  ).size

  return {
    visits,
    matched: [...new Set(matched)].sort(),
    termsRead,
    termsTotal: index.terms.length,
    blocksLoaded,
    blocksTotal: index.blocks.length,
    prunedArcs: visits.filter((v) => v.action === 'prune').length,
    // Terms behind a pruned arc are never read. They can double-count nested
    // subtrees, so clamp to what the dictionary actually holds.
    termsPruned: Math.min(
      index.terms.length,
      index.terms.length - termsRead,
    ),
    // A leading wildcard prunes nothing — the structural version of "expensive".
    prunesNothing: !visits.some((v) => v.action === 'prune'),
  }
}
