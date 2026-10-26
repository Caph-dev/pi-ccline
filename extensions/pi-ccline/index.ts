import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { clearBinaryCache, probeVersion, resolveBinary, spawnCcline, type ResolvedBinary } from "./binary.ts";
import { loadConfig, resolveStatusBadges, saveConfig, type PiCclineConfig, type StatusBadge } from "./config.ts";
import { buildCclineInput, collectSnapshot } from "./input.ts";
import { RefreshScheduler, RefreshTicker } from "./refresh.ts";
import { extensionStatusLine, loadingNotice, missingBinaryNotice, normalizeFrame, noticeFrame, withStaleMarker } from "./render.ts";
import { removeTurnBridge, TurnMeter, writeBridge, type BridgeTool, type TurnTiming } from "./turn.ts";

/** Structural subsets so the footer does not depend on pi-tui internals. */
type TuiLike = { requestRender(force?: boolean): void };
type ThemeLike = { fg(color: string, text: string): string };
type FooterDataLike = {
	onBranchChange(callback: () => void): () => void;
	/** Present on pi >= 1.4; absent on older footers, hence optional. */
	getExtensionStatuses?(): ReadonlyMap<string, string>;
};

/** The slice of a pi message event this extension reads. */
type MessageEventLike = {
	message?: { role?: string | undefined; model?: string | undefined; usage?: { output?: number | undefined } | undefined } | undefined;
};

/** The slice of a pi tool event this extension reads. */
type ToolEventLike = {
	toolCallId?: string | undefined;
	toolName?: string | undefined;
	/** Set when another tool (a codemode script, an agent) made the call. */
	parentToolCallId?: string | undefined;
};

const DEFAULT_WIDTH = 120;

/**
 * Best-effort initial width so the very first refresh wraps like the footer
 * will. render(width) corrects it once pi paints the first frame.
 */
function initialWidth(): number {
	try {
		const columns = process.stdout.columns;
		if (typeof columns === "number" && Number.isFinite(columns) && columns > 0) return Math.floor(columns);
	} catch {
		// not a terminal
	}
	return DEFAULT_WIDTH;
}

function firstLine(text: string): string {
	return (text.split("\n")[0] ?? "").trim().slice(0, 160);
}

/**
 * Owns one footer installation: the cached frame, the single-flight refresh
 * scheduler and the in-flight child process.
 */
export class CclineFooter {
	private readonly ctx: ExtensionContext;
	private readonly config: PiCclineConfig;
	/** Built-in badges with the user's overrides already merged, resolved once. */
	private readonly badges: Record<string, StatusBadge>;
	private readonly scheduler: RefreshScheduler;
	/** Only runs while the agent is active so an idle session spawns nothing. */
	private readonly ticker: RefreshTicker;
	private controller: AbortController | null = null;
	/** Bumped on dispose and on every refresh so late results are dropped. */
	private generation = 0;
	private frame: string[] | null = null;
	private stale = false;
	private lastError: string | null = null;
	private width = initialWidth();
	private theme: ThemeLike | null = null;
	private footerData: FooterDataLike | null = null;
	private requestRenderFn: (() => void) | null = null;
	private branchUnsubscribe: (() => void) | null = null;
	/** Session whose ccline bridge this footer wrote, removed again on dispose. */
	private bridgeSessionId: string | null = null;
	/** The last finished answer, re-sent with every tools update (one file). */
	private lastTiming: TurnTiming | null = null;
	/** Tool calls running now, keyed by pi's tool call id. */
	private readonly runningTools = new Map<string, BridgeTool>();
	private readonly meter = new TurnMeter();
	private disposed = false;

	readonly stats = {
		refreshes: 0,
		lastRefreshAt: null as number | null,
		lastDurationMs: null as number | null,
		lastTps: null as number | null,
	};
	resolved: ResolvedBinary = { path: null, source: "missing" };

	constructor(ctx: ExtensionContext, config: PiCclineConfig) {
		this.ctx = ctx;
		this.config = config;
		this.badges = resolveStatusBadges(config.statusBadges);
		this.scheduler = new RefreshScheduler({
			throttleMs: config.refreshThrottleMs,
			task: () => this.refresh(),
		});
		this.ticker = new RefreshTicker({
			intervalMs: config.liveRefreshMs,
			onTick: () => this.requestRefresh(),
		});
	}

	/** Called by pi with the live TUI, theme and footer data. */
	attach(tui: TuiLike, theme: ThemeLike, footerData: FooterDataLike) {
		this.theme = theme;
		this.footerData = footerData;
		this.requestRenderFn = () => tui.requestRender();
		try {
			this.branchUnsubscribe = footerData.onBranchChange(() => {
				this.requestRefresh();
				tui.requestRender();
			});
		} catch {
			this.branchUnsubscribe = null;
		}
		this.requestRefresh();
		// The footer can be installed (or re-enabled) in the middle of a run, when
		// no agent_start will arrive until the next one. Start ticking right away.
		if (!this.agentIsIdle()) this.startLive();

		return {
			dispose: () => this.dispose(),
			invalidate: () => this.requestRefresh(),
			render: (width: number) => this.render(width),
		};
	}

	/** Coalesced, throttled refresh request. Never starts work synchronously. */
	requestRefresh(): void {
		if (this.disposed) return;
		this.scheduler.request();
	}

	/**
	 * Start ticking so time-based segments (elapsed duration) stay live.
	 * Called when an agent run starts; idempotent.
	 */
	startLive(): void {
		if (this.disposed) return;
		this.ticker.start();
	}

	stopLive(): void {
		this.ticker.stop();
	}

	/** Idle unless pi says otherwise; an unreadable state must not start a timer. */
	private agentIsIdle(): boolean {
		try {
			return this.ctx.isIdle();
		} catch {
			return true;
		}
	}

	get error(): string | null {
		return this.lastError;
	}

	/** The session pi reports, or null when it cannot be read or is unusable. */
	private sessionId(): string | null {
		try {
			const id = this.ctx.sessionManager.getSessionId?.();
			return typeof id === "string" && id.trim() ? id.trim() : null;
		} catch {
			return null;
		}
	}

	/** A model request went out: start timing until its answer finishes. */
	onMessageStart(event: MessageEventLike): void {
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		// Stream start, not send time: pi begins the stream once the provider has
		// answered, so this ttft stops short of the connect wait by design.
		this.meter.start(message.model, performance.now());
	}

	/**
	 * A content block of that answer arrived (`text_start` / `*_delta` /
	 * `toolcall_*`; pi emits no metadata through this event), so the clock for
	 * the streaming rate starts at the first sign of content.
	 */
	onMessageUpdate(event: MessageEventLike): void {
		if (event.message?.role !== "assistant") return;
		this.meter.firstDelta(performance.now());
	}

	/**
	 * Rewrite the bridge with everything it has to carry: the last answer's
	 * timing and the tools running now (ccline reads both from one file, so a
	 * writer that sent only one of them would blank the other segment).
	 */
	private flushBridge(): void {
		const sessionId = this.sessionId();
		if (!sessionId) return;
		const tools = [...this.runningTools.values()];
		if (!this.lastTiming && tools.length === 0) return;
		if (!writeBridge({ sessionId, timing: this.lastTiming ?? undefined, tools, nowMs: Date.now() })) return;
		if (this.bridgeSessionId && this.bridgeSessionId !== sessionId) removeTurnBridge(this.bridgeSessionId);
		this.bridgeSessionId = sessionId;
	}

	/**
	 * The answer finished: hand ccline its timing through the bridge file it
	 * reads for `timing.tps`. No speed, no file.
	 */
	onMessageEnd(event: MessageEventLike): void {
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		// Measurement uses the monotonic clock; only the bridge's freshness
		// stamp is wall-clock, and the two are never mixed.
		const timing = this.meter.finish(message.usage?.output, performance.now());
		if (!timing) return;
		this.lastTiming = timing;
		this.stats.lastTps = timing.tps;
		this.flushBridge();
		// The new speed only shows up in the next frame; let the throttle coalesce it.
		this.requestRefresh();
	}

	/**
	 * A tool started: `activity.tools` shows it until `onToolEnd`. Nested calls
	 * (codemode, tools calling tools) are skipped — a script would otherwise
	 * flood the segment with names the user never issued.
	 */
	onToolStart(event: ToolEventLike): void {
		const id = event.toolCallId;
		const name = event.toolName;
		if (!id || !name || event.parentToolCallId) return;
		this.runningTools.set(id, { name, since: Date.now() });
		this.flushBridge();
		this.requestRefresh();
	}

	onToolEnd(event: ToolEventLike): void {
		const id = event.toolCallId;
		if (!id || !this.runningTools.delete(id)) return;
		this.flushBridge();
		this.requestRefresh();
	}

	/**
	 * An aborted run can end without a matching `tool_execution_end`, and no
	 * tool can outlive the run, so drop the rest rather than show a tool that
	 * keeps counting up forever.
	 */
	clearRunningTools(): void {
		if (this.runningTools.size === 0) return;
		this.runningTools.clear();
		this.flushBridge();
	}

	get hasFrame(): boolean {
		return this.frame !== null;
	}

	private render(width: number): string[] {
		const requested = Math.floor(width);
		const safeWidth = Math.max(1, requested || this.width);
		// The width is only known during a render pass. Record it and let the
		// scheduler wrap it into a later refresh; never spawn from here.
		if (requested > 0 && requested !== this.width) {
			this.width = requested;
			this.requestRefresh();
		}

		const frame = this.frame;
		const lines = frame
			? (() => {
					const fitted = frame.map((line) => (visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth) : line));
					return this.stale && this.theme ? withStaleMarker(fitted, safeWidth, this.theme.fg("dim", " ·stale")) : fitted;
				})()
			: loadingNotice(safeWidth);

		// Read live: pi repaints on setStatus, so no subscription is needed and a
		// status change shows up on the next frame even while ccline is throttled.
		const statuses = (() => {
			try {
				return this.footerData?.getExtensionStatuses?.() ?? null;
			} catch {
				return null;
			}
		})();
		const status = extensionStatusLine(statuses, safeWidth, this.theme ? this.theme.fg("dim", "…") : "…", {
			badges: this.badges,
			// render.ts catches a throwing token, so a stale theme entry costs only its color.
			colorize: this.theme ? (color, text) => this.theme?.fg(color, text) ?? text : null,
		});
		return status ? [...lines, status] : lines;
	}

	private applyFrame(lines: string[], stale: boolean, error: string | null): void {
		this.frame = lines;
		this.stale = stale;
		this.lastError = error;
		this.requestRenderFn?.();
	}

	private async refresh(): Promise<void> {
		if (this.disposed) return;
		const generation = ++this.generation;
		const startedAt = Date.now();
		const binary = resolveBinary(this.config.binary);
		this.resolved = binary;

		if (!binary.path) {
			this.applyFrame(missingBinaryNotice(this.width), false, "ccline binary not found");
			return;
		}

		this.controller?.abort();
		const controller = new AbortController();
		this.controller = controller;

		const snapshot = collectSnapshot(this.ctx, Date.now());
		const payload = JSON.stringify(buildCclineInput(snapshot, { showProvider: this.config.showProvider }));

		const result = await spawnCcline({
			binary: binary.path,
			payload,
			timeoutMs: this.config.timeoutMs,
			columns: this.width,
			env: this.config.env,
			signal: controller.signal,
		});

		// A newer refresh or a dispose superseded this run; drop its result.
		if (this.disposed || generation !== this.generation) return;
		this.controller = null;
		this.stats.lastRefreshAt = Date.now();
		this.stats.lastDurationMs = Date.now() - startedAt;

		if (result.ok) {
			const lines = normalizeFrame(result.stdout, this.width);
			if (lines.length > 0) {
				this.stats.refreshes += 1;
				this.applyFrame(lines, false, null);
				return;
			}
		}

		const reason = result.aborted
			? "aborted"
			: result.timedOut
				? `timed out after ${this.config.timeoutMs}ms`
				: result.error
					? result.error
					: `exited with code ${result.code}${result.stderr.trim() ? `: ${firstLine(result.stderr)}` : ""}`;

		if (this.frame) {
			// Keep the last good frame and only mark it stale.
			this.applyFrame(this.frame, true, reason);
		} else {
			this.applyFrame(noticeFrame(`ccline failed: ${reason}`, this.width), false, reason);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation += 1;
		this.ticker.stop();
		this.scheduler.dispose();
		this.controller?.abort();
		this.controller = null;
		try {
			this.branchUnsubscribe?.();
		} catch {
			// ignore
		}
		this.branchUnsubscribe = null;
		this.footerData = null;
		this.requestRenderFn = null;
		this.runningTools.clear();
		if (this.bridgeSessionId) removeTurnBridge(this.bridgeSessionId);
		this.bridgeSessionId = null;
	}
}

/** Optional seams so the extension lifecycle can be tested without a real session. */
export interface PiCclineDeps {
	loadConfig?: () => PiCclineConfig;
}

export default function piCcline(pi: ExtensionAPI, deps: PiCclineDeps = {}) {
	let footer: CclineFooter | null = null;
	const readConfig = deps.loadConfig ?? (() => loadConfig());

	const teardown = () => {
		footer?.dispose();
		footer = null;
	};

	/** Install the footer for the current session. Returns false when it does not apply. */
	const install = (ctx: ExtensionContext): boolean => {
		teardown();
		if (ctx.mode !== "tui" || !ctx.hasUI) return false;
		const config = readConfig();
		if (!config.enabled) return false;
		const next = new CclineFooter(ctx, config);
		ctx.ui.setFooter((tui, theme, footerData) => next.attach(tui, theme, footerData));
		footer = next;
		return true;
	};

	const requestRefresh = () => footer?.requestRefresh();

	// Processes, timers and the footer only start from a session, never from the
	// extension factory (some invocations load extensions without a session).
	pi.on("session_start", (_event, ctx) => {
		install(ctx);
	});
	pi.on("turn_start", () => {
		requestRefresh();
		// Covers a footer installed while a run was already in progress.
		footer?.startLive();
	});
	pi.on("turn_end", () => requestRefresh());
	// An agent run can contain many turns and can sit inside one turn for a long
	// time, so events alone leave the elapsed segment frozen. Tick while the run
	// is active and stop again when it settles.
	pi.on("agent_start", () => footer?.startLive());
	pi.on("agent_end", () => {
		requestRefresh();
		footer?.stopLive();
		// No tool can survive the run, even when an abort skipped its end event.
		footer?.clearRunningTools();
	});
	pi.on("agent_settled", () => {
		footer?.stopLive();
		footer?.clearRunningTools();
	});
	pi.on("model_select", () => requestRefresh());
	pi.on("thinking_level_select", () => requestRefresh());
	pi.on("session_info_changed", () => requestRefresh());
	// Per-request timing is not in the statusline payload, so it is measured
	// from the stream and written to ccline's bridge file when an answer ends.
	pi.on("message_start", (event) => footer?.onMessageStart(event as MessageEventLike));
	pi.on("message_update", (event) => footer?.onMessageUpdate(event as MessageEventLike));
	pi.on("message_end", (event) => footer?.onMessageEnd(event as MessageEventLike));
	// Same bridge: `activity.tools` lists what is still running.
	pi.on("tool_execution_start", (event) => footer?.onToolStart(event as ToolEventLike));
	pi.on("tool_execution_end", (event) => footer?.onToolEnd(event as ToolEventLike));
	pi.on("session_shutdown", () => teardown());

	pi.registerCommand("pi-ccline", {
		description: "ccline footer: on | off | status | path",
		handler: async (args, ctx) => {
			const subcommand = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

			if (subcommand === "on") {
				if (!saveConfig({ ...loadConfig(), enabled: true })) {
					ctx.ui.notify("pi-ccline: could not write config.json", "warning");
				}
				clearBinaryCache();
				if (install(ctx)) ctx.ui.notify("pi-ccline footer enabled", "info");
				else ctx.ui.notify("pi-ccline: footer needs interactive (tui) mode", "warning");
				return;
			}

			if (subcommand === "off") {
				saveConfig({ ...loadConfig(), enabled: false });
				teardown();
				if (ctx.hasUI) ctx.ui.setFooter(undefined);
				ctx.ui.notify("pi-ccline footer disabled", "info");
				return;
			}

			if (subcommand === "path") {
				const config = loadConfig();
				const binary = resolveBinary(config.binary);
				if (!binary.path) {
					ctx.ui.notify(
						"ccline not found\nlooked at: config.binary, ~/.claude/ccline/ccline, PATH\ninstall: npm i -g @cometix/ccline",
						"warning",
					);
					return;
				}
				const version = await probeVersion(binary.path, config.timeoutMs);
				ctx.ui.notify(`${binary.path}\nsource: ${binary.source}\nversion: ${version ?? "unknown"}`, "info");
				return;
			}

			if (subcommand !== "" && subcommand !== "status") {
				ctx.ui.notify("usage: /pi-ccline on | off | status | path", "warning");
				return;
			}

			const config = loadConfig();
			const binary = footer?.resolved ?? resolveBinary(config.binary);
			const lines = [
				`enabled: ${config.enabled ? "yes" : "no"} · mode: ${ctx.mode}`,
				`binary: ${binary.path ?? "not found"}${binary.path ? ` (${binary.source})` : ""}`,
				`timeout: ${config.timeoutMs}ms · throttle: ${config.refreshThrottleMs}ms`,
				`live: ${config.liveRefreshMs > 0 ? `${config.liveRefreshMs}ms while the agent runs` : "off"}`,
			];
			if (footer) {
				const { refreshes, lastRefreshAt, lastDurationMs } = footer.stats;
				lines.push(`refreshes: ${refreshes} · last: ${lastRefreshAt === null ? "never" : `${Math.round((Date.now() - lastRefreshAt) / 1000)}s ago`}`);
				lines.push(`duration: ${lastDurationMs === null ? "n/a" : `${lastDurationMs}ms`} · frame: ${footer.hasFrame ? "cached" : "none"}`);
				lines.push(`last answer: ${footer.stats.lastTps === null ? "not measured yet" : `${footer.stats.lastTps.toFixed(1)} tok/s`}`);
				lines.push(`state: ${footer.error ? `stale — ${footer.error}` : "ok"}`);
			} else {
				lines.push("state: footer not installed");
			}
			ctx.ui.notify(lines.join("\n"), footer?.error ? "warning" : "info");
		},
	});
}
