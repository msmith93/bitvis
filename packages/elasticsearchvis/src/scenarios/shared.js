// Step fragments shared across scenario modules.
//
// `reviewResults` is inserted right after every step whose advanceOn is "let
// the search finish" (`s.opType === 'search' && s.opDone && !s.playing`). The
// results dialog (SearchResultsOverlay) auto-opens the instant a search op
// reaches that same state, covering the screen — so whatever the scenario was
// about to point at next is unreachable until the reader closes it. One shared
// step covers every one of those spots rather than repeating it per scenario.
export const reviewResults = (id) => ({
  id,
  target: '[data-tour="results-card"]',
  placement: 'right',
  title: 'The response, in full',
  body: 'This is the JSON the client actually receives — hit ids and scores with the shard each came from, plus every matched document’s indexed fields.',
  waitFor: (s) => s.resultsOpen,
  advanceOn: (s) => !s.resultsOpen,
})
