import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { clearBinaryCache, probeVersion, resolveBinary, spawnCcline, type ResolvedBinary } from "./binary.ts";
import { loadConfig, saveConfig, type PiCclineConfig } from "./config.ts";
import { buildCclineInput, collectSnapshot } from "./input.ts";
import { RefreshScheduler, RefreshTicker } from "./refresh.ts";
import { extensionStatusLine, loadingNotice, missingBinaryNotice, normalizeFrame, noticeFrame, withStaleMarker } from "./render.ts";

/** Structural subsets so the footer does not depend on pi-tui internals. */
type TuiLike = { requestRender(force?: boolean): void };
type ThemeLike = { fg(color: string, text: string): string };
type FooterDataLike = {
	onBranchChange(callback: () => void): () => void;
	/** Present on pi >= 1.4; absent on older footers, hence optional. */
	getExtensionStatuses?(): ReadonlyMap<string, string>;
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
	private disposed = false;

	readonly stats = {
		refreshes: 0,
		lastRefreshAt: null as number | null,
		lastDurationMs: null as number | null,
	};
	resolved: ResolvedBinary = { path: null, source: "missing" };

	constructor(ctx: ExtensionContext, config: PiCclineConfig) {
		this.ctx = ctx;
		this.config = config;
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
		const status = extensionStatusLine(statuses, safeWidth, this.theme ? this.theme.fg("dim", "…") : "…");
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
	});
	pi.on("agent_settled", () => footer?.stopLive());
	pi.on("model_select", () => requestRefresh());
	pi.on("thinking_level_select", () => requestRefresh());
	pi.on("session_info_changed", () => requestRefresh());
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
				lines.push(`state: ${footer.error ? `stale — ${footer.error}` : "ok"}`);
			} else {
				lines.push("state: footer not installed");
			}
			ctx.ui.notify(lines.join("\n"), footer?.error ? "warning" : "info");
		},
	});
}
