import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { extensionStatusLine, loadingNotice, missingBinaryNotice, normalizeFrame, noticeFrame, sanitizeStatusText, withStaleMarker } from "./render.ts";

const RED = "\u001b[31m";
const RESET = "\u001b[0m";

test("splits ccline output into footer lines and drops trailing blanks", () => {
	const stdout = `${RED}one${RESET}\n${RED}two${RESET}\n\n`;
	assert.deepEqual(normalizeFrame(stdout, 80), [`${RED}one${RESET}`, `${RED}two${RESET}`]);
});

test("strips carriage returns", () => {
	assert.deepEqual(normalizeFrame("a\r\nb\r\n", 80), ["a", "b"]);
});

test("truncates by visible width, not string length", () => {
	const line = `${RED}${"日".repeat(20)}${RESET}`;
	assert.equal(visibleWidth(line), 40);
	assert.notEqual(line.length, visibleWidth(line));
	const [truncated = ""] = normalizeFrame(line, 10);
	assert.ok(visibleWidth(truncated) <= 10, `visible width was ${visibleWidth(truncated)}`);
});

test("keeps a line that already fits untouched", () => {
	const line = `${RED}abc${RESET}`;
	assert.deepEqual(normalizeFrame(line, 3), [line]);
});

test("narrow widths do not overflow", () => {
	for (const width of [1, 2, 5]) {
		const [line = ""] = normalizeFrame(`${RED}model · dir · 15% · 120k tokens${RESET}`, width);
		assert.ok(visibleWidth(line) <= width, `width ${width} produced ${visibleWidth(line)}`);
	}
});

test("empty output normalizes to no lines so the caller can keep the last frame", () => {
	assert.deepEqual(normalizeFrame("", 80), []);
	assert.deepEqual(normalizeFrame("\n\n", 80), []);
});

test("notices fit the width", () => {
	for (const frame of [loadingNotice(6), missingBinaryNotice(20), noticeFrame("ccline failed: exit 1", 12)]) {
		assert.equal(frame.length, 1);
		assert.ok(visibleWidth(frame[0] ?? "") <= 20);
	}
});

test("stale marker is appended only when it still fits", () => {
	const lines = ["short"];
	assert.deepEqual(withStaleMarker(lines, 20, " ·stale"), ["short ·stale"]);
	assert.deepEqual(withStaleMarker(lines, 7, " ·stale"), ["short"]);
	assert.deepEqual(withStaleMarker([], 20, " ·stale"), []);
});

test("stale marker respects ANSI width on the last line", () => {
	const lines = [`${RED}12345${RESET}`];
	const marked = withStaleMarker(lines, 11, "xx");
	assert.equal(marked.length, 1);
	assert.ok(visibleWidth(marked[0] ?? "") <= 11);
});

test("extension statuses become one sorted row like the built-in footer", () => {
	const statuses = new Map([
		["cursor-fast", "Cursor fast: on"],
		["alpha", "first"],
	]);
	assert.equal(extensionStatusLine(statuses, 80), "first Cursor fast: on");
});

test("status text is collapsed to a single line", () => {
	assert.equal(sanitizeStatusText("a\nb\tc  \r\nd"), "a b c d");
	assert.equal(extensionStatusLine(new Map([["k", "one\ntwo"]]), 80), "one two");
});

test("blank statuses are dropped and an empty set produces no row", () => {
	assert.equal(extensionStatusLine(new Map([["k", "   "]]) as Map<string, string>, 80), null);
	assert.equal(extensionStatusLine(new Map(), 80), null);
	assert.equal(extensionStatusLine(null, 80), null);
	assert.equal(extensionStatusLine(undefined, 80), null);
});

test("a long status row is truncated by visible width with the dim ellipsis", () => {
	const row = extensionStatusLine(new Map([["k", "日".repeat(20)]]), 10, "...");
	assert.ok(row !== null);
	assert.ok(visibleWidth(row) <= 10, `visible width was ${visibleWidth(row ?? "")}`);
	assert.ok((row ?? "").replace(/\u001b\[[0-9;]*m/g, "").endsWith("..."));
});

test("a badge adds its icon and color to the matching status key only", () => {
	const statuses = new Map([
		["mcp", "connected"],
		["pi-herdr-pstack", "poteto-mode"],
	]);
	const line = extensionStatusLine(statuses, 80, "…", {
		badges: { "pi-herdr-pstack": { icon: "R", color: "accent" } },
		colorize: (color, text) => `[${color}]${text}`,
	});
	assert.equal(line, "connected [accent]R poteto-mode");
});

test("a status that colors itself keeps its own styling", () => {
	const statuses = new Map([["pi-herdr-pstack", `${RED}poteto-mode${RESET}`]]);
	const line = extensionStatusLine(statuses, 80, "…", {
		badges: { "pi-herdr-pstack": { icon: "R", color: "accent" } },
		colorize: (color, text) => `[${color}]${text}`,
	});
	assert.equal(line, `${RED}poteto-mode${RESET}`);
});

test("an unknown theme token falls back to the plain badge label", () => {
	const line = extensionStatusLine(new Map([["k", "v"]]), 80, "…", {
		badges: { k: { icon: "R", color: "nope" } },
		colorize: () => {
			throw new Error("Unknown theme color: nope");
		},
	});
	assert.equal(line, "R v");
});

test("an icon with no color still shows, and an empty icon adds no gap", () => {
	const badges = { a: { icon: "R" }, b: { icon: "", color: "accent" } };
	const line = extensionStatusLine(new Map([["a", "one"], ["b", "two"]]), 80, "…", {
		badges,
		colorize: (color, text) => `[${color}]${text}`,
	});
	assert.equal(line, "R one [accent]two");
});

test("only own badge entries are applied, never inherited object members", () => {
	const line = extensionStatusLine(new Map([["toString", "v"]]), 80, "…", {
		badges: {},
		colorize: (color, text) => `[${color}]${text}`,
	});
	assert.equal(line, "v");
});

test("the badge counts toward the truncated width", () => {
	const row = extensionStatusLine(new Map([["k", "日".repeat(10)]]), 10, "...", {
		badges: { k: { icon: "R", color: "accent" } },
		colorize: (color, text) => `\u001b[35m${text}\u001b[39m`,
	});
	assert.ok(row !== null);
	assert.ok(visibleWidth(row) <= 10, `visible width was ${visibleWidth(row ?? "")}`);
});
