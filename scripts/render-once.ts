// Render one ccline frame from a fixture, for manual acceptance checks.
//
//   node --experimental-strip-types scripts/render-once.ts
//   node --experimental-strip-types scripts/render-once.ts --fixture fixtures/basic.json --width 120 --width 40
//
// Runs the real binary (no model call, no pi session) and prints both the raw
// ANSI bytes and the footer lines pi would receive.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { visibleWidth } from "@earendil-works/pi-tui";

import { clearBinaryCache, probeVersion, resolveBinary, spawnCcline } from "../extensions/pi-ccline/binary.ts";
import { configPath, loadConfig } from "../extensions/pi-ccline/config.ts";
import { normalizeFrame } from "../extensions/pi-ccline/render.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
	fixture: string;
	binary: string | null;
	widths: number[];
	timeoutMs: number;
	raw: boolean;
	home: string;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		fixture: resolve(packageRoot, "fixtures/basic.json"),
		binary: null,
		widths: [],
		timeoutMs: 5000,
		raw: false,
		home: homedir(),
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			index += 1;
			const value = argv[index];
			if (value === undefined) throw new Error(`missing value for ${arg}`);
			return value;
		};
		switch (arg) {
			case "--fixture":
				options.fixture = resolve(process.cwd(), next());
				break;
			case "--binary":
				options.binary = resolve(process.cwd(), next());
				break;
			case "--width":
				options.widths.push(Number(next()));
				break;
			case "--timeout":
				options.timeoutMs = Number(next());
				break;
			case "--home":
				// Isolate both config lookup and the child process (~/.claude writes).
				options.home = resolve(process.cwd(), next());
				break;
			case "--raw":
				options.raw = true;
				break;
			case "--help":
			case "-h":
				console.log(
					[
						"usage: render-once.ts [--fixture <path>] [--binary <path>] [--width <cols>]...",
						"                     [--timeout <ms>] [--home <dir>] [--raw]",
						"",
						"Without --width the fixture renders at 120 and 40 columns.",
					].join("\n"),
				);
				process.exit(0);
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}

	if (options.widths.length === 0) options.widths = [120, 40];
	for (const width of options.widths) {
		if (!Number.isFinite(width) || width < 1) throw new Error(`invalid width: ${width}`);
	}
	return options;
}

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2));
	const fixtureText = readFileSync(options.fixture, "utf8");
	const payload = JSON.stringify(JSON.parse(fixtureText));
	const config = loadConfig(configPath(options.home));

	clearBinaryCache();
	const resolved = options.binary ? { path: options.binary, source: "config" as const } : resolveBinary(config.binary, { home: options.home });

	console.log(`fixture: ${options.fixture}`);
	if (!resolved.path) {
		console.error("ccline not found. Looked at config.binary, ~/.claude/ccline/ccline and PATH.");
		console.error("install: npm i -g @cometix/ccline   (or pass --binary <path>)");
		return 1;
	}

	const version = await probeVersion(resolved.path, options.timeoutMs);
	console.log(`binary:  ${resolved.path} (${resolved.source})`);
	console.log(`home:    ${options.home}`);
	console.log(`version: ${version ?? "unknown"}`);

	const childEnv: Record<string, string> = { ...config.env, HOME: options.home, USERPROFILE: options.home };

	let failures = 0;
	for (const width of options.widths) {
		const result = await spawnCcline({
			binary: resolved.path,
			payload,
			timeoutMs: options.timeoutMs,
			columns: width,
			env: childEnv,
		});

		console.log("");
		console.log(`--- width ${width} ---`);
		if (result.timedOut) {
			console.error(`timed out after ${options.timeoutMs}ms`);
			failures += 1;
			continue;
		}
		if (!result.ok) {
			console.error(`failed: ${result.error ?? `exit ${result.code}`}${result.stderr.trim() ? `\n${result.stderr.trim()}` : ""}`);
			failures += 1;
			continue;
		}
		if (options.raw) console.log(`raw: ${JSON.stringify(result.stdout)}`);

		const lines = normalizeFrame(result.stdout, width);
		if (lines.length === 0) {
			console.error("empty output");
			failures += 1;
			continue;
		}
		for (const [index, line] of lines.entries()) {
			console.log(`[${index}] w=${visibleWidth(line)} ${line}`);
		}
		const overflow = lines.filter((line) => visibleWidth(line) > width);
		if (overflow.length > 0) {
			console.error(`width contract violated: ${overflow.length} line(s) wider than ${width}`);
			failures += 1;
		}
	}

	return failures === 0 ? 0 : 1;
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
