// Demo-sized caps shared between the search model and the flight choreography.
// stepDuration reserves time for the largest flight a step will launch, so the
// model (ops) and the overlay (SearchFlight / ShardInspector) must slice by the
// SAME numbers — that shared identity is why these live in one place.

// Gather phase: at most this many doc-id chips fly per shard.
export const MAX_GATHER_IDS = 6

// Fetch phase: full _source flies only for the top winners of the merged ranking.
export const MAX_FETCH_WINNERS = 5

// Shard-local priority-queue size in the close-up (real Lucene default is 10).
export const LOCAL_TOPK = 3
