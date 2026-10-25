import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { clearBinaryCache } from "./binary.ts";
import { DEFAULT_CONFIG, type PiCclineConfig } from "./config.ts";
import { CclineFooter, default as piCcline } from "./index.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every temp directory made below is removed even when an assertion fails. */
const createdDirs: string[] = [];
/** Footers created by attach(); disposed after each test so no interval survives a failure. */
const createdFooters: { dispose(): void }[] = [];
afterEach(() => {
	for (const footer of createdFooters.splice(0)) footer.dispose();
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}

/** Poll instead of sleeping a fixed amount; the machine may be busy. */
async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(25);
	}
	throw new Error("timed out waiting for condition");
}

/** Spawn counter kept in a file by the fake binaries; 0 while the file is unwritten. */
function countSpawns(path: string): number {
	try {
		return Number(readFileSync(path, "utf8")) || 0;
	} catch {
		return 0;
	}
}

function fakeBinary(script: string): string {
	const path = join(tempDir("pi-ccline-footer-"), "fake-ccline");
	writeFileSync(path, `#!/bin/sh\n${script}\n`, "utf8");
	chmodSync(path, 0o755);
	return path;
}

function fakeContext(): ExtensionContext {
	return {
		cwd: "/work/project",
		mode: "tui",
		hasUI: true,
		model: { id: "test-model", name: "Test Model", contextWindow: 100_000 },
		thinkingLevel: "high",
		getContextUsage: () => ({ tokens: 5000, contextWindow: 100_000, percent: 5 }),
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					timestamp: new Date().toISOString(),
					message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
				},
			],
			getSessionId: () => "sess-1",
			getSessionName: () => "footer test",
		},
	} as unknown as ExtensionContext;
}

interface Harness {
	footer: CclineFooter;
	renders: () => number;
	render: (width: number) => string[];
}

function attach(
	config: Partial<PiCclineConfig>,
	footer = new CclineFooter(fakeContext(), { ...DEFAULT_CONFIG, ...config }),
	statuses = new Map<string, string>(),
): Harness {
	clearBinaryCache();
	createdFooters.push(footer);
	let renders = 0;
	const component = footer.attach(
		{ requestRender: () => { renders += 1; } },
		{ fg: (_color: string, text: string) => `\u001b[2m${text}\u001b[0m` },
		{ onBranchChange: () => () => {}, getExtensionStatuses: () => statuses },
	);
	return { footer, renders: () => renders, render: (width) => component.render(width) };
}

test("renders a loading notice before the first frame arrives", () => {
	const binary = fakeBinary("cat > /dev/null; printf 'FAKE-CCLINE\\n'");
	const harness = attach({ binary });
	const first = harness.render(80);
	assert.equal(first.length, 1);
	assert.match(first[0] ?? "", /ccline/);
	assert.equal(harness.footer.hasFrame, false, "render() must not run the binary inline");
	harness.footer.dispose();
});

test("shows the ccline output once the deferred refresh completes", async () => {
	const binary = fakeBinary("cat > /dev/null; printf '\\033[32mFAKE-CCLINE\\033[0m\\n'");
	const harness = attach({ binary });
	harness.render(80);
	await waitFor(() => harness.footer.hasFrame);
	const lines = harness.render(80);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /FAKE-CCLINE/);
	assert.equal(harness.footer.hasFrame, true);
	assert.ok(harness.renders() > 0, "the footer asked for a repaint");
	harness.footer.dispose();
});

test("refreshes for the width the footer was rendered at", async () => {
	const binary = fakeBinary('cat > /dev/null; printf "w=%s\\n" "$COLUMNS"');
	const harness = attach({ binary });
	harness.render(60);
	await waitFor(() => harness.footer.hasFrame);
	assert.match(harness.render(60)[0] ?? "", /w=60/);

	// A width change is picked up by the throttled scheduler, not by render().
	harness.render(100);
	await waitFor(() => /w=100/.test(harness.render(100)[0] ?? ""));
	harness.footer.dispose();
});

test("keeps the last frame and marks it stale when a refresh fails", async () => {
	const directory = tempDir("pi-ccline-flaky-");
	const counter = join(directory, "count");
	const binary = fakeBinary(
		[
			"cat > /dev/null",
			`n=0; [ -f "${counter}" ] && n=$(cat "${counter}")`,
			"n=$((n+1))",
			`printf '%s' "$n" > "${counter}"`,
			`if [ "$n" -eq 1 ]; then printf 'GOOD\\n'; exit 0; fi`,
			"printf 'nope\\n' >&2",
			"exit 7",
		].join("\n"),
	);

	const harness = attach({ binary });
	harness.render(40);
	await waitFor(() => /GOOD/.test(harness.render(40)[0] ?? ""));

	harness.footer.requestRefresh();
	await waitFor(() => /stale/.test(harness.render(40)[0] ?? ""));
	const lines = harness.render(40);
	assert.match(lines[0] ?? "", /GOOD/, "the last good frame is kept");
	assert.match(lines[0] ?? "", /stale/);
	assert.match(harness.footer.error ?? "", /code 7/);
	harness.footer.dispose();
});

test("shows a failure notice instead of a blank footer when ccline always fails", async () => {
	const binary = fakeBinary("cat > /dev/null; printf 'broken\n' >&2; exit 9");
	const harness = attach({ binary });
	harness.render(60);
	await waitFor(() => harness.footer.hasFrame);
	const lines = harness.render(60);
	assert.match(lines[0] ?? "", /ccline failed: exited with code 9: broken/);
	assert.equal(harness.footer.hasFrame, true);
	harness.footer.dispose();
});

test("shows extension statuses on an extra row below the ccline frame", async () => {
	const binary = fakeBinary("cat > /dev/null; printf 'FAKE-CCLINE\\n'");
	const statuses = new Map([["other-plugin", "Other status"]]);
	const harness = attach({ binary }, undefined, statuses);
	harness.render(80);
	await waitFor(() => harness.footer.hasFrame);
	assert.deepEqual(harness.render(80), ["FAKE-CCLINE", "Other status"]);

	// pi repaints on setStatus, so a later change needs no refresh of the frame.
	statuses.set("cursor-fast", "Cursor fast: on");
	assert.deepEqual(harness.render(80), ["FAKE-CCLINE", "Cursor fast: on Other status"]);
	statuses.clear();
	assert.deepEqual(harness.render(80), ["FAKE-CCLINE"]);
	harness.footer.dispose();
});

test("shows extension statuses even before ccline has produced a frame", () => {
	const statuses = new Map([["cursor-fast", "Cursor fast: off"]]);
	const harness = attach({ binary: fakeBinary("cat > /dev/null; printf 'LATE\\n'") }, undefined, statuses);
	const lines = harness.render(80);
	assert.equal(lines.length, 2);
	assert.match(lines[0] ?? "", /ccline/);
	assert.equal(lines[1], "Cursor fast: off");
	harness.footer.dispose();
});

test("live ticking advances time-based segments and stops with the agent run", async () => {
	const counter = join(tempDir("pi-ccline-live-"), "count");
	const binary = fakeBinary(
		[
			"cat > /dev/null",
			`printf '%s' "$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 ))" > "${counter}"`,
			"printf 'LIVE\\n'",
		].join("\n"),
	);

	const harness = attach({ binary, liveRefreshMs: 250 });
	harness.render(40);
	await waitFor(() => harness.footer.hasFrame);
	const afterFirstFrame = countSpawns(counter);

	harness.footer.startLive();
	await waitFor(() => countSpawns(counter) >= afterFirstFrame + 2);

	harness.footer.stopLive();
	// Stopping only clears the interval: one already-queued refresh may still land.
	await sleep(1400);
	const drained = countSpawns(counter);
	await sleep(1300);
	assert.equal(countSpawns(counter), drained, "no periodic refresh after stopLive");
});

test("dispose stops the ticker even while a refresh is queued", async () => {
	const counter = join(tempDir("pi-ccline-live-dispose-"), "count");
	const binary = fakeBinary(
		[
			"cat > /dev/null",
			`printf '%s' "$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 ))" > "${counter}"`,
			"printf 'LIVE\\n'",
		].join("\n"),
	);

	const harness = attach({ binary, liveRefreshMs: 250 });
	harness.render(40);
	await waitFor(() => harness.footer.hasFrame);
	harness.footer.startLive();
	await waitFor(() => countSpawns(counter) >= 2);

	harness.footer.requestRefresh();
	harness.footer.dispose();
	const atDispose = countSpawns(counter);
	await sleep(1400);
	assert.equal(countSpawns(counter), atDispose, "nothing runs after dispose");
	assert.equal(harness.footer.hasFrame, true, "the last frame is kept");
});

test("dispose stops refreshes, keeps the last frame and spawns nothing new", async () => {
	const counter = join(tempDir("pi-ccline-dispose-"), "count");
	const binary = fakeBinary(
		[
			"cat > /dev/null",
			`n=0; [ -f "${counter}" ] && n=$(cat "${counter}")`,
			`printf '%s' "$((n+1))" > "${counter}"`,
			"printf 'STABLE\\n'",
		].join("\n"),
	);

	const harness = attach({ binary });
	harness.render(40);
	await waitFor(() => harness.footer.hasFrame);
	const before = harness.render(40);
	const spawnsBefore = Number(readFileSync(counter, "utf8"));
	const rendersBefore = harness.renders();

	harness.footer.dispose();
	harness.footer.requestRefresh();
	await sleep(1300);
	harness.render(40);

	assert.deepEqual(harness.render(40), before);
	assert.equal(Number(readFileSync(counter, "utf8")), spawnsBefore, "no spawn after dispose");
	assert.equal(harness.renders(), rendersBefore, "no repaint request after dispose");
});

test("dispose aborts an in-flight child and never paints its result", async () => {
	const directory = tempDir("pi-ccline-inflight-");
	const counter = join(directory, "count");
	const binary = fakeBinary(
		[
			"cat > /dev/null",
			`printf '%s' "$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 ))" > "${counter}"`,
			"sleep 10",
			"printf 'LATE\\n'",
		].join("\n"),
	);

	const harness = attach({ binary });
	harness.render(40);
	await waitFor(() => {
		try {
			return readFileSync(counter, "utf8") === "1";
		} catch {
			return false;
		}
	});
	const rendersBefore = harness.renders();
	const startedAt = Date.now();
	harness.footer.dispose();
	await sleep(300);

	assert.equal(harness.footer.hasFrame, false, "aborted result must not be painted");
	assert.equal(harness.renders(), rendersBefore, "no repaint for an aborted run");
	assert.ok(Date.now() - startedAt < 5000, "abort must not wait for the child");
	assert.equal(readFileSync(counter, "utf8"), "1", "the child was started exactly once");
});

/** Records what the extension registers so the real lifecycle wiring can be driven. */
function fakePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		registerCommand: () => {},
	};
	const dispatch = (name: string, ctx: unknown) => handlers.get(name)?.({ type: name }, ctx);
	return { pi, handlers, dispatch };
}

/** Session context whose footer factory captures the component pi would render. */
function fakeSession(options: { idle: boolean; binary: string }) {
	const captured: { component: { render(width: number): string[] } | null } = { component: null };
	const ctx = {
		...fakeContext(),
		isIdle: () => options.idle,
		ui: {
			setFooter: (factory: (tui: unknown, theme: unknown, footerData: unknown) => { render(width: number): string[] } | undefined) => {
				captured.component = factory
					? factory(
							{ requestRender: () => {} },
							{ fg: (_color: string, text: string) => text },
							{ onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
						)
					: null;
			},
			notify: () => {},
		},
	} as unknown as ExtensionContext;
	const loadConfig = () => ({ ...DEFAULT_CONFIG, binary: options.binary, liveRefreshMs: 250 });
	return { ctx, captured, loadConfig };
}

test("agent_start ticks the footer and agent_end leaves no periodic refresh behind", async () => {
	const counter = join(tempDir("pi-ccline-lifecycle-"), "count");
	const binary = fakeBinary(
		[
			"cat > /dev/null",
			`printf '%s' "$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 ))" > "${counter}"`,
			"printf 'LIVE\\n'",
		].join("\n"),
	);
	const { pi, handlers, dispatch } = fakePi();
	piCcline(pi as never, { loadConfig: () => ({ ...DEFAULT_CONFIG, binary, liveRefreshMs: 250 }) });

	for (const event of ["session_start", "turn_start", "turn_end", "agent_start", "agent_end", "agent_settled", "session_shutdown"]) {
		assert.ok(handlers.has(event), `${event} is wired`);
	}

	const { ctx, captured } = fakeSession({ idle: true, binary });
	await dispatch("session_start", ctx);
	assert.ok(captured.component, "the footer was installed");
	captured.component.render(60);
	await waitFor(() => countSpawns(counter) >= 1);

	const idleBaseline = countSpawns(counter);
	await sleep(700);
	assert.equal(countSpawns(counter), idleBaseline, "an idle session must not tick");

	await dispatch("agent_start", ctx);
	await waitFor(() => countSpawns(counter) >= idleBaseline + 2);

	await dispatch("agent_end", ctx);
	await sleep(1400); // let the queued final refresh land
	const drained = countSpawns(counter);
	await sleep(1300);
	assert.equal(countSpawns(counter), drained, "no periodic refresh once the run ended");

	await dispatch("session_shutdown", ctx);
});

test("a footer installed mid-run ticks without waiting for the next turn", async () => {
	const counter = join(tempDir("pi-ccline-lifecycle-midrun-"), "count");
	const binary = fakeBinary(
		[
			"cat > /dev/null",
			`printf '%s' "$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 ))" > "${counter}"`,
			"printf 'LIVE\\n'",
		].join("\n"),
	);
	const { pi, dispatch } = fakePi();
	piCcline(pi as never, { loadConfig: () => ({ ...DEFAULT_CONFIG, binary, liveRefreshMs: 250 }) });

	// The agent is already streaming when the session starts, so no agent_start
	// will arrive until the next run.
	const { ctx, captured } = fakeSession({ idle: false, binary });
	await dispatch("session_start", ctx);
	captured.component?.render(60);
	const installed = countSpawns(counter);
	await waitFor(() => countSpawns(counter) >= installed + 2);

	await dispatch("session_shutdown", ctx);
	await sleep(1400);
	const afterShutdown = countSpawns(counter);
	await sleep(1000);
	assert.equal(countSpawns(counter), afterShutdown, "shutdown stops the ticker");
});
