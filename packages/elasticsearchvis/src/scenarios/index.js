import intro from './intro'
import wildcard from './wildcard'
import routing from './routing'
import ondisk from './ondisk'
import fuzzy from './fuzzy'
import nested from './nested'

// Guided scenarios. Each one is a self-contained module — like an op module in
// src/ops/ — declaring `{ id, label, blurb, steps, setup? }`. Adding a scenario
// = one new module plus an entry here. `useWalkthrough` runs whichever one is
// selected; the topbar's ScenarioPicker switches (or restarts) them.
//
// A step is:
//   { id, target?, targetExtra?, placement?, title, body, cta?, secondary?,
//     highlightPlay?, holdPanel?, noDim?, panelNext?, panelNextLabel?,
//     dataset?, waitFor?(snapshot), advanceOn?(snapshot),
//     onShow?(snapshot, actions) }
//
//   target        CSS selector of the real control to spotlight; null renders a
//                 centered card instead (welcome / finish).
//   targetExtra   CSS selector of a second element the spotlight hole must also
//                 cover when it is present. For controls that OPEN something —
//                 the Load docs menu — since the dim layer swallows clicks
//                 outside the hole and the menu would otherwise be unclickable.
//   waitFor       gates VISIBILITY only. While false the step is entered but
//                 renders nothing — that is how a scenario waits out an
//                 animation, or stays out of the way of an open close-up.
//   advanceOn     moves to the next step when the user's REAL action satisfies
//                 it. A step with neither advanceOn nor cta can never be left,
//                 so give every step one of the two.
//   onShow        fired once, when the step first becomes visible. May drive the
//                 app through `actions` — prefilling inputs, pausing — but never
//                 does the thing the step is asking for.
//   highlightPlay pulses the footer ▶ Play button while this step is showing
//                 (App reads it); pair it with target '[data-tour="stepper-play"]'.
//   holdPanel     freezes an open close-up's auto-play clock while this step is
//                 showing. A cta-only step already does that (it is asking to be
//                 READ); this is for a step that hands the replay to the reader
//                 and advances on their progress through it — without it the
//                 panel's clock races the person being asked to press Next. Pair
//                 it with `panelNext` (or targetExtra '[data-tour="cu-stepper"]'
//                 if the reader is to use the panel's own controls, since the
//                 dim layer swallows clicks outside the hole). Do NOT set it on
//                 a step that asks for ▶ Play: held makes Play inert.
//   noDim         spotlight WITHOUT darkening anything: the four dim rects go
//                 transparent and click-through. For a step narrating something
//                 the reader has to watch happen across the whole picture,
//                 where dimming the rest would hide half the lesson. The tip
//                 goes translucent to match. Because nothing is blocked any
//                 more, such a step needs an advanceOn that survives the reader
//                 wandering off (e.g. closing the close-up), or it strands.
//   panelNext     render a "next step" button IN the tip that advances the open
//                 close-up's replay by one unit (App owns the counter; CloseUp
//                 applies it to the active panel). `panelNextLabel` names it.
//                 Lets a step hand over the replay without the reader looking
//                 away from the tip to find the mini-stepper.
//   liveNarration render the open close-up's own account of what it is doing at
//                 THIS unit of its replay (ctx.narrate, folded out of the trace)
//                 under the step's static body. That is how a step can say why
//                 the walk went the way it did rather than describing the walk
//                 in general — keep the static body to framing, since this
//                 carries the explanation and changes on every press.
//   dataset       a DATASETS id this step wants loaded. While the step is
//                 showing, the Load docs menu pulses that entry and disables
//                 every other one, so a scripted load cannot pick the wrong set.
//                 The spotlight can't do this itself — its hole is a single
//                 rectangle and can't exclude an item in the middle of a menu.
//
// The snapshot both predicates read (built fresh by App on every render):
//   indexPhase  'closed' | 'editing' | 'flying' | 'done'
//   opType      active op's type, or null
//   opStep      active op's step index, or -1
//   opDone      active op has reached its last step
//   opQuery     active search's query string ('' when not a search)
//   opRouting   active search's routing key (null when unrouted)
//   playing     auto-play clock is running
//   zoomShard   id of the shard being inspected, or null (the close-up stack's
//               ROOT — unchanged by anything opened on top of it)
//   coordZoom   coordinator close-up is the stack root
//   closeUpKind kind of the INNERMOST open close-up, or null when none:
//               'shard' | 'coordinator' | 'dictionary'
//   closeUpDepth how many close-ups are stacked (0 = looking at the cluster)
//   closeUpStep  which step the INNERMOST close-up's own mini-stepper is on, or
//               -1 when none is open. This is how a step waits for a beat
//               INSIDE a panel — the fuzzy walk only reaches an accepting state
//               on the dictionary panel's last step, so the tip that points at
//               it has to know when the panel gets there.
//   closeUpLast  that panel's last step index (-1 when none is open)
//   closeUpSub   how far into the CURRENT step's own replay the reader has
//               scrubbed with the panel's Prev/Next — 0 on arriving, then one
//               per press. -1 when the stage's own clock owns the replay (or no
//               close-up is open), so a predicate wanting real manual progress
//               should test `closeUpSub >= n`.
//   closeUpUnits how many sub-units that step's replay has in total
//   sampleSet   which dataset is loaded: 'sample' | 'routed' | null
//   scenariosOpen the topbar Scenarios menu is open (the intro tour's last step
//               advances on it, to leave the user looking at the menu)
//
// The actions a step may drive: pause, reset, setQuery, setRouting.
//
// A note that has already cost two bugs: a step may only ever ask for ONE
// click. The dim layer swallows everything outside the spotlight hole, so a
// step whose copy says "do X and then Y" leaves Y unclickable unless both sit
// inside the same target (or are named by `targetExtra`).
export const SCENARIOS = [intro, wildcard, routing, ondisk, fuzzy, nested]

export const DEFAULT_SCENARIO = intro.id

export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id) || intro
