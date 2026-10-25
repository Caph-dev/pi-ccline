import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export type BinarySource = "config" | "home" | "path" | "missing";

export interface ResolvedBinary {
	path: string | null;
	source: BinarySource;
}

export interface ResolveOptions {
	home?: string;
	pathEnv?: string;
	platform?: string;
}

/** Cap on captured output per stream; the footer only needs a couple of lines. */
const MAX_STREAM_BYTES = 256 * 1024;

export function isExecutableFile(path: string): boolean {
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return false;
		if (process.platform === "win32") return true;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}

let cached: { key: string; result: ResolvedBinary } | null = null;

/** Drop the resolution cache, e.g. after the config or PATH changed. */
export function clearBinaryCache(): void {
	cached = null;
}

/**
 * Resolve the ccline binary in the documented order:
 * config.binary -> ~/.claude/ccline/ccline -> PATH.
 * A configured path that does not exist falls through instead of failing.
 */
export function resolveBinary(configured: string | null | undefined, options: ResolveOptions = {}): ResolvedBinary {
	const home = options.home ?? homedir();
	const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
	const platform = options.platform ?? process.platform;
	const key = [configured ?? "", home, pathEnv, platform].join("\u0000");

	if (cached && cached.key === key) return cached.result;

	const result = resolveBinaryUncached(configured, home, pathEnv, platform);
	cached = { key, result };
	return result;
}

function resolveBinaryUncached(configured: string | null | undefined, home: string, pathEnv: string, platform: string): ResolvedBinary {
	const configuredPath = typeof configured === "string" ? configured.trim() : "";
	if (configuredPath) {
		const candidate = expandHome(configuredPath, home);
		if (isExecutableFile(candidate)) return { path: candidate, source: "config" };
	}

	const homeCandidate = join(home, ".claude", "ccline", "ccline");
	if (isExecutableFile(homeCandidate)) return { path: homeCandidate, source: "home" };

	const names = platform === "win32" ? ["ccline.exe", "ccline.cmd", "ccline"] : ["ccline"];
	for (const directory of pathEnv.split(delimiter)) {
		const trimmedDirectory = directory.trim();
		if (!trimmedDirectory) continue;
		for (const name of names) {
			const candidate = resolve(trimmedDirectory, name);
			if (isExecutableFile(candidate)) return { path: candidate, source: "path" };
		}
	}

	return { path: null, source: "missing" };
}

export interface SpawnOptions {
	binary: string;
	args?: string[];
	/** Written to stdin, then stdin is closed. */
	payload?: string;
	timeoutMs: number;
	/** Exported to the child as COLUMNS, which drives ccline's line wrapping. */
	columns?: number;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

export interface SpawnResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	aborted: boolean;
	error?: string;
}

function emptyResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
	return { ok: false, stdout: "", stderr: "", code: null, timedOut: false, aborted: false, ...overrides };
}

/**
 * Run the binary once. Never rejects: timeouts, spawn failures, early exits and
 * aborts all resolve to a result the caller can degrade from.
 */
export function spawnCcline(options: SpawnOptions): Promise<SpawnResult> {
	return new Promise<SpawnResult>((resolvePromise) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let timedOut = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn> | undefined;

		const onAbort = () => {
			if (settled) return;
			try {
				child?.kill("SIGKILL");
			} catch {
				// already gone
			}
			finish(emptyResult({ aborted: true, stdout: collect(stdoutChunks), stderr: collect(stderrChunks) }));
		};

		const finish = (result: SpawnResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			try {
				child?.stdin?.destroy();
				child?.stdout?.destroy();
				child?.stderr?.destroy();
			} catch {
				// ignore teardown errors
			}
			resolvePromise(result);
		};

		const collect = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");

		if (options.signal?.aborted) {
			resolvePromise(emptyResult({ aborted: true }));
			return;
		}

		const env: NodeJS.ProcessEnv = { ...process.env };
		if (options.columns !== undefined && Number.isFinite(options.columns)) {
			env.COLUMNS = String(Math.max(1, Math.round(options.columns)));
		}
		Object.assign(env, options.env ?? {});

		try {
			child = spawn(options.binary, options.args ?? [], { env, stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			finish(emptyResult({ error: error instanceof Error ? error.message : String(error) }));
			return;
		}

		timer = setTimeout(() => {
			timedOut = true;
			try {
				child?.kill("SIGKILL");
			} catch {
				// already gone
			}
			finish(emptyResult({ timedOut: true, stdout: collect(stdoutChunks), stderr: collect(stderrChunks) }));
		}, Math.max(1, options.timeoutMs));

		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (error) => {
			finish(emptyResult({ error: error.message, stdout: collect(stdoutChunks), stderr: collect(stderrChunks) }));
		});

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes <= MAX_STREAM_BYTES) stdoutChunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes <= MAX_STREAM_BYTES) stderrChunks.push(chunk);
		});

		// The child may exit before reading stdin; a failed write is expected then.
		child.stdin?.on("error", () => {});
		try {
			if (options.payload !== undefined) child.stdin?.write(options.payload);
			child.stdin?.end();
		} catch {
			// ignore: the close handler still settles the promise
		}

		child.on("close", (code) => {
			finish(
				emptyResult({
					ok: code === 0 && !timedOut,
					stdout: collect(stdoutChunks),
					stderr: collect(stderrChunks),
					code,
					timedOut,
				}),
			);
		});
	});
}

/** Read `ccline --version`. Returns null when the binary cannot be probed. */
export async function probeVersion(binary: string, timeoutMs = 2000, signal?: AbortSignal): Promise<string | null> {
	const result = await spawnCcline({ binary, args: ["--version"], timeoutMs, signal });
	if (!result.ok) return null;
	const line = result.stdout.split("\n")[0]?.trim();
	return line ? line : null;
}
