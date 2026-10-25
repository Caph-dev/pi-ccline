import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clearBinaryCache, isExecutableFile, probeVersion, resolveBinary, spawnCcline } from "./binary.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-ccline-bin-"));
}

function makeExecutable(path: string): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(path, 0o755);
	return path;
}

function makeHome(): string {
	return tempDir();
}

test("resolveBinary prefers config.binary, then ~/.claude/ccline/ccline, then PATH", () => {
	clearBinaryCache();
	const home = makeHome();
	const pathDir = tempDir();
	const fromPath = makeExecutable(join(pathDir, "ccline"));
	const fromHome = makeExecutable(join(home, ".claude", "ccline", "ccline"));
	const fromConfig = makeExecutable(join(tempDir(), "custom-ccline"));

	assert.deepEqual(resolveBinary(fromConfig, { home, pathEnv: pathDir }), { path: fromConfig, source: "config" });
	assert.deepEqual(resolveBinary(null, { home, pathEnv: pathDir }), { path: fromHome, source: "home" });

	// Same home without the home binary falls through to PATH.
	const emptyHome = makeHome();
	assert.deepEqual(resolveBinary(null, { home: emptyHome, pathEnv: pathDir }), { path: fromPath, source: "path" });
});

test("resolveBinary reports missing instead of throwing", () => {
	clearBinaryCache();
	const result = resolveBinary(null, { home: makeHome(), pathEnv: tempDir() });
	assert.deepEqual(result, { path: null, source: "missing" });
});

test("an unusable config.binary falls through to the default order", () => {
	clearBinaryCache();
	const home = makeHome();
	const fromHome = makeExecutable(join(home, ".claude", "ccline", "ccline"));
	assert.deepEqual(resolveBinary("/does/not/exist", { home, pathEnv: "" }), { path: fromHome, source: "home" });
});

test("a non-executable file is not accepted", () => {
	const path = join(tempDir(), "plain.txt");
	writeFileSync(path, "x", "utf8");
	chmodSync(path, 0o644);
	assert.equal(isExecutableFile(path), false);
});

test("a directory is not accepted", () => {
	assert.equal(isExecutableFile(tempDir()), false);
});

test("spawnCcline passes COLUMNS and returns stdout", async () => {
	const result = await spawnCcline({
		binary: process.execPath,
		args: ["-e", "process.stdout.write(`cols=${process.env.COLUMNS}|extra=${process.env.PI_CCLINE_TEST}`)"],
		payload: "",
		timeoutMs: 5000,
		columns: 40,
		env: { PI_CCLINE_TEST: "yes" },
	});
	assert.equal(result.ok, true);
	assert.equal(result.stdout, "cols=40|extra=yes");
	assert.equal(result.code, 0);
});

test("spawnCcline reports a non-zero exit with stderr", async () => {
	const result = await spawnCcline({
		binary: process.execPath,
		args: ["-e", "process.stderr.write('nope'); process.exit(3)"],
		payload: "",
		timeoutMs: 5000,
	});
	assert.equal(result.ok, false);
	assert.equal(result.code, 3);
	assert.equal(result.stderr, "nope");
	assert.equal(result.timedOut, false);
});

test("spawnCcline kills a hung child at the timeout", async () => {
	const started = Date.now();
	const result = await spawnCcline({
		binary: process.execPath,
		args: ["-e", "setTimeout(() => {}, 30000)"],
		payload: "",
		timeoutMs: 300,
	});
	assert.equal(result.timedOut, true);
	assert.equal(result.ok, false);
	assert.ok(Date.now() - started < 10_000);
});

test("spawnCcline survives a child that exits before reading stdin", async () => {
	const result = await spawnCcline({
		binary: process.execPath,
		args: ["-e", "process.exit(0)"],
		payload: "x".repeat(4 * 1024 * 1024),
		timeoutMs: 5000,
	});
	assert.equal(result.ok, true);
	assert.equal(result.timedOut, false);
});

test("spawnCcline resolves an error for a missing binary", async () => {
	const result = await spawnCcline({ binary: join(tempDir(), "nope"), payload: "", timeoutMs: 2000 });
	assert.equal(result.ok, false);
	assert.equal(typeof result.error, "string");
});

test("spawnCcline honors an already aborted signal", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await spawnCcline({
		binary: process.execPath,
		args: ["-e", "setTimeout(() => {}, 5000)"],
		payload: "",
		timeoutMs: 5000,
		signal: controller.signal,
	});
	assert.equal(result.aborted, true);
});

test("spawnCcline aborts a running child", async () => {
	const controller = new AbortController();
	const promise = spawnCcline({
		binary: process.execPath,
		args: ["-e", "setTimeout(() => {}, 30000)"],
		payload: "",
		timeoutMs: 20000,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 100);
	const result = await promise;
	assert.equal(result.aborted, true);
});

test("probeVersion reads --version output", async () => {
	const binary = join(tempDir(), "fake-ccline");
	writeFileSync(binary, "#!/bin/sh\necho 'ccline 2.0.1'\n", "utf8");
	chmodSync(binary, 0o755);
	assert.equal(await probeVersion(binary, 3000), "ccline 2.0.1");
	assert.equal(await probeVersion(join(tempDir(), "missing"), 1000), null);
});
