import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PiCclineConfig {
	/** Whether the footer is installed at session start. */
	enabled: boolean;
	/** Explicit ccline binary path; null means use the default resolution order. */
	binary: string | null;
	/** Hard timeout for one ccline invocation. */
	timeoutMs: number;
	/** Minimum spacing between two refreshes. Never below MIN_THROTTLE_MS. */
	refreshThrottleMs: number;
	/**
	 * Interval of the live ticker that keeps time-based segments (elapsed
	 * duration) moving while the agent runs. 0 disables the ticker.
	 */
	liveRefreshMs: number;
	/** Append the model's provider to the model segment of the footer. */
	showProvider: boolean;
	/** Extra environment variables passed to the binary. */
	env: Record<string, string>;
}

export const DEFAULT_CONFIG: PiCclineConfig = {
	enabled: true,
	binary: null,
	timeoutMs: 5000,
	refreshThrottleMs: 1000,
	liveRefreshMs: 1000,
	showProvider: true,
	env: {},
};

export const MIN_TIMEOUT_MS = 200;
export const MAX_TIMEOUT_MS = 60_000;
/** The footer re-renders often; a faster refresh rate would spawn too many processes. */
export const MIN_THROTTLE_MS = 1000;
/** Below this a live ticker would spawn processes faster than a statusline is read. */
export const MIN_LIVE_REFRESH_MS = 250;

/** Path of the extension's own config file (not pi's settings.json). */
export function configPath(home: string = homedir()): string {
	return join(home, ".pi", "agent", "pi-ccline", "config.json");
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/** Coerce arbitrary parsed JSON into a valid config. Never throws. */
export function normalizeConfig(raw: unknown): PiCclineConfig {
	const source: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

	const env: Record<string, string> = {};
	const rawEnv = source.env;
	if (rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)) {
		for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
			if (typeof value === "string") env[key] = value;
		}
	}

	/** 0 is an explicit opt-out; anything else is clamped to a sane tick range. */
function clampLiveRefresh(value: unknown, fallback: number): number {
	if (value === 0) return 0;
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_LIVE_REFRESH_MS, Math.round(value)));
}

const binary = typeof source.binary === "string" && source.binary.trim() ? source.binary.trim() : null;

	return {
		enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CONFIG.enabled,
		binary,
		timeoutMs: clampInt(source.timeoutMs, DEFAULT_CONFIG.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
		refreshThrottleMs: clampInt(source.refreshThrottleMs, DEFAULT_CONFIG.refreshThrottleMs, MIN_THROTTLE_MS, MAX_TIMEOUT_MS),
		liveRefreshMs: clampLiveRefresh(source.liveRefreshMs, DEFAULT_CONFIG.liveRefreshMs),
		showProvider: typeof source.showProvider === "boolean" ? source.showProvider : DEFAULT_CONFIG.showProvider,
		env,
	};
}

/** Read the config file. A missing or broken file falls back to defaults. */
export function loadConfig(path: string = configPath()): PiCclineConfig {
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return normalizeConfig(DEFAULT_CONFIG);
	}
}

/** Persist the config. Returns false instead of throwing on any I/O error. */
export function saveConfig(config: PiCclineConfig, path: string = configPath()): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
		renameSync(temp, path);
		return true;
	} catch {
		return false;
	}
}
