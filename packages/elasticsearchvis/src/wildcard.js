import { analyze } from './analyzer'

// Wildcard query patterns and what they cost in the term dictionary.
//
// A shard's term dictionary is SORTED. That single fact decides everything here:
//   `sc*`      has a literal prefix, so the dictionary can be SEEKED — jump to
//              the first term >= "sc", then walk forward while the prefix holds.
//   `*search`  has no literal prefix to jump to, so every single term in the
//              dictionary must be examined. That is why leading wildcards are
//              expensive, and it gets multiplied by segments and by shards.
//
// Naming, because both conventions are in the wild: Elasticsearch calls `search*` a
// PREFIX QUERY (the wildcard sits at the end); `*search` is the LEADING WILDCARD.
// PATTERN_LABEL below spells both out so the UI can't teach the wrong word.
//
// Flagged simplification (see SPEC.md): the seek is modeled as a binary search
// over a flat sorted array. Lucene's real term dictionary is an FST + block-tree
// that seeks by prefix (and binary-searches WITHIN a term block); the cost story
// — O(log n) seek + scan of the matching range, versus a full enumeration — is
// the same, which is what this teaches.

const WILDCARD_CHARS = /[*?]/

export const hasWildcard = (s) => WILDCARD_CHARS.test(s)

export const PATTERN_LABEL = {
  term: 'exact term',
  prefix: 'prefix query · wildcard at the end',
  leading: 'leading wildcard',
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

// One query token -> { raw, literal, kind, seekPrefix, re }.
// `seekPrefix` is the literal head before the first wildcard: the string the
// dictionary can be seeked to. Empty means "nothing to seek to".
export function parsePattern(raw) {
  const literal = cleanToken(raw)
  const first = literal.search(WILDCARD_CHARS)
  const seekPrefix = first === -1 ? literal : literal.slice(0, first)
  const kind = first === -1 ? 'term' : seekPrefix ? 'prefix' : 'leading'
  return {
    raw: literal || String(raw).toLowerCase(),
    literal,
    kind,
    seekPrefix,
    re: kind === 'term' ? null : toRegExp(literal),
  }
}

// A query string -> parsed patterns. Wildcard tokens are kept whole; everything
// else still goes through the standard analyzer, so a plain query behaves
// exactly as it did before wildcards existed.
export function parseQuery(raw) {
  const out = []
  for (const token of String(raw || '').trim().split(/\s+/)) {
    if (!token) continue
    if (hasWildcard(token)) {
      const p = parsePattern(token)
      if (p.literal) out.push(p)
    } else {
      for (const t of analyze(token)) out.push(parsePattern(t))
    }
  }
  return out
}

export function matchTerm(term, pattern) {
  return pattern.kind === 'term' ? term === pattern.literal : pattern.re.test(term)
}

export const matchesAny = (term, patterns) => patterns.some((p) => matchTerm(term, p))

// Terms of a dictionary that a pattern expands to. A wildcard query is really a
// boolean OR over these matched terms.
export const expandTerms = (terms, patterns) =>
  terms.filter((t) => matchesAny(t, patterns))

export const isWildcardQuery = (patterns) => patterns.some((p) => p.kind !== 'term')

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
