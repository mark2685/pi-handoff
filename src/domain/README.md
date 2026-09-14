The domain layer owns pure handoff rules and data. It has no IO and no Pi imports; dependencies point `domain <- app <- adapters <- index.ts`.
