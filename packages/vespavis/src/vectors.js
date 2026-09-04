// The embedding model.
//
// Vespa's `embed` indexing expression runs a real bi-encoder (a Vespa-hosted
// or ONNX model) over a text field and stores the result in a tensor attribute.
// Real embeddings are 384-1536 dimensions of nothing a human can read, which
// makes them useless for teaching: "trust me, these two are close" is not an
// explanation.
//
// So this app ships a TWO-dimensional embedding model you can check by hand. A
// small lexicon puts each meaningful word at an angle on the unit circle;
// embedding a text means summing the unit vectors of the words it contains and
// normalizing. Words the lexicon does not know contribute nothing.
//
// Everything downstream of this file is exactly what Vespa does: the vector
// goes into a tensor attribute, an HNSW index is built over it, the
// nearestNeighbor operator searches it, and `closeness()` turns the distance
// into a rank feature. Only the model producing the numbers is a toy, and it is
// a toy on purpose — see SPEC.md.

const D = Math.PI / 180

// word -> [angle in degrees, weight]. Four topics, ~65-95 degrees apart, so a
// document about one of them lands unambiguously in its own arc of the circle.
//
// The WEIGHTS are the part worth explaining. A real bi-encoder does not treat
// every content word alike: the noun that names the thing carries the meaning,
// and the adjectives modify it. Give them equal weight and "insulated hiking
// boot with a waterproof leather upper for cold, wet weather" drifts halfway to
// outerwear on the strength of four modifiers, and the vector search starts
// recommending boots to someone shopping for a coat. Head nouns are weighted 5,
// modifiers 1 -- the smallest thing that makes this toy behave the way the real
// model it stands in for behaves.
const HEAD = 5

export const LEXICON = {
  // ---- footwear (~30 degrees) ----
  shoe: [30, HEAD], shoes: [30, HEAD], sneaker: [32, HEAD], sneakers: [32, HEAD],
  boot: [28, HEAD], boots: [28, HEAD], gaiters: [28, HEAD],
  sole: [30, 1], lace: [30, 1], laces: [30, 1], foot: [30, 1], feet: [30, 1],
  running: [34, 1], trail: [26, 1], hiking: [26, 1], walking: [34, 1],
  cushioned: [34, 1], grippy: [26, 1], leather: [30, 1], upper: [30, 1],

  // ---- outerwear (~95 degrees) ----
  jacket: [95, HEAD], coat: [95, HEAD], parka: [92, HEAD], shell: [98, HEAD],
  windbreaker: [98, HEAD], fleece: [90, HEAD], midlayer: [90, HEAD],
  rain: [100, 1], rainy: [100, 1], wet: [100, 1], downpour: [100, 1],
  storm: [100, 1], stormy: [100, 1], waterproof: [97, 1], dry: [100, 1],
  wind: [96, 1], windproof: [96, 1], weather: [96, 1], insulated: [88, 1],
  warm: [88, 1], quilted: [88, 1], hood: [95, 1], seams: [97, 1],
  packable: [98, 1], layer: [90, 1], taped: [97, 1], sealed: [97, 1],

  // ---- electronics (~190 degrees) ----
  speaker: [190, HEAD], headphones: [190, HEAD], earbuds: [190, HEAD],
  bluetooth: [188, 1], wireless: [188, 1], battery: [192, 1],
  charging: [192, 1], charge: [192, 1], audio: [190, 1], sound: [190, 1],
  noise: [186, 1], cancelling: [186, 1], rugged: [194, 1], hours: [192, 1],

  // ---- kitchen (~285 degrees) ----
  skillet: [285, HEAD], pan: [285, HEAD], kettle: [288, HEAD],
  knife: [282, HEAD], flask: [288, HEAD],
  chef: [282, 1], cook: [285, 1], cooking: [285, 1], searing: [285, 1],
  roasting: [285, 1], baking: [285, 1], brewing: [288, 1], coffee: [288, 1],
  ceramic: [284, 1], nonstick: [284, 1], iron: [286, 1], seasoned: [286, 1],
  gooseneck: [288, 1], forged: [282, 1], handle: [282, 1], prep: [282, 1],
  frying: [285, 1], vacuum: [288, 1],
}

// Words the model has no opinion about. Kept out of the lexicon deliberately:
// an embedding built from a bag of function words would drift toward whatever
// direction the noise happened to point, and the reader would rightly not
// believe it.
export function lexiconHits(terms) {
  return terms.filter((t) => LEXICON[t] !== undefined)
}

// Sum the weighted unit vectors of the known words, then normalize. Returns
// null when the text contains nothing the model knows -- a real bi-encoder
// always returns SOME vector, but pretending to know where "the of and" sits
// would be worse than admitting the model has nothing to say.
export function embed(terms) {
  let x = 0
  let y = 0
  let n = 0
  for (const t of terms) {
    const entry = LEXICON[t]
    if (!entry) continue
    const [deg, w] = entry
    x += w * Math.cos(deg * D)
    y += w * Math.sin(deg * D)
    n++
  }
  if (n === 0) return null
  const len = Math.hypot(x, y)
  if (len < 1e-9) return null
  return [x / len, y / len]
}

// Angular distance, as Vespa's `distance-metric: angular` computes it:
// 1 - cosine similarity, in [0, 2]. Any monotone function of the angle gives
// the same RANKING, which is all this app reads it for — see SPEC.md.
export function angularDistance(a, b) {
  if (!a || !b) return Infinity
  const dot = a[0] * b[0] + a[1] * b[1]
  const la = Math.hypot(a[0], a[1])
  const lb = Math.hypot(b[0], b[1])
  if (!la || !lb) return Infinity
  return Math.max(0, 1 - dot / (la * lb))
}

// The `closeness(field, embedding)` rank feature. Vespa's own definition:
// 1 / (1 + distance), so 1.0 is a perfect match and it decays toward 0.
export const closeness = (distance) =>
  Number.isFinite(distance) ? 1 / (1 + distance) : 0

// The angle a vector points at, in degrees — used only by the UI to draw the
// vector and to name the topic arc it landed in.
export function angleOf(v) {
  if (!v) return null
  const a = (Math.atan2(v[1], v[0]) / D + 360) % 360
  return a
}

export const TOPIC_ARCS = [
  { label: 'footwear', deg: 30 },
  { label: 'outerwear', deg: 95 },
  { label: 'electronics', deg: 190 },
  { label: 'kitchen', deg: 285 },
]

// The nearest topic arc to a vector, so the UI can say "this query landed in
// outerwear" rather than printing two floats at the reader.
export function nearestTopic(v) {
  const a = angleOf(v)
  if (a === null) return null
  let best = null
  for (const t of TOPIC_ARCS) {
    const d = Math.min(Math.abs(a - t.deg), 360 - Math.abs(a - t.deg))
    if (!best || d < best.d) best = { ...t, d }
  }
  return best
}
