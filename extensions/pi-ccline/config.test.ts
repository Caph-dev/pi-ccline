import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG, MIN_LIVE_REFRESH_MS, MIN_THROTTLE_MS, configPath, loadConfig, normalizeConfig, saveConfig } from "./config.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-ccline-config-"));
}

test("uses defaults when the config file is missing", () => {
	assert.deepEqual(loadConfig(join(tempDir(), "config.json")), DEFAULT_CONFIG);
});

test("falls back to defaults on broken JSON instead of throwing", () => {
	const path = join(tempDir(), "config.json");
	writeFileSync(path, "{ not json", "utf8");
	assert.deepEqual(loadConfig(path), DEFAULT_CONFIG);
});

test("normalizes wrong types and clamps the throttle to one second", () => {
	const config = normalizeConfig({
		enabled: "yes",
		binary: "  ",
		timeoutMs: 10,
		refreshThrottleMs: 5,
		liveRefreshMs: 10,
		env: { A: "1", B: 2 },
	});
	assert.equal(config.enabled, true);
	assert.equal(config.binary, null);
	assert.equal(config.timeoutMs, 200);
	assert.equal(config.refreshThrottleMs, MIN_THROTTLE_MS);
	assert.equal(config.liveRefreshMs, MIN_LIVE_REFRESH_MS);
	assert.deepEqual(config.env, { A: "1" });
});

test("liveRefreshMs 0 disables ticker and bad values fall back to the default", () => {
	assert.equal(normalizeConfig({ liveRefreshMs: 0 }).liveRefreshMs, 0);
	assert.equal(normalizeConfig({ liveRefreshMs: "fast" }).liveRefreshMs, DEFAULT_CONFIG.liveRefreshMs);
	assert.equal(normalizeConfig({ liveRefreshMs: 2500 }).liveRefreshMs, 2500);
});

test("keeps valid overrides", () => {
	const config = normalizeConfig({ enabled: false, binary: "/tmp/ccline", timeoutMs: 9000, refreshThrottleMs: 2500 });
	assert.deepEqual(config, {
		enabled: false,
		binary: "/tmp/ccline",
		timeoutMs: 9000,
		refreshThrottleMs: 2500,
		liveRefreshMs: DEFAULT_CONFIG.liveRefreshMs,
		showProvider: DEFAULT_CONFIG.showProvider,
		env: {},
	});
});

test("showProvider defaults on and ignores non-boolean values", () => {
	assert.equal(DEFAULT_CONFIG.showProvider, true);
	assert.equal(normalizeConfig({}).showProvider, true);
	assert.equal(normalizeConfig({ showProvider: false }).showProvider, false);
	assert.equal(normalizeConfig({ showProvider: "no" }).showProvider, true);
});

test("round-trips through saveConfig and loadConfig", () => {
	const home = tempDir();
	const config = { ...DEFAULT_CONFIG, enabled: false, binary: "/opt/ccline", env: { FOO: "bar" } };
	assert.equal(saveConfig(config, configPath(home)), true);
	assert.deepEqual(loadConfig(configPath(home)), config);
});

test("saveConfig reports failure instead of throwing", () => {
	const home = tempDir();
	const path = join(home, "file-as-dir", "config.json");
	writeFileSync(join(home, "file-as-dir"), "blocked", "utf8");
	assert.equal(saveConfig(DEFAULT_CONFIG, path), false);
});
