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

/**
 * pi's built-in footer puts every extension status on one extra row, sorted by
 * key and joined by a space. Mirror that so `ctx.ui.setStatus` keeps working
 * when this footer owns the slot.
 */
export function extensionStatusLine(
	statuses: Iterable<[string, string]> | null | undefined,
	width: number,
	ellipsis = "…",
): string | null {
	if (!statuses) return null;
	const text = [...statuses]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, value]) => sanitizeStatusText(value))
		.filter((value) => value.length > 0)
		.join(" ");
	if (!text) return null;
	const safeWidth = Math.max(1, Math.floor(width));
	return visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, ellipsis) : text;
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
