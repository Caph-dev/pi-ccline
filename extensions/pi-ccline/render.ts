// Normalizes ccline stdout into footer lines.
// ccline emits ANSI escapes, so every width decision goes through pi-tui's
// visible-width helpers instead of String.length.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** ccline is asked to wrap at COLUMNS, but a cached frame may still be wider. */
export function normalizeFrame(stdout: string, width: number, ellipsis = "…"): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const lines = stdout.replace(/\r\n?/g, "\n").split("\n");
	while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
		lines.pop();
	}
	return lines.map((line) => (visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, ellipsis) : line));
}

/** Fit a plain notice into the footer width. */
export function noticeFrame(text: string, width: number): string[] {
	return [truncateToWidth(text, Math.max(1, Math.floor(width)))];
}

export function missingBinaryNotice(width: number): string[] {
	return noticeFrame("ccline not found · npm i -g @cometix/ccline · or set binary in ~/.pi/agent/pi-ccline/config.json", width);
}

export function loadingNotice(width: number): string[] {
	return noticeFrame("ccline …", width);
}

/**
 * Extension statuses are single-line by contract; collapse control characters
 * the way pi's built-in footer does before measuring anything.
 */
export function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** The badge fields this module needs; config.ts owns the validated shape. */
export type StatusBadgeLike = { icon?: string | undefined; color?: string | undefined };

export interface StatusLineOptions {
	/** Badges per status key; a key without an entry stays plain text. */
	badges?: Readonly<Record<string, StatusBadgeLike>> | null | undefined;
	/** Theme colorizer for the badge color token; missing or throwing means plain text. */
	colorize?: ((color: string, text: string) => string) | null | undefined;
}

/**
 * A status arrives from another extension as text, and that extension may or
 * may not have colored it. A badge adds an icon and a color. When the text
 * styles itself the badge colors only its own icon, so the sending extension
 * keeps the palette it chose instead of ending up recolored.
 */
function withBadge(key: string, text: string, options: StatusLineOptions): string {
	const badges = options.badges;
	// Own properties only: a status key like `toString` must not resolve to the
	// object's inherited members.
	const badge = badges && Object.hasOwn(badges, key) ? badges[key] : undefined;
	if (!badge) return text;
	const colorize = options.colorize;
	const paint = (target: string): string => {
		if (!badge.color || !colorize) return target;
		try {
			return colorize(badge.color, target);
		} catch {
			// An unknown theme token must not cost the row its text.
			return target;
		}
	};
	if (text.includes("\u001b[")) {
		if (!badge.icon) return text;
		return `${paint(badge.icon)} ${text}`;
	}
	return paint(badge.icon ? `${badge.icon} ${text}` : text);
}

/**
 * pi's built-in footer puts every extension status on one extra row, sorted by
 * key and joined by a space. Mirror that so `ctx.ui.setStatus` keeps working
 * when this footer owns the slot.
 */
export function extensionStatusLine(
	statuses: Iterable<[string, string]> | null | undefined,
	width: number,
	ellipsis = "…",
	options: StatusLineOptions = {},
): string | null {
	if (!statuses) return null;
	const text = [...statuses]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => ({ key, text: sanitizeStatusText(value) }))
		.filter((status) => status.text.length > 0)
		.map((status) => withBadge(status.key, status.text, options))
		.join(" ");
	if (!text) return null;
	const safeWidth = Math.max(1, Math.floor(width));
	return visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, ellipsis) : text;
}

/**
 * Append a status to the last ccline line when the whole status still fits.
 * pi's built-in footer gives statuses a row of their own, which here costs a
 * whole line for a few words. Nothing is cut to make room: a status that does
 * not fit keeps its own row, where the caller truncates it as before.
 */
export function mergeStatusIntoLastLine(lines: string[], status: string | null, width: number): string[] | null {
	if (!status || lines.length === 0) return null;
	const safeWidth = Math.max(1, Math.floor(width));
	if (visibleWidth(status) > safeWidth) return null;
	const last = lines[lines.length - 1] ?? "";
	const merged = `${last} ${status}`;
	if (visibleWidth(merged) > safeWidth) return null;
	return [...lines.slice(0, -1), merged];
}

/**
 * Append a marker to the last line when it still fits. A stale frame is kept
 * visible instead of blanking the footer, and the marker stays opt-in.
 */
export function withStaleMarker(lines: string[], width: number, marker: string): string[] {
	if (lines.length === 0) return lines;
	const safeWidth = Math.max(1, Math.floor(width));
	const last = lines[lines.length - 1] ?? "";
	const markerWidth = visibleWidth(marker);
	if (markerWidth === 0 || visibleWidth(last) + markerWidth > safeWidth) return lines;
	const next = lines.slice();
	next[next.length - 1] = last + marker;
	return next;
}
