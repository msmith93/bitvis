// "How does a typo still find the document?"
//
// The other scenarios in this app teach a cost. This one teaches a MECHANISM,
// and the cost falls out of it — so its centre of gravity is the deepest zoom,
// not the cluster view. The thing worth seeing is the term index and an
// edit-distance machine walked at the same time, one character at a time, with
// the automaton in several states at once because it does not yet know which
// reading of the word will turn out to be the cheap one — and then a branch
// dying because no reading survived.
//
// This scenario used to run the query twice with `prefix_length` moved, because
// the old fourteen-document dataset produced dictionaries too small and too
// repetitive to prune at all: `serch~` rejected NOTHING on shard 0 and read
// 100% of it, so the one animation worth watching never fired. The dataset now
// carries ~90-105 terms per shard and the same query prunes 11-17 arcs at
// Elasticsearch's default settings, so the knob — and the three steps it cost —
// are gone. See presets.js for the rules that keep it that way.
//
// Every step spotlights ONE control. The tour's dim layer swallows clicks
// outside its hole, so a step that asks for two clicks in two places leaves the
// second one unclickable; that is why descending two zoom levels is two steps.
const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'How does a typo still find the document?',
    body: [
      'Search for “serch” and an exact lookup finds nothing at all. The dictionary is sorted, the word simply is not in it, and being one letter away counts for exactly nothing.',
      'A fuzzy query asks a different question — not “where is this term” but “which terms are within N edits of it”. That question has a beautiful answer: compile it into a small machine, and walk that machine against the term index in lockstep.',
      'You are going to watch those two things move together, character by character, and see the moment a whole branch of the dictionary dies.',
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
    body: 'Open “Load docs” and pick “Sample docs”. The dictionary needs enough distinct words in it that skipping some of them is worth doing.',
    advanceOn: (s) => s.sampleSet === 'sample',
  },
  {
    id: 'merge',
    target: '[data-tour="merge"]',
    placement: 'right',
    title: 'Merge, so each shard has one dictionary',
    body: 'Click Merge. Each shard’s segments become a single bigger one — one term index per shard instead of three, which is a great deal easier to watch a walk through.',
    // Merge is disabled while another op's clock runs, and the sample set
    // tombstones a doc so Refresh is live too. Wait for an idle timeline.
    waitFor: (s) => !s.playing,
    advanceOn: (s) => s.opType === 'merge',
  },
  {
    id: 'run',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Search for a word that isn’t there',
    body: 'We have put “serch~” in the box. A bare ~ is Fuzziness.AUTO, and at five characters that means one edit — so this asks for every term within one edit of “serch”. Hit Search.',
    waitFor: (s) => (s.opType !== 'merge' || s.opDone) && !s.playing,
    onShow: (s, actions) => {
      actions.setRouting('')
      actions.setQuery('serch~')
    },
    advanceOn: (s) => s.opQuery === 'serch~',
  },
  {
    id: 'magnify',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Into a shard',
    waitFor: (s) => s.opQuery === 'serch~' && s.opStep === 2,
    onShow: (s, actions) => actions.pause(),
    body: 'Every serving shard is resolving that pattern against its segments right now. Click the highlighted 🔍 to look inside one of them.',
    advanceOn: (s) => s.closeUpKind === 'shard' || (s.opDone && !s.playing),
  },
  {
    id: 'dictionary',
    target: '[data-anat-dict]',
    placement: 'bottom',
    title: 'And one level deeper — this is the one',
    waitFor: (s) => s.closeUpKind === 'shard',
    body: 'Click the 🔍 on a segment’s “term dictionary” column. Two structures come up side by side, and both live in memory: the term index on the left, and “within one edit of serch” compiled into states on the right.',
    advanceOn: (s) => s.closeUpKind === 'dictionary',
  },
  {
    // Spotlighted rather than a centered card, because a card's backdrop would
    // cover the one thing the step is asking the reader to look at.
    id: 'read-the-grid',
    target: '[data-tour="automaton"]',
    placement: 'left',
    title: 'What the grid is telling you',
    body: 'Every state is (characters matched, edits spent). Going right is a character that was right and cost nothing; going down is an edit spent to accept a wrong, extra or missing one. When the walk runs, several will be lit at once — the machine cannot yet tell which reading of the word will pay off, so it keeps them all and lets the next character settle it. The panel is holding while you read this.',
    waitFor: (s) => s.closeUpKind === 'dictionary',
    cta: 'Got it',
  },
  {
    // The payoff, and the reason this scenario exists. Spotlighted on the index
    // panel for the same reason the step before is spotlighted on the automaton:
    // a centered card's backdrop dims the picture it is talking about.
    id: 'the-prune',
    target: '[data-tour="fst"]',
    placement: 'right',
    title: 'And what to watch for over here',
    body: 'Dismiss this and the two panels will walk in lockstep. Most arrows will light green, but some will turn RED and grey out everything behind them — prefixes the machine refused, with every term underneath skipped unread. That is a stronger claim than “it did not match”: given this prefix there is NO continuation it could still accept inside its budget, so the index never has to look. Watch where it does NOT happen, too — at the root, where the edit is unspent and any first character is acceptable. That is why a fuzzy still reads a good half of the dictionary.',
    waitFor: (s) => s.closeUpKind === 'dictionary',
    cta: 'Got it',
  },
  {
    // The search is still paused mid-walk from the magnify step, and
    // `canStartNew` in useOpLifecycle refuses to begin a new op until the
    // current one reaches its last step — so the Search button the next step
    // asks for stays DISABLED until this one runs out. waitFor keeps this
    // hidden until the close-ups are gone; CloseUp already pulses the root ✕
    // while a tour is running, so getting out of them is that button's job.
    id: 'resume',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Back at the cluster — let that search finish',
    body: 'Press ▶ Play to let the paused search run to the end. From the expansion onwards a fuzzy query is an ordinary boolean OR over the matched terms — the same scatter-gather you already know — and a new query cannot start until this one has finished.',
    waitFor: (s) => s.closeUpDepth === 0,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'false-positive',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Now the other kind of cost',
    body: 'We have put in “store~1”. Hit Search, then read what it expanded to — on the shard panel, or in the line under “What’s happening”.',
    waitFor: (s) => s.closeUpDepth === 0 && !s.playing,
    onShow: (s, actions) => actions.setQuery('store~1'),
    advanceOn: (s) => s.opQuery === 'store~1',
  },
  {
    id: 'read-expansion',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: '“score” is one edit from “store”',
    waitFor: (s) => s.opQuery === 'store~1' && s.opStep >= 2,
    onShow: (s, actions) => actions.pause(),
    body: 'Among the terms it matched is “score”, which has nothing whatever to do with what you asked for — it is simply one character away. The automaton compared spelling. It has no way to tell a typo from a different word, and documents about scoring are now in your results.',
    cta: 'Got it',
  },
  {
    id: 'finish',
    target: null,
    title: 'Using it without regretting it',
    body: [
      'Fuzziness.AUTO is the sane default: no edits below 3 characters, one up to 5, two beyond. A fixed ~2 on a short word matches almost everything in the dictionary — and the contrast table showed what that second edit costs in states, in arcs that can no longer be rejected, and in blocks that have to leave the disk.',
      'The pruning you watched is what keeps this affordable at all, and it only begins once the budget has been spent. Worth remembering the next time a fuzzy query is slow: the fix is usually to ask for less slack, not for more hardware.',
      'And remember what the machine you just watched cannot do. It is not stemming and not a synonym list: “search~2” finds “searched” by an accident of spelling, not because it knows the two are related — which is exactly why it also finds “score” when you wanted “store”.',
    ],
    waitFor: (s) => s.closeUpDepth === 0,
    cta: 'Done',
  },
]

export default {
  id: 'fuzzy',
  label: 'How a typo still finds the document',
  blurb: 'Watch a Levenshtein automaton and the term index get walked in lockstep.',
  steps: STEPS,
  setup: (actions) => actions.reset(),
}
