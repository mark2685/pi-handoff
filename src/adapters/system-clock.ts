/**
 * System-clock implementation of the time boundary.
 *
 * This is the only place the handoff reads the real wall clock. It is trivial by
 * design: everything that could be got wrong about time — formatting, elapsed
 * arithmetic, what a run records — lives above the port where it can be tested
 * against a fake.
 */

import type { Clock } from "../ports/clock.ts";

/** Creates a clock backed by the host's real time. */
export function createSystemClock(): Clock {
	return {
		nowIso: () => new Date().toISOString(),
		nowMs: () => Date.now(),
	};
}
