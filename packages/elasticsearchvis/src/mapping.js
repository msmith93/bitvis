// How a source document becomes LUCENE documents — i.e. what the mapping
// actually decides. This is the whole object-vs-nested difference, in one file.
//
// `object` (the default for any sub-object) FLATTENS: the array of sub-objects
// disappears and its leaves become multi-valued fields on the parent. One Lucene
// doc. The pairing between the values is not stored anywhere, because there is
// nowhere left to store it.
//
// `nested` writes each sub-object as its OWN Lucene doc, and the parent last, as
// one contiguous block:
//
//     ordinal  id                 kind    fields
//        0     doc-3.variants#0   child   variants.color: red   variants.size: S
//        1     doc-3.variants#1   child   variants.color: blue  variants.size: XL
//        2     doc-3              root    name: Trail Runner
//
// A document with no nested path is a block of exactly ONE Lucene doc whose id
// is its `_id`, so every flat dataset behaves precisely as it did before any of
// this existed.

import { analyzeDoc } from './analyzer'

// A mapping is just the set of object paths declared `nested`. Everything else
// is an `object` and therefore flattened.
export const makeMapping = (nestedPaths = []) => new Set(nestedPaths)

export const OBJECT_MAPPING = makeMapping([])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const path = (prefix, key) => (prefix ? `${prefix}.${key}` : key)

// Add a value to a field bag, promoting to an array on the second value. That
// promotion IS the flattening: two sub-objects contributing `color` leave one
// field holding both colours and no record of which was which.
function addValue(bag, field, value) {
  if (!(field in bag)) bag[field] = value
  else if (Array.isArray(bag[field])) bag[field].push(value)
  else bag[field] = [bag[field], value]
}

// Merge one sub-object's fields into the parent's bag. THIS is the flattening:
// two sub-objects contributing `color` leave one field holding both colours and
// no record of which was which.
function foldInto(bag, fields) {
  for (const [k, v] of Object.entries(fields))
    for (const one of Array.isArray(v) ? v : [v]) addValue(bag, k, one)
}

// Flatten `source` into `bag`. Sub-objects become their own Lucene docs (into
// `children`) when their path is mapped `nested`, and are folded into the parent
// otherwise.
//
// NOTE: only the INDEXED form is kept. Real Elasticsearch also stores `_source`
// as the original JSON, so an object-mapped document still has its sub-objects
// there with the pairing intact, and hands them back on a fetch -- which is why
// the false positive is so hard to spot in practice. Showing the written form
// beside the indexed one is an OPEN ITEM: it was built and removed as too much
// for the _source column to carry at once.
function flatten(source, prefix, nested, bag, children) {
  for (const [key, value] of Object.entries(source)) {
    const p = path(prefix, key)
    const one = (item) => {
      const fields = {}
      flatten(item, p, nested, fields, children)
      if (nested.has(p)) children.push({ path: p, fields })
      else foldInto(bag, fields)
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isPlainObject(item)) one(item)
        else addValue(bag, p, item)
      }
    } else if (isPlainObject(value)) one(value)
    else addValue(bag, p, value)
  }
}

// How a document shows up in the UI, for a document whose fields are whatever
// its mapping says. `label` is the short name (a chip, a result row); `detail`
// is the longer line beside it. For the flat { title, body } documents the app
// has always had, this yields label = title and detail = body exactly.
const fmtValue = (v) => (Array.isArray(v) ? v.join(', ') : String(v))

const describe = (fields) => {
  const entries = Object.entries(fields).filter(([, v]) => v != null && v !== '')
  // The document's name: its first plain-text field.
  const named = entries.find(([, v]) => typeof v === 'string')
  const rest = entries.filter(([k]) => k !== named?.[0])
  return {
    label: named ? named[1] : '',
    // One remaining text field is a body — show it bare, which is what a
    // { title, body } document has always rendered as. Anything else gets its
    // field NAME, because once a document has several fields (or a field with
    // several values) an unlabelled string is unreadable. Multi-valued fields
    // used to be dropped here entirely, which left an object-mapped document
    // showing nothing but its name — hiding the flattening this teaches.
    detail:
      rest.length === 1 && typeof rest[0][1] === 'string'
        ? rest[0][1]
        : rest.map(([k, v]) => `${k}: ${fmtValue(v)}`).join(' · '),
  }
}

// A child's own line: the sub-object it was, spelled back out. This is what
// makes a nested block readable — you can see that ord 0 really is {red, S}.
const describeChild = (path, n, fields) => ({
  label: `${path}#${n}`,
  detail: Object.entries(fields)
    .map(([f, v]) => `${f.slice(path.length + 1)}: ${v}`)
    .join(' · '),
})

// One source document -> its block of Lucene docs, IN ORDINAL ORDER: children
// first, root last. `meta` (color, routing, shard, deleted…) is copied onto
// every doc in the block, because a block is written, routed and deleted as one.
export function buildBlock(source, { id, mapping = OBJECT_MAPPING, ...meta } = {}) {
  const rootFields = {}
  const children = []
  flatten(source, '', mapping, rootFields, children)

  const block = children.map((child, n) => ({
    id: `${id}.${child.path}#${n}`,
    root: id,
    kind: 'child',
    path: child.path,
    fields: child.fields,
    tokens: analyzeDoc(child.fields),
    ...describeChild(child.path, n, child.fields),
    ...meta,
  }))

  block.push({
    id,
    root: id,
    kind: 'root',
    fields: rootFields,
    tokens: analyzeDoc(rootFields),
    ...describe(rootFields),
    // How many Lucene docs this one Elasticsearch document cost.
    blockSize: children.length + 1,
    ...meta,
  })

  return block
}

// How many Lucene docs one source document costs under a mapping — the
// multiplier, without having to build the block to find out.
export const blockSize = (source, mapping = OBJECT_MAPPING) =>
  buildBlock(source, { id: 'x', mapping }).length
