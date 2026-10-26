// Measures the main loop's last model request and hands it to ccline through
// the bridge file its companion mod normally writes.
//
// ccline's `timing.ttft` / `timing.tps` metrics read `bridge/<session>.json`
// under ccline's data dir, not the statusline JSON: per-request timing is the
// one thing the Claude Code payload leaves out. pi has the same gap, so the
// numbers are measured here from streaming events and written in the same
// documented v1 shape (the file is rewritten on every finished request, which
// also keeps it inside ccline's 6h freshness window).

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One finished model request, in the units ccline's bridge expects. */
export interface TurnTiming {
	model?: string | undefined;
	/** Stream start to the first text, thinking or tool-call delta. */
	ttftMs?: number | undefined;
	/** Output tokens per second while the answer streamed (ttft excluded). */
	tps: number;
	durationMs: number;
	outputTokens: number;
}

/** Below this the sample says more about jitter than about speed. */
const MIN_STREAM_MS = 100;

/**
 * ccline resolves its data dir from `CCLINE_HOME`, falling back to
 * `~/.claude/ccline`; the bridge lives in a `bridge` subdirectory of either.
 */
export function bridgeDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const override = env.CCLINE_HOME?.trim();
	return join(override ? override : join(home, ".claude", "ccline"), "bridge");
}

/**
 * ccline's own name check rejects anything that could climb out of the bridge
 * directory; pi session ids are UUIDs, so a strict allowlist costs nothing.
 */
export function bridgeFileName(sessionId: string): string | null {
	return /^[A-Za-z0-9._-]+$/.test(sessionId) ? `${sessionId}.json` : null;
}

export interface TurnBridgeOptions {
	sessionId: string;
	timing: TurnTiming;
	/** Unix epoch milliseconds of the write; ccline drops bridges older than 6h. */
	nowMs: number;
	dir?: string;
}

/** Write the bridge for one session. Returns false instead of throwing. */
export function writeTurnBridge(options: TurnBridgeOptions): boolean {
	const name = bridgeFileName(options.sessionId);
	if (!name) return false;
	const dir = options.dir ?? bridgeDir();
	const path = join(dir, name);
	const { model, ttftMs, tps, durationMs, outputTokens } = options.timing;
	const turn: Record<string, unknown> = {
		tps,
		duration_ms: Math.round(durationMs),
		output_tokens: Math.round(outputTokens),
	};
	if (model) turn.model = model;
	if (ttftMs !== undefined) turn.ttft_ms = Math.round(ttftMs);
	const payload = {
		v: 1,
		session: options.sessionId,
		updated_at: Math.round(options.nowMs),
		turn,
	};

	try {
		mkdirSync(dir, { recursive: true });
		// ccline tolerates a half-written bridge by retrying once, but an atomic
		// rename means it never has to.
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(payload)}\n`, "utf8");
		renameSync(temp, path);
		return true;
	} catch {
		// A failed write must not leave a temp file behind next to the bridges
		// ccline scans (and must never throw into the session).
		try {
			rmSync(`${path}.${process.pid}.tmp`, { force: true });
		} catch {
			// nothing left to do; ccline prunes the directory itself
		}
		return false;
	}
}

/** Drop a session's bridge, so a closed session leaves no stale speed behind. */
export function removeTurnBridge(sessionId: string, dir: string = bridgeDir()): void {
	const name = bridgeFileName(sessionId);
	if (!name) return;
	try {
		rmSync(join(dir, name), { force: true });
	} catch {
		// A bridge that cannot be removed is pruned by ccline after a week.
	}
}

/**
 * Times one request from three streaming events: `message_start` (the answer
 * began), the first `message_update` (first token) and `message_end`.
 * A request without a first delta (a non-streaming provider) yields no speed.
 */
export class TurnMeter {
	private startedAt: number | null = null;
	private firstDeltaAt: number | null = null;
	private model: string | undefined;

	start(model: string | undefined, nowMs: number): void {
		this.startedAt = nowMs;
		this.firstDeltaAt = null;
		this.model = model;
	}

	firstDelta(nowMs: number): void {
		if (this.startedAt === null || this.firstDeltaAt !== null) return;
		this.firstDeltaAt = nowMs;
	}

	/** The answer finished; null when the sample cannot describe a speed. */
	finish(outputTokens: unknown, nowMs: number): TurnTiming | null {
		const startedAt = this.startedAt;
		const firstDeltaAt = this.firstDeltaAt;
		const model = this.model;
		this.startedAt = null;
		this.firstDeltaAt = null;
		this.model = undefined;
		if (startedAt === null || firstDeltaAt === null) return null;

		const output = typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : 0;
		const streamMs = nowMs - firstDeltaAt;
		if (output <= 0 || streamMs < MIN_STREAM_MS) return null;

		const tps = output / (streamMs / 1000);
		if (!Number.isFinite(tps) || tps <= 0) return null;

		const ttftMs = Math.max(0, firstDeltaAt - startedAt);
		return { model, tps, durationMs: Math.max(0, nowMs - startedAt), outputTokens: output, ttftMs };
	}
}

