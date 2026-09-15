/**
 * Boundary for reading the current time.
 *
 * A worker run records when it started and shows how long it has been going, so
 * time is an input to persisted state and to a live widget rather than an
 * incidental detail. Injecting it keeps `Date.now()` out of the app layer, where
 * a direct call would make a run service test depend on wall-clock timing and
 * turn an elapsed-time assertion into a flake.
 *
 * Two readings are exposed because they serve different purposes. `nowIso`
 * produces the timestamp that goes into session entries, which must be stable
 * and human-readable. `nowMs` produces the millisecond reading used for elapsed
 * time, where only differences matter.
 */

/** Supplies both the persisted timestamp and the elapsed-time reading for a run. */
export interface Clock {
	/** ISO 8601 timestamp recorded as a run's `startedAt`. */
	nowIso(): string;
	/** Millisecond reading used only for elapsed-time differences. */
	nowMs(): number;
}
