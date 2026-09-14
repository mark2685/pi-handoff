/**
 * A minimal Result type for Pi Handoff.
 *
 * Used so domain and persistence code can report expected failures, such as a
 * rejected handoff configuration, as values rather than exceptions. Exceptions
 * stay reserved for genuine bugs.
 */

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}
