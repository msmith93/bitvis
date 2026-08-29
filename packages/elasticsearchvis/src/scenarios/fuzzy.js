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
import { reviewResults } from './shared'

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
    body: 'In a moment you will drive these two panels yourself, one decision at a time. Most arrows will light green, but some will turn RED and grey out everything behind them — prefixes the machine refused, with every term underneath skipped unread. That is a stronger claim than “it did not match”: given this prefix there is NO continuation it could still accept inside its budget, so the index never has to look. Watch where it does NOT happen, too — at the root, where the edit is unspent and any first character is acceptable. That is why a fuzzy still reads a good half of the dictionary.',
    waitFor: (s) => s.closeUpKind === 'dictionary',
    cta: 'Got it',
  },
  {
    // The heart of the scenario, and the thing it was missing: the reader
    // DRIVES the intersection instead of watching it go past at 260ms a
    // decision. `holdPanel` freezes the panel's auto-play clock (App turns it
    // into `held`), so nothing moves until they press Next — and because the
    // panel is parked on its first step, the first press lands them on the walk
    // step at sub 0, where every further press is exactly one arc decision.
    //
    // `noDim` + `panelNext` are the whole point of these three: the reader is
    // being asked to WATCH two structures move together, so nothing may be
    // darkened, and the button that moves them lives in the tip itself rather
    // than making them look away to find the panel's mini-stepper.
    //
    // Each carries an escape for a reader who leaves the panel — with the dim
    // layer click-through, closing it is now one stray click away, and a step
    // whose waitFor can no longer come true would strand the tour.
    id: 'walk-it-yourself',
    target: '[data-tour="automaton"]',
    // 'right' puts the tip in the empty margin beside the close-up. 'left' would
    // land it squarely on the FST panel — the other half of the picture the
    // step is asking the reader to watch.
    placement: 'right',
    noDim: true,
    panelNext: true,
    panelNextLabel: 'Take one step ›',
    liveNarration: true,
    title: 'Now walk it yourself',
    body: 'Nothing moves until you move it. Each press advances the intersection one step — one arrow of the term index, and the same character fed to the machine. The note below says what just happened and why.',
    waitFor: (s) => s.closeUpKind === 'dictionary',
    // Panel steps are index:0, walk:1, read:2, found:3. Three decisions is
    // enough for every shard to have shown at least one prune (the first falls
    // at decision 1 or 2 depending on the shard) — npm run check asserts it.
    advanceOn: (s) =>
      s.closeUpKind !== 'dictionary' ||
      s.closeUpStep > 1 ||
      (s.closeUpStep === 1 && s.closeUpSub >= 3),
    holdPanel: true,
  },
  {
    id: 'watch-one-die',
    target: '[data-tour="automaton"]',
    // 'right' puts the tip in the empty margin beside the close-up. 'left' would
    // land it squarely on the FST panel — the other half of the picture the
    // step is asking the reader to watch.
    placement: 'right',
    noDim: true,
    panelNext: true,
    panelNextLabel: 'Take one step ›',
    liveNarration: true,
    title: 'Keep going — and watch one die',
    body: 'Keep stepping until an arrow turns RED and the grid empties to ∅. The note below will tell you exactly which readings were left and what each of them was waiting for.',
    waitFor: (s) => s.closeUpKind === 'dictionary',
    // Six decisions puts at least two prunes on screen on every shard.
    advanceOn: (s) =>
      s.closeUpKind !== 'dictionary' ||
      s.closeUpStep > 1 ||
      (s.closeUpStep === 1 && s.closeUpSub >= 6),
    holdPanel: true,
  },
  {
    // Deliberately NOT holdPanel: this step offers the clock back, and `held`
    // would make the panel's ▶ Play a dead button. Manual stepping already
    // cleared `playing`, so nothing runs until the reader asks it to.
    id: 'let-it-finish',
    target: '[data-tour="automaton"]',
    // 'right' puts the tip in the empty margin beside the close-up. 'left' would
    // land it squarely on the FST panel — the other half of the picture the
    // step is asking the reader to watch.
    placement: 'right',
    noDim: true,
    panelNext: true,
    panelNextLabel: 'Take one step ›',
    liveNarration: true,
    title: 'Let the rest of it run',
    body: 'Same move, thirty-odd more times, and then the blocks that survived get read. Keep stepping to read the running commentary, or press ▶ Play in the panel to let it finish on its own.',
    waitFor: (s) => s.closeUpKind === 'dictionary',
    advanceOn: (s) => s.closeUpKind !== 'dictionary' || s.closeUpStep >= s.closeUpLast,
  },
  {
    // THE payoff, and the step this scenario was missing. The arc walk consumes
    // block PREFIXES — one to three characters — so the grid can never reach its
    // right-hand column while it runs: it tops out around "3 of 5 matched" and
    // looks stuck, which is exactly what a reader reports as "it never gets
    // to (5,1)". The word is finished on the panel's LAST step, when the block
    // is read and its terms are completed one at a time, and that is the only
    // view that lands on an accepting state.
    //
    // Waits for the panel's own stepper to arrive there (closeUpStep), because
    // pointing at the grid before the spell-out starts describes an empty
    // right-hand column. Deliberately NOT held: App computes `held` as
    // `cta && !advanceOn`, and the panel has already parked itself (its clock
    // stops at the last step) while the spell-out reveal is gated on `active`
    // rather than the clock — so the word finishes under the tip, which is the
    // thing being pointed at. The advanceOn is the escape hatch for a reader
    // who closes the panel instead.
    id: 'the-payoff',
    target: '[data-tour="automaton"]',
    // Beside the close-up rather than on top of the FST panel — the grid is the
    // subject here, but the index is still worth seeing next to it. Undimmed and
    // narrated like the stepping tips before it: this is the last beat of the
    // same walk, not a separate lesson.
    placement: 'right',
    noDim: true,
    liveNarration: true,
    title: 'Watch it finish the word',
    body: 'The walk above only ever ate block PREFIXES — a character or three — which is why the grid never got near its right-hand edge and looked stuck partway across. The rest of the word is spelled out now, here on the last step, as the block is read and its terms are completed one at a time. Follow the lit states rightwards: “search” lands on an ACCEPTING state, five characters matched for one edit spent, and that is where the verdict actually comes from.',
    waitFor: (s) => s.closeUpKind === 'dictionary' && s.closeUpStep >= s.closeUpLast,
    advanceOn: (s) => s.closeUpDepth === 0,
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
  reviewResults('review-fuzzy'),
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
      'Fuzziness.AUTO is the sane default: no edits below 3 characters, one up to 5, two beyond. A fixed ~2 on a short word matches almost everything in the dictionary — and you watched what that second edit costs: more states in the machine, arcs the walk can no longer reject, and blocks that have to leave the disk.',
      'The pruning you watched is what keeps this affordable at all, and it only begins once the budget has been spent. Worth remembering the next time a fuzzy query is slow: the fix is usually to ask for less slack, not for more hardware.',
      'And remember what the machine you just watched cannot do. It is not stemming and not a synonym list: “search~2” finds “searched” by an accident of spelling, not because it knows the two are related — which is exactly why it also finds “score” when you wanted “store”.',
    ],
    waitFor: (s) => s.closeUpDepth === 0,
    cta: 'Done',
  },
]

export default {
  id: 'fuzzy',
  label: 'fuzzy search',
  blurb: 'Watch a Levenshtein automaton and the term index get walked in lockstep.',
  steps: STEPS,
  setup: (actions) => actions.reset(),
}
