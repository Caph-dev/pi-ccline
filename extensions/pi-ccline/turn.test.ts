import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { bridgeDir, bridgeFileName, removeTurnBridge, TurnMeter, writeBridge } from "./turn.ts";

const createdDirs: string[] = [];
afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ccline-turn-"));
	createdDirs.push(dir);
	return dir;
}

test("measures streaming speed without counting the wait for the first token", () => {
	const meter = new TurnMeter();
	meter.start("claude-sonnet-4-5", 1_000);
	meter.firstDelta(1_800);
	assert.deepEqual(meter.finish(500, 6_800), {
		model: "claude-sonnet-4-5",
		ttftMs: 800,
		tps: 100,
		durationMs: 5_800,
		outputTokens: 500,
	});
});

test("keeps only the first delta of an answer", () => {
	const meter = new TurnMeter();
	meter.start("m", 0);
	meter.firstDelta(500);
	meter.firstDelta(900);
	meter.firstDelta(1_200);
	// 200 tokens over the 1500ms after the first token, not over 1000ms.
	assert.equal(meter.finish(200, 2_000)?.tps, 200 / 1.5);
});

test("reports nothing without a first delta, output or a measurable span", () => {
	const neverStreamed = new TurnMeter();
	neverStreamed.start("m", 0);
	assert.equal(neverStreamed.finish(100, 5_000), null, "a non-streaming answer has no speed");

	const empty = new TurnMeter();
	empty.start("m", 0);
	empty.firstDelta(100);
	assert.equal(empty.finish(0, 5_000), null, "no output tokens means no rate");

	const tooShort = new TurnMeter();
	tooShort.start("m", 0);
	tooShort.firstDelta(100);
	assert.equal(tooShort.finish(5, 150), null, "a sub-100ms span is jitter, not speed");

	const unmeasured = new TurnMeter();
	unmeasured.firstDelta(100);
	assert.equal(unmeasured.finish(100, 5_000), null, "finish before start is ignored");
});

test("a finished sample does not leak into the next request", () => {
	const meter = new TurnMeter();
	meter.start("first", 0);
	meter.firstDelta(100);
	meter.finish(10, 1_100);

	meter.start("second", 2_000);
	meter.firstDelta(2_400);
	const second = meter.finish(80, 3_400);
	assert.equal(second?.model, "second");
	assert.equal(second?.ttftMs, 400);
	assert.equal(second?.tps, 80);
});

test("writes the bridge shape ccline reads", () => {
	const dir = tempDir();
	assert.equal(
		writeBridge({
			sessionId: "sess-1",
			timing: { model: "m", ttftMs: 820, tps: 74.234, durationMs: 41_000, outputTokens: 1_400 },
			tools: [{ name: "Bash", since: 1_790_808_755_000 }],
			nowMs: 1_790_808_780_000,
			dir,
		}),
		true,
	);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "sess-1.json"), "utf8")), {
		v: 1,
		session: "sess-1",
		updated_at: 1_790_808_780_000,
		turn: { model: "m", ttft_ms: 820, tps: 74.234, duration_ms: 41_000, output_tokens: 1_400 },
		tools: [{ name: "Bash", since: 1_790_808_755_000 }],
	});
});

test("keeps the turn when tools come and go, and vice versa", () => {
	const dir = tempDir();
	const timing = { tps: 60, durationMs: 2_000, outputTokens: 120 };

	// A tools-only write must not blank timing.tps, and a timing-only write must
	// not leave a stale tool behind: both live in the same file.
	writeBridge({ sessionId: "s4", timing, nowMs: 1, dir });
	writeBridge({ sessionId: "s4", timing, tools: [{ name: "Read", since: 5 }], nowMs: 2, dir });
	const withTool = JSON.parse(readFileSync(join(dir, "s4.json"), "utf8"));
	assert.equal(withTool.turn.tps, 60);
	assert.deepEqual(withTool.tools, [{ name: "Read", since: 5 }]);

	writeBridge({ sessionId: "s4", timing, tools: [], nowMs: 3, dir });
	const afterTool = JSON.parse(readFileSync(join(dir, "s4.json"), "utf8"));
	assert.deepEqual(Object.keys(afterTool).sort(), ["session", "turn", "updated_at", "v"]);
});

test("writes nothing when there is neither timing nor a running tool", () => {
	const dir = tempDir();
	assert.equal(writeBridge({ sessionId: "s5", nowMs: 1, dir }), false);
	assert.equal(writeBridge({ sessionId: "s5", tools: [], nowMs: 1, dir }), false);
	assert.deepEqual(readdirSync(dir), []);
});

test("omits timing fields it did not measure", () => {
	const dir = tempDir();
	writeBridge({ sessionId: "s2", timing: { tps: 12, durationMs: 1_000, outputTokens: 12 }, nowMs: 1, dir });
	const bridge = JSON.parse(readFileSync(join(dir, "s2.json"), "utf8"));
	assert.deepEqual(Object.keys(bridge.turn).sort(), ["duration_ms", "output_tokens", "tps"]);
});

test("refuses session ids that are not plain file names", () => {
	const dir = tempDir();
	assert.equal(bridgeFileName("../escape"), null);
	assert.equal(bridgeFileName("a/b"), null);
	assert.equal(bridgeFileName(""), null);
	assert.equal(writeBridge({ sessionId: "../escape", timing: { tps: 1, durationMs: 1, outputTokens: 1 }, nowMs: 1, dir }), false);
	assert.deepEqual(readdirSync(dir), [], "nothing escaped or landed in the bridge dir");
});

test("a failed write leaves no temp file behind", () => {
	const dir = tempDir();
	// A directory in the target's place makes the rename fail after the temp
	// file was already written.
	mkdirSync(join(dir, "blocked.json"));
	assert.equal(writeBridge({ sessionId: "blocked", timing: { tps: 1, durationMs: 1, outputTokens: 1 }, nowMs: 1, dir }), false);
	assert.deepEqual(readdirSync(dir), ["blocked.json"]);
});

test("removes a session bridge and tolerates a missing one", () => {
	const dir = tempDir();
	writeBridge({ sessionId: "s3", timing: { tps: 1, durationMs: 1, outputTokens: 1 }, nowMs: 1, dir });
	assert.equal(existsSync(join(dir, "s3.json")), true);
	removeTurnBridge("s3", dir);
	assert.equal(existsSync(join(dir, "s3.json")), false);
	removeTurnBridge("s3", dir);
	removeTurnBridge("../escape", dir);
});

test("follows ccline's own data directory resolution", () => {
	assert.equal(bridgeDir({ CCLINE_HOME: "/tmp/ccline-home" }, "/home/u"), "/tmp/ccline-home/bridge");
	assert.equal(bridgeDir({ CCLINE_HOME: "  " }, "/home/u"), "/home/u/.claude/ccline/bridge");
	assert.equal(bridgeDir({}, "/home/u"), "/home/u/.claude/ccline/bridge");
});
