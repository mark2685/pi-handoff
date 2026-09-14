The persistence layer will validate and serialize handoff state at storage boundaries. It follows `domain <- app <- adapters <- index.ts` and does not construct concrete adapters.
