import { analyze } from './analyzer'

// Multi-term query patterns — wildcards and fuzzies — and what they cost in the
// term dictionary.
//
// A shard's term dictionary is SORTED. That single fact decides everything here:
//   `sc*`      has a literal prefix, so the dictionary can be SEEKED — jump to
//              the first term >= "sc", then walk forward while the prefix holds.
//   `*search`  has no literal prefix to jump to, so every single term in the
//              dictionary must be examined. That is why leading wildcards are
//              expensive, and it gets multiplied by segments and by shards.
//   `serch~1`  is the same story wearing different clothes. A fuzzy match may
//              differ in its very first character, so by default there is
//              nothing to seek to either — which is exactly what `prefix_length`
//              exists to fix: pin the first p characters and the seek comes back.
//
// So `seekPrefix` is the one field that decides cost, for every kind: non-empty
// means the dictionary can be seeked, empty means it must be enumerated. The
// traces at the bottom of this file read only that, which is why adding fuzzy
// required no change to them at all.
//
// Naming, because both conventions are in the wild: Elasticsearch calls `search*` a
// PREFIX QUERY (the wildcard sits at the end); `*search` is the LEADING WILDCARD.
// patternLabel() spells them out so the UI can't teach the wrong word.
//
// Flagged simplification (see SPEC.md): the seek is modeled as a binary search
// over a flat sorted array. Lucene's real term dictionary is an FST + block-tree
// that seeks by prefix (and binary-searches WITHIN a term block); the cost story
// — O(log n) seek + scan of the matching range, versus a full enumeration — is
// the same, which is what this teaches.

const WILDCARD_CHARS = /[*?]/
// `term~`, `term~1`, `term~2` — Lucene's fuzzy operator. The digit is optional;
// without it the edit distance comes from Fuzziness.AUTO.
const FUZZY_SUFFIX = /~(\d?)$/

export const hasWildcard = (s) => WILDCARD_CHARS.test(s)
export const hasFuzzy = (s) => FUZZY_SUFFIX.test(s)
// A token the analyzer must NOT touch, because the operator would be eaten.
export const isPatternToken = (s) => hasWildcard(s) || hasFuzzy(s)

// Lucene's LevenshteinAutomata.MAXIMUM_SUPPORTED_DISTANCE. Past 2 edits the
// automaton stops being worth building and nearly everything matches anyway.
export const MAX_EDITS = 2

// Fuzziness.AUTO with Elasticsearch's AUTO:3,6 defaults. Short terms get no
// slack at all, because one edit on a two-character term is most of the term.
export function autoFuzziness(term) {
  if (term.length <= 2) return 0
  return term.length <= 5 ? 1 : 2
}

export const PATTERN_LABEL = {
  term: 'exact term',
  prefix: 'prefix query · wildcard at the end',
  leading: 'leading wildcard',
  fuzzy: 'fuzzy query',
}

// The label for ONE pattern. A fuzzy carries numbers — how many edits, how much
// of the front is pinned — so it can't be a static string like the others, and
// describing it as a glob would teach the wrong thing.
export function patternLabel(p) {
  if (!p) return 'pattern'
  if (p.kind !== 'fuzzy') return PATTERN_LABEL[p.kind] ?? 'pattern'
  const edits = `fuzzy query · up to ${p.maxEdits} edit${p.maxEdits === 1 ? '' : 's'}`
  return p.prefixLength
    ? `${edits}, first ${p.prefixLength} character${p.prefixLength === 1 ? '' : 's'} fixed`
    : `${edits}, nothing fixed`
}

// Drop whatever the analyzer would drop, but KEEP the wildcard operators — this
// is why patterns can't just go through analyze(), which splits on `*`.
const cleanToken = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}'*?]+/gu, '')

function toRegExp(literal) {
  const body = literal
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metachars, leaving * and ?
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${body}$`)
}

// Damerau-Levenshtein (optimal string alignment), bounded: it gives up as soon
// as no cell in a row is within `max`, because every caller asks "is this within
// N edits" and none asks "how far apart are these really".
//
// A transposition counts as ONE edit, which is Lucene's default
// (`transpositions: true`) — "hte" is one slip of the fingers from "the", not two.
export function editDistance(a, b, max = Infinity, transpositions = true) {
  if (a === b) return 0
  // Length alone can settle it: each edit changes the length by at most one.
  if (Math.abs(a.length - b.length) > max) return max + 1

  let prev2 = null
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(
        prev[j] + 1, // deletion
        cur[j - 1] + 1, // insertion
        prev[j - 1] + cost, // match or substitution
      )
      if (
        transpositions &&
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      )
        v = Math.min(v, prev2[j - 2] + 1)
      cur[j] = v
      if (v < best) best = v
    }
    // Every later row is >= the best cell of this one, so nothing can recover.
    if (best > max) return max + 1
    prev2 = prev
    prev = cur
  }
  return prev[b.length]
}

// One query token -> a pattern:
//   { raw, literal, kind, seekPrefix, re, maxEdits?, prefixLength?, transpositions? }
//
// `seekPrefix` is the head the dictionary can be seeked to — the literal before
// the first wildcard, or the pinned prefix of a fuzzy. Empty means "nothing to
// seek to", and that one field is the whole cost story for every kind.
export function parsePattern(raw, { prefixLength = 0 } = {}) {
  const text = String(raw)
  const fuzzy = text.match(FUZZY_SUFFIX)

  if (fuzzy) {
    // Strip the operator BEFORE cleaning, so cleanToken's character class (and
    // therefore the analyzer's) needs no `~` special case.
    const literal = cleanToken(text.slice(0, fuzzy.index))
    const maxEdits = Math.min(
      MAX_EDITS,
      fuzzy[1] === '' ? autoFuzziness(literal) : Number(fuzzy[1]),
    )
    const pinned = Math.min(prefixLength, literal.length)
    return {
      // A degenerate zero-edit fuzzy is an exact term, so it must not go on
      // wearing a `~0` it will never honour.
      raw: literal ? (maxEdits === 0 ? literal : `${literal}~${maxEdits}`) : text.toLowerCase(),
      literal,
      // Zero edits is an exact term, not a fuzzy — say so, rather than building
      // an automaton that can only ever match one string.
      kind: maxEdits === 0 ? 'term' : 'fuzzy',
      seekPrefix: maxEdits === 0 ? literal : literal.slice(0, pinned),
      re: null,
      maxEdits,
      prefixLength: pinned,
      transpositions: true,
    }
  }

  const literal = cleanToken(text)
  const first = literal.search(WILDCARD_CHARS)
  const seekPrefix = first === -1 ? literal : literal.slice(0, first)
  const kind = first === -1 ? 'term' : seekPrefix ? 'prefix' : 'leading'
  return {
    raw: literal || text.toLowerCase(),
    literal,
    kind,
    seekPrefix,
    re: kind === 'term' ? null : toRegExp(literal),
  }
}

// A query string -> parsed patterns. Pattern tokens (`*`, `?`, `~`) are kept
// whole; everything else still goes through the standard analyzer, so a plain
// query behaves exactly as it did before any of this existed.
//
// `prefixLength` is the app-level fuzzy prefix_length, applied to every fuzzy
// token in the query.
export function parseQuery(raw, opts = {}) {
  const out = []
  for (const token of String(raw || '').trim().split(/\s+/)) {
    if (!token) continue
    if (isPatternToken(token)) {
      const p = parsePattern(token, opts)
      if (p.literal) out.push(p)
    } else {
      for (const t of analyze(token)) out.push(parsePattern(t))
    }
  }
  return out
}

// The single semantic authority on whether a term matches a pattern. BOTH zoom
// levels route through here — src/automaton.js delegates its per-term verdict to
// this function — which is what keeps the DFA walk and the flat scan from ever
// disagreeing about what matched.
export function matchTerm(term, pattern) {
  if (pattern.kind === 'term') return term === pattern.literal
  if (pattern.kind === 'fuzzy') {
    // prefix_length is a hard requirement, not a hint: those characters may not
    // be edited. Checked here as well as in the dictionary walk, because
    // matchesAny is also called where there is no walk to have filtered first.
    if (pattern.prefixLength && !term.startsWith(pattern.seekPrefix)) return false
    return (
      editDistance(term, pattern.literal, pattern.maxEdits, pattern.transpositions) <=
      pattern.maxEdits
    )
  }
  return pattern.re.test(term)
}

export const matchesAny = (term, patterns) => patterns.some((p) => matchTerm(term, p))

// Terms of a dictionary that a pattern expands to. A wildcard or fuzzy query is
// really a boolean OR over these matched terms.
export const expandTerms = (terms, patterns) =>
  terms.filter((t) => matchesAny(t, patterns))

// Does this query need the dictionary matched rather than looked up? True for
// every kind but `term` — a fuzzy inherits the pattern step list from this.
export const isPatternQuery = (patterns) => patterns.some((p) => p.kind !== 'term')

// How ONE pattern is resolved against ONE sorted dictionary, as a replayable
// trace of probes. This is the model behind the close-up's animation, and its
// `examined` count is the honest cost number.
//
//   seek mode: binary-search probes ({ lo, hi, i, cmp }) until the insertion
//     point, then a forward scan of the matching range. The scan deliberately
//     includes the FIRST non-matching term — reading it is how the scan learns
//     the range ended.
//   scan mode: every term, in order. No shortcuts exist.
export function dictionaryTrace(terms, pattern) {
  const n = terms.length
  const probes = []
  const matched = []

  if (pattern.seekPrefix) {
    let lo = 0
    let hi = n
    while (lo < hi) {
      const i = (lo + hi) >> 1
      const cmp = terms[i].localeCompare(pattern.seekPrefix)
      probes.push({ phase: 'seek', i, lo, hi: hi - 1, cmp, pattern: pattern.raw })
      if (cmp < 0) lo = i + 1
      else hi = i
    }
    if (pattern.kind === 'term') {
      // An exact term is a single read at the insertion point — there is no
      // range to walk, so it must not be charged for the terms that happen to
      // share its prefix ("search" does not read "searchable").
      if (lo < n) {
        const hit = terms[lo] === pattern.literal
        probes.push({ phase: 'scan', i: lo, match: hit, stop: !hit, pattern: pattern.raw })
        if (hit) matched.push(terms[lo])
      }
    } else {
      for (let i = lo; i < n; i++) {
        const inRange = terms[i].startsWith(pattern.seekPrefix)
        const hit = inRange && matchTerm(terms[i], pattern)
        probes.push({ phase: 'scan', i, match: hit, stop: !inRange, pattern: pattern.raw })
        if (hit) matched.push(terms[i])
        if (!inRange) break
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const hit = matchTerm(terms[i], pattern)
      probes.push({ phase: 'scan', i, match: hit, pattern: pattern.raw })
      if (hit) matched.push(terms[i])
    }
  }

  return {
    mode: pattern.seekPrefix ? 'seek' : 'scan',
    probes,
    matched,
    examined: new Set(probes.map((p) => p.i)).size,
    total: n,
  }
}

// Every pattern resolved against one dictionary, back to back — the whole cost
// of answering this query in this segment.
export function dictionaryScan(terms, patterns) {
  const traces = patterns.map((p) => dictionaryTrace(terms, p))
  const probes = traces.flatMap((t) => t.probes)
  return {
    traces,
    probes,
    matched: [...new Set(traces.flatMap((t) => t.matched))],
    // Terms read at least once. Patterns that overlap re-read the same rows, so
    // this counts work done, not distinct rows visited.
    examined: traces.reduce((n, t) => n + t.examined, 0),
    total: terms.length,
    mode: traces.some((t) => t.mode === 'scan') ? 'scan' : 'seek',
  }
}
