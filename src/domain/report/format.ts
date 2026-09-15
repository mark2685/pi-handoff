/**
 * Pure formatting for worker metrics.
 *
 * The running widget and Gate B both show the same usage figures, so formatting
 * them once here keeps a token count from being rendered two different ways in
 * two places. These live in the domain because they are pure text transforms
 * with no IO, which also makes the awkward cases testable: a provider that omits
 * cost, and a context size that must not be summed.
 *
 * `UsageTotals` restates the fields of the worker port's `WorkerUsage` rather
 * than importing it. Domain code must not depend on a port, and the structural
 * match means callers can pass a `WorkerUsage` directly.
 */

/** The subset of worker usage these formatters read, declared without a port dependency. */
export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	/** The latest reported context size, never a sum across turns. */
	contextTokens: number;
	turns: number;
}

/** Groups digits with commas without depending on the host locale. */
export function formatTokenCount(value: number): string {
	return Math.round(value)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats a cost, or reports that the provider did not supply one.
 *
 * A zero cost is treated as absent because Bifrost-style proxies omit cost
 * entirely, and rendering "$0.0000" for an unknown cost would misreport a real
 * expense as free.
 */
export function formatCost(cost: number): string {
	return cost > 0 ? `$${cost.toFixed(4)}` : "not reported";
}

/** Formats a millisecond duration as a compact, human-scannable elapsed time. */
export function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);

	if (hours > 0) {
		return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
	}
	if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	return `${seconds}s`;
}

/** Formats the one-line token summary shared by the widget and Gate B. */
export function formatTokenSummary(usage: UsageTotals): string {
	const parts = [`in ${formatTokenCount(usage.inputTokens)}`, `out ${formatTokenCount(usage.outputTokens)}`];
	if (usage.cacheReadTokens > 0) parts.push(`cache read ${formatTokenCount(usage.cacheReadTokens)}`);
	if (usage.cacheWriteTokens > 0) parts.push(`cache write ${formatTokenCount(usage.cacheWriteTokens)}`);
	return parts.join(", ");
}

/** Builds the labelled usage block shown at Gate B. */
export function formatUsageLines(usage: UsageTotals): string[] {
	return [
		`Turns:     ${usage.turns}`,
		`Tokens:    ${formatTokenSummary(usage)}`,
		`Context:   ${formatTokenCount(usage.contextTokens)}`,
		`Cost:      ${formatCost(usage.cost)}`,
	];
}
