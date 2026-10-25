// Maps pi session state to the JSON shape CCometixLine reads from stdin.
// Every helper here is pure so the mapping can be tested without a session.
// The upstream schema (src/input.rs, ccline 2.0.1) is entirely optional and
// lenient, so unknown values are omitted instead of guessed.

/** Thinking levels ccline renders in its effort segment. */
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

export interface PiSnapshotModel {
	id?: string | undefined;
	/** Human readable model name; ccline shows this as `display_name`. */
	name?: string | undefined;
	/** Provider id from pi ("anthropic", "openai-codex", ...). */
	provider?: string | undefined;
	contextWindow?: number | undefined;
}

export interface PiSnapshotContextUsage {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

export interface PiSnapshotTotals {
	/** Cumulative USD cost over the visible branch. */
	costUsd?: number | undefined;
	/** Wall-clock time since the first visible branch entry. */
	durationMs?: number | undefined;
}

export interface PiSnapshotSession {
	id?: string | undefined;
	name?: string | undefined;
}

export interface PiSnapshot {
	cwd: string;
	model?: PiSnapshotModel | undefined;
	thinkingLevel?: string | undefined;
	contextUsage?: PiSnapshotContextUsage | undefined;
	totals?: PiSnapshotTotals | undefined;
	session?: PiSnapshotSession | undefined;
}

/** The subset of pi's session entries this extension reads. */
export interface BranchEntryLike {
	type?: string | undefined;
	/** ISO timestamp written by pi when the entry was appended. */
	timestamp?: string | undefined;
	message?:
		| {
				role?: string | undefined;
				usage?:
					| {
							input?: number | undefined;
							output?: number | undefined;
							cacheRead?: number | undefined;
							cacheWrite?: number | undefined;
							cost?: { total?: number | undefined } | undefined;
					  }
					| undefined;
		  }
		| undefined;
}

/** The subset of `ExtensionContext` used to build a snapshot. */
export interface SnapshotContextLike {
	cwd: string;
	model?:
		| {
				id?: string | undefined;
				name?: string | undefined;
				provider?: string | undefined;
				contextWindow?: number | undefined;
		  }
		| undefined;
	thinkingLevel?: string | undefined;
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	sessionManager: {
		getBranch(): readonly BranchEntryLike[];
		getSessionId?(): string;
		getSessionName?(): string | undefined;
	};
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function trimmed(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

function attempt<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

/**
 * Collect the state pi exposes into a plain snapshot.
 * Values that cannot be read are left undefined so they are omitted downstream.
 */
export function collectSnapshot(ctx: SnapshotContextLike, nowMs: number): PiSnapshot {
	const usage = attempt(() => ctx.getContextUsage());
	const branch = attempt(() => ctx.sessionManager.getBranch()) ?? [];

	let costUsd = 0;
	let sawAssistantUsage = false;
	let firstTimestamp: number | undefined;

	for (const entry of branch) {
		const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
		if (Number.isFinite(timestamp) && (firstTimestamp === undefined || timestamp < firstTimestamp)) {
			firstTimestamp = timestamp;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const entryUsage = entry.message.usage;
		if (!entryUsage) continue;
		sawAssistantUsage = true;
		costUsd += num(entryUsage.cost?.total);
	}

	const totals: PiSnapshotTotals | undefined = sawAssistantUsage
		? {
				costUsd,
				durationMs: firstTimestamp === undefined ? undefined : Math.max(0, nowMs - firstTimestamp),
			}
		: undefined;

	const sessionId = attempt(() => ctx.sessionManager.getSessionId?.());
	const sessionName = attempt(() => ctx.sessionManager.getSessionName?.());

	return {
		cwd: ctx.cwd,
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		contextUsage: usage
			? {
					tokens: usage.tokens,
					contextWindow: finite(usage.contextWindow) ?? null,
					percent: usage.percent,
				}
			: undefined,
		totals,
		session: { id: trimmed(sessionId), name: trimmed(sessionName) },
	};
}

export interface BuildCclineInputOptions {
	/** Append the provider to the model segment: `Sonnet 4.5 (anthropic)`. */
	showProvider?: boolean | undefined;
}

/**
 * ccline 2.0.1 has no provider field: the only place a provider can surface is
 * the model segment, which renders `display_name` verbatim. So the provider is
 * appended there, and skipped when the name already carries it.
 */
export function withProvider(name: string, provider: string | undefined, enabled: boolean): string {
	if (!name || !provider || !enabled) return name;
	const suffix = `(${provider})`;
	return name.toLowerCase().endsWith(suffix.toLowerCase()) ? name : `${name} ${suffix}`;
}

/**
 * Build the ccline stdin payload.
 *
 * `version` is intentionally never set: ccline 2.0.1 parses it as the Claude
 * Code version and rejects anything older than 2.1.153.
 */
export function buildCclineInput(snapshot: PiSnapshot, options: BuildCclineInputOptions = {}): Record<string, unknown> {
	const input: Record<string, unknown> = {};

	const cwd = trimmed(snapshot.cwd);
	if (cwd) {
		input.cwd = cwd;
		input.workspace = { current_dir: cwd };
	}

	const modelId = trimmed(snapshot.model?.id);
	const modelName = trimmed(snapshot.model?.name);
	if (modelId || modelName) {
		const model: Record<string, string> = {};
		if (modelId) model.id = modelId;
		model.display_name = withProvider(modelName ?? modelId ?? "", trimmed(snapshot.model?.provider), options.showProvider !== false);
		input.model = model;
	}

	const level = trimmed(snapshot.thinkingLevel);
	if (level && EFFORT_LEVELS.has(level)) {
		input.effort = { level };
	}

	const usage = snapshot.contextUsage;
	const totals = snapshot.totals;
	const contextWindowSize = finite(usage?.contextWindow) ?? finite(snapshot.model?.contextWindow);
	// Only the live context goes into context_window: pi reports an aggregate
	// estimate, carried as input tokens. Cumulative session totals are not sent,
	// because ccline prefers them over current_usage and would then show a token
	// count that disagrees with used_percentage.
	const currentTokens = finite(usage?.tokens);
	const percent = finite(usage?.percent);

	if (contextWindowSize !== undefined || currentTokens !== undefined || percent !== undefined) {
		const contextWindow: Record<string, unknown> = {};
		if (contextWindowSize !== undefined) contextWindow.context_window_size = Math.round(contextWindowSize);
		if (currentTokens !== undefined) contextWindow.current_usage = { input_tokens: Math.round(currentTokens) };
		if (percent !== undefined) contextWindow.used_percentage = round1(percent);
		input.context_window = contextWindow;
	}

	const costUsd = finite(totals?.costUsd);
	const durationMs = finite(totals?.durationMs);
	if (costUsd !== undefined || durationMs !== undefined) {
		const cost: Record<string, unknown> = {};
		if (costUsd !== undefined) cost.total_cost_usd = costUsd;
		if (durationMs !== undefined) cost.total_duration_ms = Math.round(durationMs);
		input.cost = cost;
	}

	const sessionId = trimmed(snapshot.session?.id);
	if (sessionId) input.session_id = sessionId;
	const sessionName = trimmed(snapshot.session?.name);
	if (sessionName) input.session_name = sessionName;

	// rate_limits has no pi data source; omitting it removes the quota segment.
	return input;
}
