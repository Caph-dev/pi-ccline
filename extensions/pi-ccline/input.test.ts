import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCclineInput, collectSnapshot, type BranchEntryLike, type PiSnapshot, type SnapshotContextLike } from "./input.ts";

function snapshot(overrides: Partial<PiSnapshot> = {}): PiSnapshot {
	return {
		cwd: "/work/project",
		model: { id: "gpt-5.6-codex", name: "GPT-5.6 Codex", contextWindow: 272_000 },
		thinkingLevel: "high",
		contextUsage: { tokens: 42_000, contextWindow: 272_000, percent: 15.4 },
		totals: { costUsd: 1.2345, durationMs: 1_830_000 },
		session: { id: "sess-1", name: "demo" },
		...overrides,
	};
}

test("maps a full snapshot to the ccline schema", () => {
	assert.deepEqual(buildCclineInput(snapshot()), {
		cwd: "/work/project",
		workspace: { current_dir: "/work/project" },
		model: { id: "gpt-5.6-codex", display_name: "GPT-5.6 Codex" },
		effort: { level: "high" },
		context_window: {
			context_window_size: 272_000,
			current_usage: { input_tokens: 42_000 },
			used_percentage: 15.4,
		},
		cost: { total_cost_usd: 1.2345, total_duration_ms: 1_830_000 },
		session_id: "sess-1",
		session_name: "demo",
	});
});

test("never sends version, which ccline 2.0.1 rejects, and never sends rate_limits", () => {
	const input = buildCclineInput(snapshot());
	assert.equal("version" in input, false);
	assert.equal("rate_limits" in input, false);
});

test("omits model and effort when pi has none", () => {
	const input = buildCclineInput(snapshot({ model: undefined, thinkingLevel: undefined }));
	assert.equal("model" in input, false);
	assert.equal("effort" in input, false);
	// Context usage still carries its own window size without a model.
	const contextWindow = input.context_window as Record<string, unknown>;
	assert.equal(contextWindow.context_window_size, 272_000);
	// cwd and session data do not depend on the model.
	assert.deepEqual(input.workspace, { current_dir: "/work/project" });
	assert.equal(input.session_id, "sess-1");
});

test("ignores an unknown thinking level instead of guessing", () => {
	const input = buildCclineInput(snapshot({ thinkingLevel: "off" }));
	assert.equal("effort" in input, false);
});

test("omits cost when no assistant usage was recorded", () => {
	const input = buildCclineInput(snapshot({ totals: undefined }));
	assert.equal("cost" in input, false);
	assert.equal("context_window" in input, true);
	const contextWindow = input.context_window as Record<string, unknown>;
	assert.equal(contextWindow.used_percentage, 15.4);
});

test("sends only the live context, never cumulative token totals", () => {
	// ccline prefers total_input_tokens over current_usage, which would show a
	// token count that disagrees with used_percentage.
	const contextWindow = buildCclineInput(snapshot()).context_window as Record<string, unknown>;
	assert.equal("total_input_tokens" in contextWindow, false);
	assert.equal("total_output_tokens" in contextWindow, false);
	assert.deepEqual(contextWindow.current_usage, { input_tokens: 42_000 });
});

test("keeps a partial context window when usage is unknown", () => {
	const input = buildCclineInput(snapshot({ contextUsage: { tokens: null, contextWindow: 272_000, percent: null } }));
	const contextWindow = input.context_window as Record<string, unknown>;
	assert.equal(contextWindow.context_window_size, 272_000);
	assert.equal("current_usage" in contextWindow, false);
	assert.equal("used_percentage" in contextWindow, false);
});

test("falls back to the model context window and drops the session when unset", () => {
	const input = buildCclineInput(snapshot({ contextUsage: undefined, session: {} }));
	const contextWindow = input.context_window as Record<string, unknown>;
	assert.equal(contextWindow.context_window_size, 272_000);
	assert.equal("session_id" in input, false);
	assert.equal("session_name" in input, false);
});

test("uses the model id as display_name when no name is available", () => {
	const input = buildCclineInput(snapshot({ model: { id: "some-model" } }));
	assert.deepEqual(input.model, { id: "some-model", display_name: "some-model" });
});

test("appends the provider to the model name", () => {
	const input = buildCclineInput(snapshot({ model: { id: "claude-sonnet-4-5", name: "Sonnet 4.5", provider: "anthropic" } }));
	assert.deepEqual(input.model, { id: "claude-sonnet-4-5", display_name: "Sonnet 4.5 (anthropic)" });
});

test("appends the provider to an id-only model and skips a duplicate suffix", () => {
	const idOnly = buildCclineInput(snapshot({ model: { id: "gpt-5.1", provider: "openai-codex" } }));
	assert.deepEqual(idOnly.model, { id: "gpt-5.1", display_name: "gpt-5.1 (openai-codex)" });

	const already = buildCclineInput(snapshot({ model: { id: "m", name: "Sonnet 4.5 (anthropic)", provider: "anthropic" } }));
	assert.deepEqual(already.model, { id: "m", display_name: "Sonnet 4.5 (anthropic)" });
});

test("showProvider false or an unknown provider keeps the bare name", () => {
	const model = { id: "m", name: "Sonnet 4.5", provider: "anthropic" };
	assert.deepEqual(buildCclineInput(snapshot({ model }), { showProvider: false }).model, {
		id: "m",
		display_name: "Sonnet 4.5",
	});
	assert.deepEqual(buildCclineInput(snapshot({ model: { id: "m", name: "Sonnet 4.5", provider: "  " } })).model, {
		id: "m",
		display_name: "Sonnet 4.5",
	});
});

test("omits blank strings instead of sending empty values", () => {
	const input = buildCclineInput(snapshot({ cwd: "  ", session: { id: " ", name: "" } }));
	assert.equal("cwd" in input, false);
	assert.equal("workspace" in input, false);
	assert.equal("session_id" in input, false);
});

function entry(partial: BranchEntityInput): BranchEntryLike {
	return partial as BranchEntryLike;
}

type BranchEntityInput = {
	type?: string;
	timestamp?: string;
	message?: { role?: string; usage?: Record<string, unknown> };
};

function fakeContext(branch: BranchEntryLike[], overrides: Partial<SnapshotContextLike> = {}): SnapshotContextLike {
	return {
		cwd: "/work/project",
		model: { id: "m", name: "M", contextWindow: 200_000 },
		thinkingLevel: "low",
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "sess-9",
			getSessionName: () => "named",
		},
		...overrides,
	};
}

test("collectSnapshot sums only assistant usage on the branch", () => {
	const branch: BranchEntryLike[] = [
		entry({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } }),
		entry({
			type: "message",
			timestamp: "2026-01-01T00:00:10.000Z",
			message: {
				role: "assistant",
				usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: { total: 0.5 } },
			},
		}),
		entry({
			type: "message",
			timestamp: "2026-01-01T00:00:20.000Z",
			message: {
				role: "assistant",
				usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
			},
		}),
		entry({ type: "custom", timestamp: "2026-01-01T00:00:30.000Z" }),
	];

	const snapshotValue = collectSnapshot(fakeContext(branch), Date.parse("2026-01-01T00:10:00.000Z"));
	assert.deepEqual(snapshotValue.totals, {
		costUsd: 0.75,
		durationMs: 600_000,
	});
	assert.equal(snapshotValue.session?.id, "sess-9");
	assert.equal(snapshotValue.session?.name, "named");
	assert.equal(snapshotValue.contextUsage?.tokens, 1000);
});

test("collectSnapshot reports no totals for an empty branch", () => {
	const snapshotValue = collectSnapshot(fakeContext([]), Date.now());
	assert.equal(snapshotValue.totals, undefined);
	assert.equal(snapshotValue.session?.name, "named");
});

test("collectSnapshot carries the provider from ctx.model", () => {
	const ctx = fakeContext([], { model: { id: "m", name: "M", provider: "anthropic", contextWindow: 200_000 } });
	const snapshotValue = collectSnapshot(ctx, Date.now());
	assert.equal(snapshotValue.model?.provider, "anthropic");
	assert.equal((buildCclineInput(snapshotValue).model as Record<string, string>).display_name, "M (anthropic)");
});

test("collectSnapshot survives throwing context accessors", () => {
	const ctx = fakeContext([], {
		getContextUsage: () => {
			throw new Error("boom");
		},
	});
	const snapshotValue = collectSnapshot(ctx, Date.now());
	assert.equal(snapshotValue.contextUsage, undefined);
	assert.equal(buildCclineInput(snapshotValue).context_window !== undefined, true);
});
