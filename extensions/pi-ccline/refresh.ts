// Single-flight, throttled refresh scheduler.
// The footer's render(width) runs on every repaint, so refresh work must never
// start synchronously from there: request() always defers to a timer, and at
// most one task runs at a time. Extra requests made while a task is running
// collapse into one follow-up run that reads the latest state (latest wins).

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface RefreshSchedulerOptions {
	/** Minimum delay between two starts. Callers pass a value already clamped to >= 1000. */
	throttleMs: number;
	task: () => Promise<void>;
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
}

export interface RefreshTickerOptions {
	/** 0 (or any non-positive value) disables ticking. */
	intervalMs: number;
	onTick: () => void;
	setInterval?: (callback: () => void, delayMs: number) => TimerHandle;
	clearInterval?: (handle: TimerHandle) => void;
}

/**
 * Drives time-based parts of the footer. Event-driven refreshes cannot advance
 * a clock, so while the agent runs a fixed interval asks the scheduler for a
 * fresh frame. stop() only clears the timer: a request already queued in the
 * scheduler may still land once, and nothing is scheduled after that.
 */
export class RefreshTicker {
	private readonly intervalMs: number;
	private readonly onTick: () => void;
	private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;
	private handle: TimerHandle | null = null;

	constructor(options: RefreshTickerOptions) {
		this.intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 0;
		this.onTick = options.onTick;
		this.setTimer = options.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
		this.clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle));
	}

	get isRunning(): boolean {
		return this.handle !== null;
	}

	/** Idempotent: a second start does not stack another interval. */
	start(): void {
		if (this.handle !== null || this.intervalMs <= 0) return;
		this.handle = this.setTimer(() => {
			// The scheduler reports its own failures; a throw must not kill the timer.
			try {
				this.onTick();
			} catch {
				// ignore
			}
		}, this.intervalMs);
	}

	stop(): void {
		if (this.handle === null) return;
		this.clearTimer(this.handle);
		this.handle = null;
	}
}

export class RefreshScheduler {
	private readonly throttleMs: number;
	private readonly task: () => Promise<void>;
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;

	private timer: TimerHandle | null = null;
	private pending = false;
	private running = false;
	private disposed = false;
	private lastRunAt = Number.NEGATIVE_INFINITY;

	/** Number of task runs; used by tests and `/pi-ccline status`. */
	runs = 0;

	constructor(options: RefreshSchedulerOptions) {
		this.throttleMs = Number.isFinite(options.throttleMs) ? Math.max(0, options.throttleMs) : 0;
		this.task = options.task;
		this.now = options.now ?? (() => Date.now());
		this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
	}

	get isRunning(): boolean {
		return this.running;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	/** Ask for a refresh. Safe to call from a render pass: it never runs the task inline. */
	request(): void {
		if (this.disposed) return;
		this.pending = true;
		this.arm();
	}

	dispose(): void {
		this.disposed = true;
		this.pending = false;
		if (this.timer !== null) {
			this.clearTimer(this.timer);
			this.timer = null;
		}
	}

	private arm(): void {
		if (this.disposed || this.running || this.timer !== null || !this.pending) return;
		const elapsed = this.now() - this.lastRunAt;
		const delay = elapsed >= this.throttleMs ? 0 : Math.max(0, this.throttleMs - elapsed);
		this.timer = this.setTimer(() => {
			this.timer = null;
			void this.flush();
		}, delay);
	}

	private async flush(): Promise<void> {
		if (this.disposed || this.running || !this.pending) return;
		this.pending = false;
		this.running = true;
		this.lastRunAt = this.now();
		this.runs += 1;
		try {
			await this.task();
		} catch {
			// The task reports its own failures through the frame; a throw must not
			// leave the scheduler stuck in the running state.
		} finally {
			this.running = false;
		}
		if (this.disposed) return;
		this.arm();
	}
}
