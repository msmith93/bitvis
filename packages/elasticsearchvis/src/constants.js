// Demo-sized caps shared between the search model and the flight choreography.
// stepDuration reserves time for the largest flight a step will launch, so the
// model (ops) and the overlay (SearchFlight / the close-ups) must slice by the
// SAME numbers — that shared identity is why these live in one place.

// Gather phase: at most this many doc-id chips fly per shard.
export const MAX_GATHER_IDS = 6

// The query's default `size`. Elasticsearch sizes a shard's priority queue at
// exactly `from + size` and the coordinator returns that same window, so this is
// ONE number for both ends of query-then-fetch — not a shard cap and a separate
// fetch cap. It rides on the search op's payload (App.jsx's startSearch), which
// is where a real query carries it.
export const SEARCH_SIZE = 3
