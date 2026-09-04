// The application package: the schemas, the knobs that edit them, and the
// documents fed into them.
//
// A Vespa application is configured by SCHEMAS, not by a mapping API call. A
// schema names the fields, says what to do with each one (the `indexing`
// statement), and declares the rank profiles. Everything this app simulates is a
// consequence of that text — so the text is generated from the same config
// object the model reads, and rendered verbatim in the UI. Edit a knob in the
// panel and both the schema you are looking at and the behaviour you are
// watching change together, because there is only one source for both.

import { embed } from './vectors'

// The analyzer. Vespa's linguistics module does language detection, tokenizing,
// normalizing and stemming; this is a lowercase-and-split stand-in for it, so
// that "your words become terms" stays legible. No stemming, no stopwords.
export const analyze = (text) =>
  (text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean)

// ---- The live schema config -------------------------------------------------
// Every one of these is a real decision a Vespa application makes, and every one
// has a consequence the app can actually show. Nothing here is decoration: if a
// knob cannot change what you see happen, it does not belong in this object.
export const DEFAULT_SCHEMA_CONFIG = {
  // `attribute: fast-search` on `category`. With it, the filter is an index
  // lookup and can be evaluated BEFORE the vector search (pre-filtering).
  // Without it, evaluating the filter up front is not cheap, so the graph is
  // searched first and the filter applied after — and you get back fewer hits
  // than you asked for. See ranking.js.
  categoryFastSearch: true,

  // The hybrid profile's first-phase weight on the lexical half. BM25 is
  // unbounded and closeness is in [0,1], so a hybrid first-phase is always a
  // weighted sum with a tuned constant — first-phase runs per document and
  // cannot normalize against scores it has not seen.
  lexicalWeight: 0.2,

  // second-phase { rerank-count }, per content node.
  secondPhaseRerankCount: 3,

  // global-phase { rerank-count }, on the merged list, in the container.
  globalPhaseRerankCount: 5,

  // {targetHits: N}nearestNeighbor(...), per content node.
  targetHits: 4,
}

// Which field a partial update targets. This is not a schema edit — both fields
// already exist with the indexing statements shown — but it is the schema that
// decides what the update COSTS, so the choice belongs next to the schema.
export const UPDATE_FIELDS = {
  popularity: {
    field: 'popularity',
    kind: 'attribute',
    label: 'popularity',
    sub: 'attribute',
  },
  title: {
    field: 'title',
    kind: 'index',
    label: 'title',
    sub: 'index field',
  },
}

// ---- The schemas ------------------------------------------------------------
// Generated from the config so the panel can never drift from what runs.
export function buildProductSchema(c = DEFAULT_SCHEMA_CONFIG) {
  return `schema product {

  document product {

    field title type string {
      indexing: summary | index
      index: enable-bm25
    }

    field description type string {
      indexing: summary | index
      index: enable-bm25
    }

    field category type string {
      indexing: summary | attribute${
        c.categoryFastSearch ? '\n      attribute: fast-search' : ''
      }
    }

    field popularity type float {
      indexing: summary | attribute
    }
  }

  # One pooled vector for the whole document.
  # This is the one HNSW indexes: a graph needs
  # a single point per document to be a graph.
  field embedding type tensor<float>(x[2]) {
    indexing: input title . " " . input description | embed | attribute | index
    attribute {
      distance-metric: angular
    }
    index {
      hnsw {
        max-links-per-node: 16
        neighbors-to-explore-at-insert: 200
      }
    }
  }

  # One vector PER PASSAGE, mapped dimension.
  # Not indexed: it rides to the container as a
  # match-feature and is re-scored in global-phase.
  field passages type tensor<float>(p{}, x[2]) {
    indexing: attribute
  }

  fieldset default {
    fields: title, description
  }
}`
}

// The user schema, for the recommendation use case. It is deliberately NOT
// generated from the config: there is nothing to tune, and its shape is the
// whole lesson.
//
// Note what `profile` does not have. No `index`, so no HNSW graph — nothing
// ever runs a nearest-neighbour search over users, only over products. A vector
// with no graph behind it is a plain in-memory column, which is why assigning a
// new profile is one write to one cell and costs the same as setting a float.
// That is what makes per-user, per-click personalization affordable.
export const USER_SCHEMA = `schema user {

  document user {

    field user_id type string {
      indexing: summary | attribute
    }

    # A tensor attribute with no index and no hnsw:
    # nothing ANN-searches users, so there is no
    # graph to maintain and an update is one
    # in-place assignment.
    field profile type tensor<float>(x[2]) {
      indexing: summary | attribute
    }
  }
}`

// What each indexing statement actually costs. This is the single most
// consequential thing to understand about a Vespa schema: `index` and
// `attribute` are not two words for the same idea.
export const INDEXING_LEGEND = [
  {
    kw: 'index',
    where: 'disk (memory index first)',
    what: 'Full-text postings, matched by weakAnd and scored with BM25. Written to the memory index on feed and moved to a disk index by a flush. Immutable once written, so changing the field means rewriting the document.',
  },
  {
    kw: 'attribute',
    where: 'memory',
    what: 'A live column store. Filtering, sorting, grouping and ranking read it directly — and it is the only kind of field that can be assigned in place at memory speed.',
  },
  {
    kw: 'index (tensor)',
    where: 'memory',
    what: 'An HNSW graph over a tensor attribute, searched by nearestNeighbor. Mutable and real-time: one graph per field per node, updated live. A tensor attribute WITHOUT this is just a column — cheap to write, but nothing can ANN-search it.',
  },
  {
    kw: 'summary',
    where: 'disk (document store)',
    what: 'The value is returned in the response. Fetched in the summary phase, for the final hits only.',
  },
]

// ---- The product corpus -----------------------------------------------------
// A small catalog: text, structured attributes and vectors over the same
// documents, queried together. It is tuned for exactly two disagreements, and
// they are the whole point of the hybrid lesson:
//
//   * "Rain Shell Windbreaker" is what you want for `waterproof jacket` and
//     contains NEITHER word. Only the vector finds it.
//   * "Waterproof Bluetooth Speaker" contains `waterproof` and is not a
//     jacket at all. Only the vector pushes it back down.
//
// Do not edit these two without re-reading SPEC.md; `npm run check` asserts
// both disagreements still happen.
const CATALOG = [
  {
    title: 'Storm Shell Jacket',
    description:
      'A waterproof jacket that shrugs off heavy rain and wind. Taped seams keep you dry.',
    category: 'outerwear',
    popularity: 0.72,
  },
  {
    title: 'Rain Shell Windbreaker',
    description:
      'A packable shell for a sudden downpour. Keeps the wind and the wet out on a grey day.',
    category: 'outerwear',
    popularity: 0.61,
  },
  {
    title: 'Down Parka',
    description: 'An insulated parka for deep cold. Warm, quilted and windproof.',
    category: 'outerwear',
    popularity: 0.44,
  },
  {
    title: 'Fleece Midlayer',
    description: 'A warm fleece to wear under a shell when the weather turns.',
    category: 'outerwear',
    popularity: 0.38,
  },
  {
    title: 'Trail Runner GTX',
    description:
      'A lightweight trail running shoe with a waterproof membrane and a grippy sole.',
    category: 'footwear',
    popularity: 0.66,
  },
  {
    title: 'Alpine Hiking Boot',
    description:
      'An insulated hiking boot with a waterproof leather upper for cold days on the trail.',
    category: 'footwear',
    popularity: 0.52,
  },
  {
    title: 'City Sneaker',
    description: 'An everyday sneaker with a cushioned sole for walking the city.',
    category: 'footwear',
    popularity: 0.81,
  },
  {
    title: 'Waterproof Bluetooth Speaker',
    description:
      'A rugged waterproof speaker with long battery life and wireless bluetooth audio.',
    category: 'electronics',
    popularity: 0.9,
  },
  {
    title: 'Noise Cancelling Headphones',
    description:
      'Over-ear headphones with active noise cancelling and thirty hours of battery.',
    category: 'electronics',
    popularity: 0.87,
  },
  {
    title: 'Wireless Earbuds',
    description: 'Tiny wireless earbuds with a charging case and clear audio.',
    category: 'electronics',
    popularity: 0.79,
  },
  {
    title: 'Cast Iron Skillet',
    description:
      'A pre-seasoned cast iron skillet for searing, roasting and baking.',
    category: 'kitchen',
    popularity: 0.58,
  },
  {
    title: 'Pour Over Coffee Kettle',
    description: 'A gooseneck kettle for pour over coffee brewing.',
    category: 'kitchen',
    popularity: 0.49,
  },
  {
    title: 'Ceramic Nonstick Pan',
    description: 'A nonstick ceramic frying pan for everyday cooking.',
    category: 'kitchen',
    popularity: 0.55,
  },
  {
    title: 'Chef Knife',
    description: 'A forged chef knife with a balanced handle for daily prep.',
    category: 'kitchen',
    popularity: 0.63,
  },
]

export const CATEGORIES = ['outerwear', 'footwear', 'electronics', 'kitchen']

// One colour per category, from Vespa's secondary palette (see index.css) —
// mid-strength versions of the brand sky, a warm grey, the brand pink and the
// brand yellow, deep enough to read as an 8px dot on the light theme's white.
//
// Deliberately NONE of these is the accent green. The accent is UI chrome — it
// is the colour of "this is happening right now", and it is what outlines a hit
// the query returned. A document that happened to be filed under outerwear must
// not look like a document the query just chose.
export const CATEGORY_COLOR = {
  outerwear: '#7fc4de',
  footwear: '#a6a693',
  electronics: '#cd8fb2',
  kitchen: '#c9ab3c',
}

// Vespa document ids are URIs: id:<namespace>:<doctype>::<user-specified>.
// The whole string is hashed to a location, and the location's leading bits
// name the bucket — so the id is not just a label, it is the placement.
export const docId = (n) => `id:catalog:product::${n}`
export const userId = (name) => `id:catalog:user::${name}`

// Turn a source record into the document the content cluster actually stores:
// analyzed terms per indexed field, an embedding, and the attributes.
export function makeDoc(src, n) {
  const id = docId(n)
  const titleTerms = analyze(src.title)
  const descTerms = analyze(src.description)
  return {
    id,
    n,
    type: 'product',
    title: src.title,
    description: src.description,
    category: src.category,
    popularity: src.popularity,
    terms: { title: titleTerms, description: descTerms },
    // The `embed` indexing expression runs over title + description, exactly as
    // the schema's synthetic field says it does. ONE vector for the whole
    // document — which means the title's meaning and the description's meaning
    // are averaged together into a single direction.
    embedding: embed([...titleTerms, ...descTerms]),
    // The per-passage vectors, one per field. This is a `tensor(p{}, x[2])` —
    // a MAPPED dimension, so a document carries as many vectors as it has
    // passages. First-phase and second-phase never touch it: retrieval runs
    // against the single pooled `embedding`, because that is the one an HNSW
    // graph can be built over. The passages ride up to the container as a
    // match-feature and are what global-phase re-scores.
    passages: {
      title: embed(titleTerms),
      description: embed(descTerms),
    },
    color: CATEGORY_COLOR[src.category],
  }
}

export const CORPUS = CATALOG.map((src, i) => makeDoc(src, i + 1))

// The next document a Feed will write.
export const NEW_DOCS = [
  {
    title: 'Three Layer Rain Jacket',
    description:
      'A three layer waterproof jacket with sealed seams and a storm hood for the worst weather.',
    category: 'outerwear',
    popularity: 0.5,
  },
  {
    title: 'Insulated Coffee Flask',
    description: 'A vacuum insulated flask that keeps coffee warm all day.',
    category: 'kitchen',
    popularity: 0.4,
  },
  {
    title: 'Waterproof Hiking Gaiters',
    description: 'Waterproof gaiters that keep trail grit and wet out of your boots.',
    category: 'footwear',
    popularity: 0.3,
  },
]

// ---- Users ------------------------------------------------------------------
// Two demo users, each a `user` document with a profile tensor. Their starting
// angles sit BETWEEN topic arcs on purpose: a profile parked exactly on one
// topic recommends that topic and nothing moves when you engage with something,
// which teaches nothing. Starting between two makes every engagement visible.
const D = Math.PI / 180
const at = (deg) => [Math.cos(deg * D), Math.sin(deg * D)]

const USER_SEEDS = [
  { name: 'alice', deg: 142, note: 'somewhere between outerwear and electronics' },
  { name: 'bob', deg: 340, note: 'somewhere between kitchen and footwear' },
]

export function makeUser({ name, deg, note }) {
  return {
    id: userId(name),
    type: 'user',
    n: name,
    user_id: name,
    profile: at(deg),
    note,
  }
}

export const USERS = USER_SEEDS.map(makeUser)

// How much one engagement moves a profile. A real system would use a learned
// update with a decay; this is the smallest thing that is honest about the
// SHAPE of what happens — the profile moves toward what you engaged with, and
// the move is a new value assigned to one attribute cell.
export const ENGAGEMENT_RATE = 0.5

export function nudgeProfile(profile, towards, rate = ENGAGEMENT_RATE) {
  if (!profile || !towards) return profile
  const x = profile[0] + rate * towards[0]
  const y = profile[1] + rate * towards[1]
  const len = Math.hypot(x, y)
  if (len < 1e-9) return profile
  return [x / len, y / len]
}
