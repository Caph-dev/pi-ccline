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
	/**
	 * Per status-key badges for other extensions' `ctx.ui.setStatus` rows, merged
	 * over `DEFAULT_STATUS_BADGES` at render time. Only the fields a user set are
	 * stored, so a newer built-in default still applies when a field is absent.
	 */
	statusBadges: Record<string, StatusBadgeOverride>;
}

export const DEFAULT_CONFIG: PiCclineConfig = {
	enabled: true,
	binary: null,
	timeoutMs: 5000,
	refreshThrottleMs: 1000,
	liveRefreshMs: 1000,
	showProvider: true,
	env: {},
	statusBadges: {},
};

/** A resolved badge: a Nerd Font glyph in front of the text and a theme color. */
export interface StatusBadge {
	/** Glyph shown before the status text; empty for none. */
	icon: string;
	/** pi theme foreground token (`accent`, `success`, …); empty or unknown for no color. */
	color: string;
}

/** What a user may write per key: either field may be omitted and inherited. */
export type StatusBadgeOverride = Partial<StatusBadge>;

/**
 * Built-in badges for statuses set by packages this footer knows about. The
 * supplying extension sends text (and may style it itself); this footer adds an
 * icon and a color when it left the text plain. Keys are pi's status keys,
 * matched verbatim, never the package name.
 */
export const DEFAULT_STATUS_BADGES: Record<string, StatusBadge> = {
	// pi-herdr-pstack keeps this key while the sticky poteto methodology is on.
	"pi-herdr-pstack": { icon: "\uf0d0", color: "accent" },
	// pi-telegram colors its own label and state, so only the icon takes the color.
	telegram: { icon: "\uf2c6", color: "accent" },
	// pi-search uses one key for its whole working row: `Search | <model> |
	// think:<level>` while a search runs, and `Docs Search` / `Context7 …` for the
	// docs tools, so one magnifier covers all of them. The text is plain, hence
	// the whole row takes the color; blue keeps it apart from the accent badges.
	search: { icon: "\uf002", color: "mdLink" },
};

/** An icon longer than this is a typo or a whole path, not a glyph. */
const MAX_BADGE_ICON_CODEPOINTS = 4;
const MAX_BADGE_KEY_LENGTH = 64;

/** A badge is text: drop CSI/OSC escapes, then any remaining control character. */
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function cleanBadgeText(value: string): string {
	return value.replace(ESCAPE_SEQUENCE, "").replace(CONTROL_CHARACTERS, "").trim();
}

function normalizeBadges(raw: unknown): Record<string, StatusBadgeOverride> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const badges: [string, StatusBadgeOverride][] = [];
	for (const [key, rawBadge] of Object.entries(raw as Record<string, unknown>)) {
		// Status keys are matched verbatim against `setStatus` keys: a padded or
		// oversized key can only ever miss, so it is dropped instead of rewritten.
		if (!key || key !== key.trim() || key.length > MAX_BADGE_KEY_LENGTH) continue;
		if (!rawBadge || typeof rawBadge !== "object" || Array.isArray(rawBadge)) continue;
		const entry = rawBadge as Record<string, unknown>;
		const badge: StatusBadgeOverride = {};
		if (typeof entry.icon === "string") {
			badge.icon = Array.from(cleanBadgeText(entry.icon)).slice(0, MAX_BADGE_ICON_CODEPOINTS).join("");
		}
		if (typeof entry.color === "string") badge.color = cleanBadgeText(entry.color);
		if (badge.icon === undefined && badge.color === undefined) continue;
		// An entry that ends up empty is how a built-in badge is cleared; for an
		// unknown key it would only add noise.
		const emptied = !badge.icon && !badge.color;
		if (emptied && !Object.hasOwn(DEFAULT_STATUS_BADGES, key)) continue;
		badges.push([key, badge]);
	}
	// fromEntries keeps keys like `__proto__` as own data properties instead of
	// letting the assignment rewrite the prototype.
	return Object.fromEntries(badges);
}

/** Built-in badges with the user's per-field overrides applied. */
export function resolveStatusBadges(
	overrides: Readonly<Record<string, StatusBadgeOverride>> | null | undefined,
): Record<string, StatusBadge> {
	const resolved = new Map<string, StatusBadge>();
	for (const [key, badge] of Object.entries(DEFAULT_STATUS_BADGES)) resolved.set(key, { ...badge });
	for (const [key, override] of Object.entries(overrides ?? {})) {
		const merged: StatusBadge = { ...(resolved.get(key) ?? { icon: "", color: "" }) };
		if (override.icon !== undefined) merged.icon = override.icon;
		if (override.color !== undefined) merged.color = override.color;
		resolved.set(key, merged);
	}
	return Object.fromEntries(resolved);
}

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
const statusBadges = normalizeBadges(source.statusBadges);

	return {
		enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CONFIG.enabled,
		binary,
		timeoutMs: clampInt(source.timeoutMs, DEFAULT_CONFIG.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
		refreshThrottleMs: clampInt(source.refreshThrottleMs, DEFAULT_CONFIG.refreshThrottleMs, MIN_THROTTLE_MS, MAX_TIMEOUT_MS),
		liveRefreshMs: clampLiveRefresh(source.liveRefreshMs, DEFAULT_CONFIG.liveRefreshMs),
		showProvider: typeof source.showProvider === "boolean" ? source.showProvider : DEFAULT_CONFIG.showProvider,
		env,
		statusBadges,
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
