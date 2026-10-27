# pi-ccline

English | [简体中文](./README_zh.md)

Hands pi's footer over to upstream [CCometixLine](https://github.com/Haleclipse/CCometixLine) (`ccline`) to render.

This extension does no rendering itself: it collects state from the pi session, assembles it into JSON shaped like Claude Code's `statusLine` input, feeds it to the `ccline` binary's stdin, and shows its stdout as the footer. Colors, themes, icons and wrapping are all decided upstream; when upstream upgrades or changes a theme, nothing here needs to follow.

```
pi session state → buildCclineInput() → JSON → ccline (spawn, COLUMNS=current width) → ANSI line → footer
```

## What it shows

| What you see | Where it comes from |
|---|---|
| Model name (with provider) | `ctx.model` (`display_name` takes `model.name`, falling back to `model.id`; when `showProvider` is true it appends ` (provider)`, e.g. `Sonnet 4.5 (anthropic)`) |
| Reasoning effort | `ctx.thinkingLevel` → `effort.level` |
| Working directory | `ctx.cwd` → `cwd` / `workspace.current_dir` |
| Context percentage / token count | `ctx.getContextUsage()` → current context (the aggregate estimate); **no lifetime session tokens are sent** |
| Prompt-cache hit share | assistant messages' `usage.cacheRead` over `input + cacheRead + cacheWrite`, summed over the branch → `prompt_cache.hit_ratio`; sent from the second request on |
| Output speed (`tok/s`) | measured from `message_start` → first `message_update` → `message_end`, written to ccline's `bridge/<session>.json` for its `timing.tps` metric |
| Running tools | `tool_execution_start` / `tool_execution_end` → the same bridge file's `tools` array, for ccline's `activity.tools` metric |
| Cost, session duration | assistant messages' `usage.cost.total` summed; duration = now − earliest entry on the branch |
| Session id / name | `ctx.sessionManager` |
| git branch and anything else ccline probes itself | ccline reads the disk itself |
| Status lines from other extensions | `footerData.getExtensionStatuses()`, sorted by key into one line below the ccline frame |

Not shown, and never fabricated: the 5h / 7d quota segment (pi has no `rate_limits` source, the field is omitted, and the segment disappears by itself), and the cache warmth / TTL / miss-cause fields (pi knows neither the provider's cache expiry nor why a cache was rebuilt, so only the hit share is sent and ccline is left to hide the rest).

## Installation

Start with the external binary (the extension ships no renderer, so this is required):

```sh
npm i -g @cometix/ccline
# or drop a single copy at ~/.claude/ccline/ccline
```

**Verified against ccline 2.0.1.** Older 1.1.x treats `model` / `workspace` / `transcript_path` as required fields and exits non-zero with
`missing field ...` on the input built here (the footer then stays on its previous frame and is marked stale), so upgrade first.

Then install the pi package (pick one):

```sh
# install from npm for real (writes ~/.pi/agent/settings.json)
pi install npm:@caph42/pi-ccline

# try it from npm once, without touching settings.json
pi -e npm:@caph42/pi-ccline

# try / install from local source (run in the package root)
pi -e .
pi install .
```

After startup the footer is whatever ccline renders. Your terminal needs Nerd Font v3+ to show the icons; ccline themes with `style.mode = "plain"` degrade to emoji.

## Commands

| Command | Effect |
|---|---|
| `/pi-ccline on` | Turn the footer on (writes config, takes effect immediately) |
| `/pi-ccline off` | Turn it off and restore pi's built-in footer (writes config) |
| `/pi-ccline status` | Enabled state, mode, resolved binary, throttle / timeout / live refresh, refresh count, whether the last frame is stale |
| `/pi-ccline path` | Resolved binary path, its source (config/home/path) and `ccline --version` |

## Configuration

`~/.pi/agent/pi-ccline/config.json` (a missing file, broken JSON or wrongly typed fields all fall back to the defaults silently):

```json
{
  "enabled": true,
  "binary": null,
  "timeoutMs": 5000,
  "refreshThrottleMs": 1000,
  "liveRefreshMs": 1000,
  "showProvider": true,
  "env": {},
  "statusBadges": {}
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether to install the footer when a session starts |
| `binary` | `null` | Explicit ccline path; `null` follows the resolution order below. A path that doesn't exist falls back silently |
| `timeoutMs` | `5000` | Hard timeout per invocation (200–60000) |
| `refreshThrottleMs` | `1000` | Minimum interval between refreshes; anything below 1000 is raised to 1000 |
| `liveRefreshMs` | `1000` | Interval of the timer that refreshes while the agent runs (so `duration` ticks every second); `0` disables the timer and leaves only event-driven refreshes. When non-zero, anything below 250 is raised to 250 |
| `showProvider` | `true` | Whether to append the provider to the model segment, e.g. `Sonnet 4.5 (anthropic)`; `false` shows just the model name. Below 80 columns the suffix is dropped regardless, to leave room on ccline's wrapped lines; this switch only decides whether a wide footer shows it at all |
| `env` | `{}` | Extra environment variables for ccline; same-named variables override the values inherited from pi (except `COLUMNS`, which the extension writes from the current width) |
| `statusBadges` | `{}` | Icons and colors for the status row other extensions set through `ctx.ui.setStatus`, shaped `{"<status key>": {"icon": "<glyph>", "color": "<theme token>"}}`. Built in: `pi-herdr-pstack` (its `poteto-mode` status) → magic wand `U+F0D0` in `accent`, `telegram` → `U+F2C6` in `accent`, and `search` (pi-search's working row, e.g. `Search | gpt-6-luna | think:high`, plus its `Docs Search` / `Context7 …` rows that share the key) → magnifier `U+F002` in `mdLink`. Fields merge over the built-in entry, so `{"pi-herdr-pstack": {"icon": ""}}` drops the icon and keeps the color; `""` for both removes the badge. Status keys are matched verbatim against `setStatus` keys. The icon is always added; the color applies to the whole text when the status is plain, and only to the icon when the supplying extension already colored its own text (pi-telegram does). An unknown theme token falls back to uncolored text |

Binary resolution order: `config.binary` → `~/.claude/ccline/ccline` → `ccline` on `PATH`.

## Implementation notes

- `render(width)` is a synchronous hot path and **never spawns anything** from inside: it returns the cached frame; a width change is only recorded and one refresh request is dispatched.
- Refreshes are triggered by `session_start` / `turn_start` / `turn_end` / `model_select` / `thinking_level_select` / `session_info_changed` / a git branch change, and go through `RefreshScheduler` with single-flight + throttling + latest-wins: at most one child process at any moment, queued requests collapse into one, and it reads the freshest state as of the moment it starts.
- **Segments that move with time, like `duration`, are advanced by a timer**: a purely event-driven refresh can only compute "now − start" once, when the event fires, so while the agent runs (`agent_start` → `agent_end`) a `RefreshTicker` dispatches refresh requests at `liveRefreshMs`, which is what makes `duration` tick every second; the clock stops when the run ends, after which at most one already-queued refresh can land and no periodic refresh remains. The next `turn_start` restarts the clock; if the footer is installed or switched on mid-run, `attach()` reads `ctx.isIdle()` and starts it immediately.
- A timeout (5s, configurable) or a non-zero exit keeps the previous frame and appends ` ·stale` at the end of the line (only if it fits): no flooding, no throwing.
- Binary not found: the footer shows a one-line install hint.
- Widths are always computed with `visibleWidth` / `truncateToWidth`, never with `.length`.
- **Other extensions' `ctx.ui.setStatus` stays visible**: `render(width)` reads `footerData.getExtensionStatuses()`, sorts by key, joins them with spaces into one line, truncates with a dim `…` when too wide, and appends it to the last ccline line when the whole status still fits there — otherwise it gets a row of its own. Either way nothing is cut to make room, so a status is never truncated by merging. It reads the live map and `setStatus` itself triggers a repaint, so status changes are not limited by the 1Hz throttle.
- **A status key can carry a badge**: `setStatus` hands over text, and whether it is styled depends on the extension that sends it (pi's own footer adds nothing). This footer adds a Nerd Font icon and a theme color per status key (`DEFAULT_STATUS_BADGES` in `config.ts` holds the entries for pi-herdr-pstack's `poteto-mode`, for pi-telegram, and for pi-search's `search` row). The icon is counted with the rest of the row before truncating. When the status text already contains ANSI, only the icon takes the badge color so the sending extension keeps the palette it chose, and the color goes through one `theme.fg()` call per badge that degrades to plain text when the token is not in the theme.
- Because there is only one footer slot globally, other extensions' custom footers (e.g. pi-cursor-provider's fast badge) get displaced once this extension is installed; their status lines still show. Conversely, when they take over, the ccline frame disappears and `/pi-ccline on` takes it back.
- **The provider can only be folded into the model segment.** ccline 2.0.1's input schema has no provider field and the `model` segment renders only `display_name`, so the provider is appended after the model name as `name (provider)`; it isn't appended twice when the name already carries the same suffix. `showProvider: false` turns it off. **A narrow footer stops appending it**: below `MIN_PROVIDER_WIDTH` (80 columns, `input.ts`) the suffix is left out to leave room on ccline's wrapped lines. The width is the one captured when the refresh was built, so a resize is picked up by the next refresh, and `showProvider: false` wins at every width. Because both switches mean "no provider on screen", a `(provider)` that already arrived inside `model.name` is stripped too (`withoutProvider`), while any other trailing qualifier such as `(preview)` is left alone. How many lines that saves is up to the ccline config, the model name and the width — this threshold reduces wrapping, it does not guarantee a line count. Beyond that, ccline wraps/truncates by `COLUMNS` itself: at width 40 the model segment keeps only `GPT-5.6`.
- The input JSON **omits the `version` field**: ccline 2.0.1 validates it as a Claude Code version and rejects pi's version outright.
- **Cache hit share:** `prompt_cache` is sent only from the second assistant message on. That is ccline's own display gate (`requests > 1`), whose rationale is that a single request usually only writes the cache — an initial request can still hit a prefix cached by an earlier session, so the gate is display behaviour, not a claim about request #1. Sending `hit_ratio` before that gate would also make ccline fall back to its "cold" wording, which pi cannot assert. `current_usage` deliberately still carries only `input_tokens`: pi's context estimate already includes the cached tokens, and ccline sums the `current_usage` fields when `total_input_tokens` is absent, so adding the cache counts there would double-count them in the context bar.
- **Output speed and running tools go through ccline's bridge, not stdin.** ccline's `timing.tps` / `timing.ttft` and `activity.tools` metrics read `bridge/<session>.json` under its data dir (`$CCLINE_HOME` or `~/.claude/ccline`), the file its companion mod writes inside Claude Code. The statusline payload has no per-request timing and no running-tool list, so this extension measures the first and tracks the second, and writes the same documented `v: 1` shape, atomically. Because both live in one file, every write carries everything known: the last finished answer's timing plus the tools running now, so a tool starting or ending never blanks `tok/s` and a new answer never leaves a finished tool behind. ttft is stream start → first content block; pi emits `message_start` when the provider starts responding, so that number excludes the connect wait. tps divides the answer's output tokens by the time from the first content block to `message_end`, so the wait for the first token is not counted as generation. Durations use a monotonic clock (`performance.now()`); only the bridge's freshness stamp is wall-clock. `tools` skips calls carrying `parentToolCallId` (codemode scripts and tools calling tools), so the segment lists what the user actually issued. The file is removed on `session_shutdown`, and ccline ignores bridges older than 6h.
- No runtime dependencies: only `node:child_process` / `node:fs` / `node:os` / `node:path` plus the pi peer package `@earendil-works/pi-tui`.
- Non-TUI modes (`-p`, json, rpc) install no footer and spawn nothing.
- The extension's own config lives at `~/.pi/agent/pi-ccline/config.json`; pi's `settings.json` is never touched.

## Verification

```sh
# unit tests (input mapping, width truncation, throttle/latest-wins, binary resolution, timeout, footer lifecycle)
npm test

# run the real ccline against the fixture at width 120 and 40 (prints visible widths, checks nothing overflows)
node --experimental-strip-types scripts/render-once.ts --fixture fixtures/basic.json

# single width / pinned binary / raw ANSI
node --experimental-strip-types scripts/render-once.ts --width 40 --binary ~/.claude/ccline/ccline --raw

# fully isolated: config is read from this HOME and the child's HOME points there too (state never lands in your ~/.claude)
node --experimental-strip-types scripts/render-once.ts --home "$(mktemp -d)" --binary ~/.claude/ccline/ccline

# drop the fixture's "(provider)" suffix, which is what the footer sends below 80 columns
node --experimental-strip-types scripts/render-once.ts --width 74 --no-provider
```

`--home` is used for three things at once: finding `~/.claude/ccline/ccline`, reading `<home>/.pi/agent/pi-ccline/config.json`, and setting the child's `HOME`/`USERPROFILE`. If what resolves is the npm wrapper script (`@cometix/ccline/bin/ccline.js`), it may populate that HOME with themes and other resources itself; pin the real binary with `--binary` as well when you want a clean result.

`scripts/render-once.ts` starts no pi and sends no model requests; it verifies only the "input → binary → line" stretch. The fixture carries whatever model name it was written with, so a width below 80 prints a note about the provider suffix the footer would have dropped. `--no-provider` renders what the footer would actually send, and only for widths below 80 — a wide footer keeps the suffix.

## Known limitations

- **The 5h / 7d quota segment is always empty.** pi provides no `rate_limits`, the field is omitted entirely, and ccline shows nothing.
- **ccline writes `~/.claude/ccline/state/`** (session state, model cache, update.lock). That's upstream behaviour and cannot be disabled here. The extension additionally writes `~/.claude/ccline/bridge/<session>.json` for the `timing.tps` segment, and deletes it when the session shuts down.
- **The cache segment shows only the hit share.** Warmth, TTL countdown, miss counts and miss causes need data pi does not have (the provider's cache expiry and rebuild reasons), so those fields are omitted — with a config `format` of `{hit}% hit` the segment reduces to that one number, and before the second request it disappears entirely rather than claiming "cold".
- **`tok/s` describes the last finished answer, not a running average.** It is measured per request and only updates when an answer ends (a non-streaming provider, or a streamed answer of a few tokens, produces no sample and leaves the previous value on screen until the next one arrives). `duration` and `tok/s` are unrelated numbers: duration is session wall-clock, tps is streaming speed.
- **The tools segment shows only what is running right now.** ccline names the two oldest calls and folds the rest into `+N`, with the elapsed time of the oldest; there is no history, no per-tool duration and no output. Calls made through `parentToolCallId` (codemode scripts, tools invoking tools) are not listed, and a call originating inside a subagent appears only if pi hands that event to the main extension, which today it does not.
- **External binary required.** Without `ccline` the footer is a single install hint; upgrading `ccline` needs no extension restart, but the binary path stays cached until the next resolution (`/pi-ccline on` or a new session recomputes it).
- **Upstream compatibility only covers tested versions.** Every field in ccline 2.0.1's `input.rs` is `Option` with lenient deserialization, so a field changing shape within the same major version usually just makes that segment disappear; but required fields have changed across majors before (1.1.x → 2.0.x), so re-run `scripts/render-once.ts` after upgrading ccline.
- **Nerd Font v3+ required.** Missing icon fonts render as boxes; Windows is untested.
- **There is only one measure of context tokens: the current context.** `context_window` sends only `current_usage.input_tokens` (= `getContextUsage().tokens`) and `used_percentage`, never `total_input_tokens` / `total_output_tokens`. The reason is that ccline prefers the lifetime values, which makes the progress-bar percentage contradict the token count (a long session shows up as `15% · 512k/272k`). The cost: lifetime input/output tokens don't appear in the footer; cost and duration still come from the `cost` segment. pi provides only the aggregate estimate, with no input/cache split, so only `input_tokens` is filled in `current_usage`.
- **Branch perspective.** The aggregate covers only the current branch as seen by `getBranch()`; after compaction it is still computed from the records that remain on that branch, which is not the same as "total for the whole session lifetime". Switching branches changes the numbers.
- **`transcript_path` is not sent.** pi's session jsonl is not Claude Code's transcript format; passing it would only make upstream read something it cannot parse, so whatever appears in that spot comes from the JSON itself rather than a re-parse of the session file.
- **Refresh rate is capped at 1Hz.** During streaming, context usage is not refreshed token by token; it updates once after the throttle window.
- **`duration` only ticks while the agent runs.** The timer starts and stops with the run, so while idle it sits at the last value until the next event (sending a message, switching model, switching branch, …); `liveRefreshMs` only controls the cadence of refresh requests during a run, it does not enable idle refreshes. With both `liveRefreshMs` and `refreshThrottleMs` at 1000, the steady state is roughly once per second, with the actual interval bounded by both. Making idle time tick every second would mean changing the stop logic in `agent_end` — an untested power trade-off.
- **Every timer tick is a process creation.** On this machine spawning ccline measured about 24ms (4.4ms in the binary itself), hence roughly once per second during a run; `liveRefreshMs: 0` turns it off entirely.
- **The first refresh may use 100/120 columns.** The first frame prefers `process.stdout.columns` and falls back to 120; after pi's first paint it refreshes once at the real width (one extra ~4ms spawn).

## Layout

```
extensions/pi-ccline/
  index.ts    lifecycle, setFooter, commands, CclineFooter (cached frame + single-flight refresh)
  input.ts    pi state → ccline input JSON (pure functions)
  binary.ts   path resolution/caching, spawn with timeout and abort, --version probing
  render.ts   output normalization: line splitting, truncation by visible width, stale marker
  refresh.ts  single-flight + throttle + latest-wins scheduler, and the timer that drives `duration`
  turn.ts     per-request timing from the stream and the running-tool list, plus the ccline bridge file
  config.ts   config read/write
  *.test.ts   node --test
scripts/render-once.ts   run the real ccline once against a fixture
fixtures/basic.json      input used for manual acceptance
```
