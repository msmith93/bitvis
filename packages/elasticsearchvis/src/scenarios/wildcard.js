// "Why are prefix wildcard queries expensive?"
//
// The lesson is one property of the term dictionary — it is SORTED — and the two
// very different things that follow from it. The scenario runs the same query
// shape twice, `sc*` then `*search`, and sends the user into the 🔍 close-up
// both times, because the difference is only visible inside a segment: a seek
// that touches a handful of rows versus an enumeration of every single one.
// The dictionary panel's own step list is index · walk · read · found, so the
// arc walk — the thing both "read the arcs" steps below describe — happens at
// index 1. Speaking before the panel gets there shows a tip about a walk that
// has not started; and because those steps are cta-with-no-advanceOn, they FREEZE
// the panel (App's `held`), so it would never get there afterwards either.
// Unlike the shard panel's step list (a pure function, so check-models pins its
// indices), these steps live in a .jsx stage the model check cannot import — so
// this index is documented rather than asserted. Passing when the panel is
// closed keeps it safe either way: a wrong index degrades to "the tip appears
// once the reader exits", never to a hang.
import { reviewResults } from './shared'

const PANEL_WALK = 1
const atDictWalk = (s) => s.closeUpKind !== 'dictionary' || s.closeUpStep >= PANEL_WALK

// The SHARD panel's own step list, for the single-clause pattern queries this
// scenario runs against a flat dataset: parse · lookup · expand · postings ·
// score · topk · return (localSearchSteps in src/ops/search.js — a pure
// function, unlike the dictionary panel's steps above). `lookup` is where the
// probe itself plays out — the seek for “sc*”, the full enumeration for
// “*search” — so the two "descend one level" tips below wait for the reader to
// have actually watched it finish before telling them what it was.
const PANEL_LOOKUP = 1
const pastLookup = (s) => s.closeUpKind === 'shard' && s.closeUpStep > PANEL_LOOKUP

const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'Why are leading wildcards expensive?',
    body: [
      'A shard’s inverted index keeps its terms in sorted order. That one detail decides whether a wildcard query is cheap or ruinous.',
      '“sc*” has a literal prefix to jump to. “*search” does not — and you will watch the difference, term by term, inside a real segment.',
    ],
    cta: 'Show me',
    secondary: 'Skip for now',
  },
  {
    id: 'load',
    target: '[data-tour="load-docs"]',
    targetExtra: '[data-tour="load-docs-menu"]',
    dataset: 'sample',
    placement: 'right',
    title: 'Start with some data',
    body: 'Open “Load docs” and pick “Sample docs” to fill the cluster with searchable segments.',
    advanceOn: (s) => s.sampleSet === 'sample',
  },
  {
    id: 'merge',
    target: '[data-tour="merge"]',
    placement: 'right',
    title: 'Merge first, so the dictionaries are worth reading',
    body: 'Click Merge. Each shard’s small segments become one bigger segment, with the shard’s whole vocabulary in a single term dictionary.',
    // Merge is disabled while another op's clock runs, and the sample set
    // tombstones a doc so Refresh is live too — an off-script click lands here.
    // Wait for an idle timeline so the ring only lands on a pressable button.
    waitFor: (s) => !s.playing,
    advanceOn: (s) => s.opType === 'merge',
  },
  {
    id: 'run-prefix',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'First, the cheap one: sc*',
    body: 'We have put “sc*” in the search box — every term starting with “sc”. Hit Search.',
    // Search is disabled until the merge has both finished and stopped playing.
    waitFor: (s) => (s.opType !== 'merge' || s.opDone) && !s.playing,
    onShow: (s, actions) => {
      actions.setRouting('')
      actions.setQuery('sc*')
    },
    advanceOn: (s) => s.opQuery === 'sc*',
  },
  {
    id: 'magnify-prefix',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Look inside a segment',
    waitFor: (s) => s.opQuery === 'sc*' && s.opStep === 2,
    onShow: (s, actions) => actions.pause(),
    body: 'Every serving shard is now resolving that pattern in each of its segments. Click the highlighted 🔍 and watch the dictionary get seeked.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    // The seekable run gets its own descent. This used to be skipped, on the
    // grounds that the deep panel's own contrast table showed the cheap case
    // beside the expensive one — but that table was removed as clutter (SPEC.md
    // records why), so without this the reader only ever sees the structure for
    // the pattern that CAN'T use it, and never watches an arc actually die.
    id: 'dictionary-prefix',
    target: '[data-anat-dict]',
    placement: 'bottom',
    // The zoom icon now sits by the segment id, a small target the tip's own
    // top-left corner would land on — nudge the tip clear so the 🔍 stays clickable.
    offset: { x: 40 },
    title: 'That binary search was a simplification',
    waitFor: pastLookup,
    // Freezes the shard panel's own clock the instant this tip appears, so the
    // background stays parked on the seek it just finished rather than racing
    // on to "score" / "top hits" while the reader is being told about it.
    holdPanel: true,
    body: 'The probe you just watched treats the dictionary as a flat sorted array and bisects it. That is a useful simplification. What Lucene actually keeps is blocks of terms on disk, indexed by a small automaton held in memory. Click the 🔍 icon to watch “sc*” resolved against the real FST.',
    advanceOn: (s) => s.closeUpKind === 'dictionary',
  },
  {
    // Spotlighted rather than a centered card, for the same reason as
    // read-the-no-prune below: a card's backdrop would dim the picture being
    // described. No numbers in this copy — the panel's readout owns them
    // (SPEC.md: every rendered number comes from a trace).
    id: 'read-the-prune',
    target: '[data-tour="fst"]',
    placement: 'right',
    title: 'Watch an arrow die',
    body: 'Follow the walk. “sc*” can only ever accept a term beginning s-c, so at the very first character the machine refuses every other arrow: it turns red, and the whole branch of the dictionary behind it is skipped without being read.',
    waitFor: atDictWalk,
    cta: 'Got it',
  },
  {
    id: 'resume-prefix',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Resume the search',
    body: 'The search is still paused mid-flight. Press ▶ Play to resume it.',
    // Hidden while either close-up is open so it can never cover one.
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  reviewResults('review-prefix'),
  {
    id: 'run-leading',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Now the expensive one: *search',
    body: 'Same shape, wildcard on the other end. “*search” matches “search” AND “elasticsearch” — two terms sitting in completely different parts of the sorted dictionary. Hit Search.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    onShow: (s, actions) => actions.setQuery('*search'),
    advanceOn: (s) => s.opQuery === '*search',
  },
  {
    id: 'magnify-leading',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Nothing to seek to',
    waitFor: (s) => s.opQuery === '*search' && s.opStep === 2,
    onShow: (s, actions) => actions.pause(),
    body: 'Click 🔍 again to see how a leading wildcard is handled in the shard.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    // The second descent, on the LEADING run: `*search` prunes exactly zero arcs
    // and reads every block, which is the structural version of this scenario's
    // whole thesis. It only lands because the reader watched arcs actually die
    // on the `sc*` run a few steps back — the two pictures are the contrast.
    // Mirrors the ondisk/fuzzy descent: one click per step, so getting down two
    // levels is two steps.
    id: 'dictionary-leading',
    target: '[data-anat-dict]',
    placement: 'bottom',
    // The zoom icon now sits by the segment id, a small target the tip's own
    // top-left corner would land on — nudge the tip clear so the 🔍 stays clickable.
    offset: { x: 40 },
    title: 'One level deeper — the real structure',
    waitFor: pastLookup,
    holdPanel: true,
    body: 'The flat table you just watched is a useful simplification. Click the 🔍 to see the pattern resolved against the real FST.',
    advanceOn: (s) => s.closeUpKind === 'dictionary',
  },
  {
    // Spotlighted, not a centered card: a card's backdrop would dim the picture
    // this step is asking the reader to look at. cta with no advanceOn ⇒ held,
    // so the walk waits rather than playing out behind the tip.
    id: 'read-the-no-prune',
    target: '[data-tour="fst"]',
    placement: 'right',
    title: 'No paths skipped',
    body: 'Watch the arrows as the walk runs. In a pattern that can be anchored, most of them die red at the root and everything behind them is skipped. Here every single arrow path has to be searched. A leading wildcard accepts ANY first character, so there is no path the machine is ever entitled to refuse. That is the performance cost of leading wildcards. Every block off the disk must be checked.',
    waitFor: atDictWalk,
    cta: 'Got it',
  },
  {
    id: 'resume-leading',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Resume the search',
    body: 'The search is still paused mid-flight. Press ▶ Play to resume it.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  reviewResults('review-leading'),
  {
    id: 'finish',
    target: null,
    title: 'That is the whole story',
    body: [
      'A prefix like “sc*” costs a seek plus the matching range. A leading wildcard costs the ENTIRE term dictionary — and that price is paid per segment, per shard, on every node the query touches.',
      'It is also why the usual fix is to index the data differently rather than query harder: a reverse field, an ngram/wildcard field, or a prefix you can actually seek to.',
      'The middle view models the seek as a binary search over a flat sorted array. The two zooms you took show what Lucene really does — an FST in memory picking blocks out of a file on disk, with the pattern compiled to an automaton rather than tested as a regex — and they are the same picture twice: arcs dying at the root for the pattern that can be anchored, not one arrow refused for the pattern that cannot.',
    ],
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    cta: 'Done',
  },
]

export default {
  id: 'wildcard',
  label: 'leading wildcards',
  blurb: 'See the difference between querying for the term “sc*” and “*search”.',
  steps: STEPS,
  setup: (actions) => actions.reset(),
}
