/**
 * The loader shown while the drafting side-call runs.
 *
 * This exists so the drafting call is cancellable: `BorderedLoader` owns an abort
 * signal, and the reference extension's pattern is to pass that signal into
 * `complete()` and resolve the overlay from `onAbort`. Keeping the wrapper here
 * lets DraftService stay signal-agnostic while the user keeps the ability to
 * abandon an expensive draft.
 */

import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Result of a loader-wrapped operation, distinguishing an abort from a value. */
export type LoaderOutcome<T> = { kind: "completed"; value: T } | { kind: "aborted" };

/**
 * Runs an operation behind a bordered loader, passing it the loader's signal.
 *
 * A rejection is converted to an abort rather than propagated, because a failure
 * inside the overlay would otherwise leave the TUI holding a component with no
 * resolution path. Callers see an ordinary aborted outcome and report it.
 */
export async function withLoader<T>(
	ctx: ExtensionContext,
	message: string,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<LoaderOutcome<T>> {
	return ctx.ui.custom<LoaderOutcome<T>>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, message);
		loader.onAbort = () => done({ kind: "aborted" });

		operation(loader.signal)
			.then((value) => done({ kind: "completed", value }))
			.catch(() => done({ kind: "aborted" }));

		return loader;
	});
}
