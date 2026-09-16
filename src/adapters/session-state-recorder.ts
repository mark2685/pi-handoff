/**
 * Session-entry implementation of handoff state persistence.
 *
 * Recording is best-effort on purpose. The entry exists so a resumed session can
 * recover an in-flight handoff, but a session that cannot accept the entry must
 * not break the gate the user is currently looking at, so a failure is reported
 * through `onError` rather than thrown into the caller's control flow.
 *
 * This uses `pi.appendEntry` rather than a session-manager call: the extension
 * context exposes `ReadonlySessionManager`, which has no append capability, so
 * writing entries is an `ExtensionAPI` concern bound once at registration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HANDOFF_STATE_ENTRY_TYPE, serializeHandoffState, type HandoffState } from "../app/handoff-machine.ts";
import {
	HANDOFF_REPORT_ENTRY_TYPE,
	type HandoffReportEntry,
	type HandoffReportRecorder,
	type HandoffStateRecorder,
} from "../app/state-recorder.ts";

export interface SessionHandoffStateRecorderOptions {
	/** Receives a diagnostic when an entry cannot be appended; defaults to silence. */
	onError?: (detail: string) => void;
}

/**
 * Creates a recorder that appends serialized handoff state as a custom session entry.
 *
 * `serializeHandoffState` retains optional review captures, while the persistence
 * schema remains backward-compatible with entries from before capture existed.
 */
export function createSessionHandoffStateRecorder(
	pi: ExtensionAPI,
	options: SessionHandoffStateRecorderOptions = {},
): HandoffStateRecorder {
	return {
		record(state: HandoffState): void {
			try {
				pi.appendEntry(HANDOFF_STATE_ENTRY_TYPE, serializeHandoffState(state));
			} catch (error) {
				options.onError?.(error instanceof Error ? error.message : String(error));
			}
		},
	};
}

/**
 * Creates a recorder that appends an accepted worker report to the session.
 *
 * This is what makes Accept more than a state reset: the report the user approved
 * becomes part of the session transcript, so a later turn can refer to it without
 * the worker's output having entered the reviewing context as tool noise.
 */
export function createSessionHandoffReportRecorder(
	pi: ExtensionAPI,
	options: SessionHandoffStateRecorderOptions = {},
): HandoffReportRecorder {
	return {
		record(entry: HandoffReportEntry): void {
			try {
				pi.appendEntry(HANDOFF_REPORT_ENTRY_TYPE, entry);
			} catch (error) {
				options.onError?.(error instanceof Error ? error.message : String(error));
			}
		},
	};
}
