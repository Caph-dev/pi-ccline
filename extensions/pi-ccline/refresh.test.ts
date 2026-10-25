import assert from "node:assert/strict";
import { test } from "node:test";

import { RefreshScheduler, RefreshTicker, type TimerHandle } from "./refresh.ts";

/** Deterministic clock plus a manual timer queue. */
class FakeClock {
	time = 0;
	private nextId = 1;
	private timers = new Map<number, { at: number; callback: () => void }>();

	now = (): number => this.time;

	setTimer = (callback: () => void, delayMs: number): TimerHandle => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.time + delayMs, callback });
		return id as unknown as TimerHandle;
	};

	clearTimer = (handle: TimerHandle): void => {
		this.timers.delete(handle as unknown as number);
	};

	get pending(): number {
		return this.timers.size;
	}

	/** Advance time and fire due timers, letting awaited microtasks settle. */
	async advance(ms: number): Promise<void> {
		const target = this.time + ms;
		for (;;) {
			await flush();
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			const [id, timer] = due;
			this.timers.delete(id);
			this.time = Math.max(this.time, timer.at);
			timer.callback();
		}
		this.time = Math.max(this.time, target);
		await flush();
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function makeScheduler(clock: FakeClock, task: () => Promise<void>, throttleMs = 1000) {
	return new RefreshScheduler({ throttleMs, task, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
}

/** Deterministic clock for interval timers; unlike FakeClock they fire repeatedly. */
class FakeIntervalClock {
	time = 0;
	private nextId = 1;
	private timers = new Map<number, { every: number; at: number; callback: () => void }>();

	setInterval = (callback: () => void, delayMs: number): TimerHandle => {
		const id = this.nextId++;
		this.timers.set(id, { every: Math.max(1, delayMs), at: this.time + delayMs, callback });
		return id as unknown as TimerHandle;
	};

	clearInterval = (handle: TimerHandle): void => {
		this.timers.delete(handle as unknown as number);
	};

	get pending(): number {
		return this.timers.size;
	}

	async advance(ms: number): Promise<void> {
		const target = this.time + ms;
		for (;;) {
			await flush();
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			const [id, timer] = due;
			this.time = Math.max(this.time, timer.at);
			timer.at += timer.every;
			timer.callback();
			if (!this.timers.has(id)) continue;
		}
		this.time = Math.max(this.time, target);
		await flush();
	}
}

function makeTicker(clock: FakeIntervalClock, intervalMs: number, onTick: () => void) {
	return new RefreshTicker({ intervalMs, onTick, setInterval: clock.setInterval, clearInterval: clock.clearInterval });
}

test("the ticker asks for a refresh once per interval", async () => {
	const clock = new FakeIntervalClock();
	let ticks = 0;
	const ticker = makeTicker(clock, 1000, () => {
		ticks += 1;
	});

	ticker.start();
	assert.equal(ticks, 0, "starting must not tick immediately");
	await clock.advance(3500);
	assert.equal(ticks, 3);
	ticker.stop();
});

test("starting twice does not stack intervals and stopping halts them", async () => {
	const clock = new FakeIntervalClock();
	let ticks = 0;
	const ticker = makeTicker(clock, 1000, () => {
		ticks += 1;
	});

	ticker.start();
	ticker.start();
	assert.equal(clock.pending, 1);
	await clock.advance(2000);
	assert.equal(ticks, 2);

	ticker.stop();
	assert.equal(clock.pending, 0);
	await clock.advance(5000);
	assert.equal(ticks, 2, "no ticks after stop");
});

test("a zero interval never starts a timer", async () => {
	const clock = new FakeIntervalClock();
	let ticks = 0;
	const ticker = makeTicker(clock, 0, () => {
		ticks += 1;
	});

	ticker.start();
	assert.equal(ticker.isRunning, false);
	assert.equal(clock.pending, 0);
	await clock.advance(10_000);
	assert.equal(ticks, 0);
});

test("a throwing tick does not kill the ticker", async () => {
	const clock = new FakeIntervalClock();
	let ticks = 0;
	const ticker = makeTicker(clock, 1000, () => {
		ticks += 1;
		throw new Error("boom");
	});

	ticker.start();
	await clock.advance(2500);
	assert.equal(ticks, 2);
	ticker.stop();
});

test("request never runs the task synchronously", async () => {
	const clock = new FakeClock();
	let runs = 0;
	const scheduler = makeScheduler(clock, async () => {
		runs += 1;
	});

	scheduler.request();
	assert.equal(runs, 0, "render passes must not spawn inline");

	await clock.advance(0);
	assert.equal(runs, 1);
	scheduler.dispose();
});

test("a burst of requests collapses into one run", async () => {
	const clock = new FakeClock();
	let runs = 0;
	const scheduler = makeScheduler(clock, async () => {
		runs += 1;
	});

	scheduler.request();
	scheduler.request();
	scheduler.request();
	await clock.advance(0);
	assert.equal(runs, 1);
	scheduler.dispose();
});

test("requests during a run collapse into a single follow-up that sees latest state", async () => {
	const clock = new FakeClock();
	const gate = deferred();
	let runs = 0;
	let observed = -1;
	let state = 0;
	const scheduler = makeScheduler(clock, async () => {
		runs += 1;
		observed = state;
		if (runs === 1) await gate.promise;
	});

	scheduler.request();
	await clock.advance(0);
	assert.equal(runs, 1);

	state = 1;
	scheduler.request();
	state = 2;
	scheduler.request();
	state = 3;
	scheduler.request();
	assert.equal(runs, 1, "still single-flight");

	gate.resolve();
	await clock.advance(1000);
	assert.equal(runs, 2);
	assert.equal(observed, 3, "latest wins");
	scheduler.dispose();
});

test("refreshes stay at least throttleMs apart", async () => {
	const clock = new FakeClock();
	const starts: number[] = [];
	const scheduler = makeScheduler(clock, async () => {
		starts.push(clock.time);
	});

	scheduler.request();
	await clock.advance(0);
	assert.deepEqual(starts, [0]);

	// Immediate second request has to wait for the throttle window.
	await clock.advance(100);
	scheduler.request();
	await clock.advance(100);
	assert.deepEqual(starts, [0], "not yet");

	await clock.advance(800);
	assert.deepEqual(starts, [0, 1000]);
	scheduler.dispose();
});

test("dispose stops pending and future runs", async () => {
	const clock = new FakeClock();
	let runs = 0;
	const scheduler = makeScheduler(clock, async () => {
		runs += 1;
	});

	scheduler.request();
	scheduler.dispose();
	await clock.advance(5000);
	assert.equal(runs, 0);
	assert.equal(clock.pending, 0);

	scheduler.request();
	await clock.advance(5000);
	assert.equal(runs, 0);
});

test("a throwing task does not wedge the scheduler", async () => {
	const clock = new FakeClock();
	let runs = 0;
	const scheduler = makeScheduler(clock, async () => {
		runs += 1;
		throw new Error("boom");
	});

	scheduler.request();
	await clock.advance(0);
	assert.equal(runs, 1);
	assert.equal(scheduler.isRunning, false);

	scheduler.request();
	await clock.advance(1000);
	assert.equal(runs, 2);
	scheduler.dispose();
});
