# pi-ccline

[English](./README.md) | 简体中文

把 pi 的 footer 交给原版 [CCometixLine](https://github.com/Haleclipse/CCometixLine)（`ccline`）渲染。

这个扩展不做任何渲染：它从 pi 会话采集状态，拼成 Claude Code `statusLine` 形状的 JSON，喂给 `ccline` 二进制的 stdin，再把它的 stdout 当成 footer 显示。配色、主题、图标、折行全部由上游决定；上游升级或改主题，这里不需要跟着改。

```
pi 会话状态 → buildCclineInput() → JSON → ccline（spawn，COLUMNS=当前宽度）→ ANSI 行 → footer
```

## 能力

| 显示内容 | 来源 |
|---|---|
| 模型名（含 provider） | `ctx.model`（`display_name` 取 `model.name`，回退 `model.id`；`showProvider` 为真时追加 ` (provider)`，如 `Sonnet 4.5 (anthropic)`） |
| 推理强度 | `ctx.thinkingLevel` → `effort.level` |
| 工作目录 | `ctx.cwd` → `cwd` / `workspace.current_dir` |
| 上下文百分比 / token 数 | `ctx.getContextUsage()` → 当前上下文（聚合估计值）；**不发会话累计 token** |
| 缓存命中率 | assistant 消息的 `usage.cacheRead` 除以 `input + cacheRead + cacheWrite`，在分支上累加 → `prompt_cache.hit_ratio`；从第二次请求起才发送 |
| 输出速度（`tok/s`） | 由 `message_start` → 首个 `message_update` → `message_end` 实测，写入 ccline 的 `bridge/<session>.json` 供 `timing.tps` 读取 |
| 运行中的工具 | `tool_execution_start` / `tool_execution_end` → 同一个 bridge 文件的 `tools` 数组，供 `activity.tools` 读取 |
| 成本、会话时长 | assistant 消息 `usage.cost.total` 累加；时长 = 当前时间 − 分支最早 entry |
| 会话 id / 名称 | `ctx.sessionManager` |
| git 分支等 ccline 自行探测的信息 | ccline 自己读磁盘 |
| 其他扩展的 status | `footerData.getExtensionStatuses()`，按 key 排序拼成一行放在 ccline 帧下方 |

不显示、也不会伪造的：5h / 7d 配额段（pi 没有 `rate_limits` 数据源，字段不传，该段自动消失）；缓存冷热 / TTL 倒计时 / miss 次数与原因（pi 既不知道 provider 的缓存过期时间，也不知道缓存为何重建，所以只发命中率，其余字段交给 ccline 自己隐藏）。

## 安装

先准备外部二进制（扩展不自带渲染器，必须有它）：

```sh
npm i -g @cometix/ccline
# 或者只放一份到 ~/.claude/ccline/ccline
```

**已在 ccline 2.0.1 上验证。** 更老的 1.1.x 会把 `model` / `workspace` / `transcript_path` 当必填字段，收到这里的输入会直接报
`missing field ...` 并非 0 退出（footer 会停在上一帧并标 stale），所以旧安装请先升级。

再装 pi 包（任选其一）：

```sh
# 从 npm 正式安装（会写 ~/.pi/agent/settings.json）
pi install npm:@caph42/pi-ccline

# 从 npm 试用一次，不写 settings.json
pi -e npm:@caph42/pi-ccline

# 本地源码试用 / 正式安装（在包根目录执行）
pi -e .
pi install .
```

启动后 footer 直接变成 ccline 的渲染结果。终端需要 Nerd Font v3+ 才能显示图标；`style.mode = "plain"` 的 ccline 主题可以退化成 emoji。

## 命令

| 命令 | 作用 |
|---|---|
| `/pi-ccline on` | 打开 footer（写入配置，立即生效） |
| `/pi-ccline off` | 关闭并恢复 pi 自带 footer（写入配置） |
| `/pi-ccline status` | 启用状态、模式、解析到的二进制、节流/超时/定时刷新、刷新次数、上一帧是否 stale |
| `/pi-ccline path` | 解析到的二进制路径、来源（config/home/path）与 `ccline --version` |

## 配置

`~/.pi/agent/pi-ccline/config.json`（文件不存在、JSON 坏了、字段类型不对，一律回退默认值，不报错）：

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

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 会话启动时是否安装 footer |
| `binary` | `null` | 显式指定 ccline 路径；`null` 走下面的解析顺序。路径不存在时静默回退 |
| `timeoutMs` | `5000` | 单次调用的硬超时（200–60000） |
| `refreshThrottleMs` | `1000` | 两次刷新最小间隔，低于 1000 会被抬到 1000 |
| `liveRefreshMs` | `1000` | agent 运行期间的定时刷新间隔（让 `耗时` 逐秒走）；`0` 关闭定时器，只保留事件刷新。非 0 时低于 250 会被抬到 250 |
| `showProvider` | `true` | 是否在模型段追加 provider，如 `Sonnet 4.5 (anthropic)`；`false` 只显示模型名。宽度低于 80 列时该后缀一律不追加，给 ccline 的折行留出空间；这个开关只决定宽 footer 下显不显示 |
| `env` | `{}` | 追加给 ccline 的环境变量；同名变量覆盖 pi 继承的值（`COLUMNS` 除外，它由扩展按当前宽度写入） |
| `statusBadges` | `{}` | 给其他扩展 `ctx.ui.setStatus` 那一行加图标和颜色，形状 `{"<status key>": {"icon": "<字形>", "color": "<主题 token>"}}`。内置四条：`pi-herdr-pstack`（它的 `poteto-mode` 状态）→ 魔法棒 `U+F0D0` + `accent`，`telegram` → `U+F2C6` + `accent`，`search`（pi-search 的工作行，如 `Search | gpt-6-luna | think:high`，以及共用这个 key 的 `Docs Search` / `Context7 …` 行）→ 放大镜 `U+F002` + `mdLink`，`ssh-remote`（pi-ssh-remote 的 `user@host:path` 行）→ 服务器 `U+F233` + `accent`。字段按项合并到内置条目上，所以 `{"pi-herdr-pstack": {"icon": ""}}` 只去掉图标、保留颜色；两个字段都写 `""` 即去掉徽标。status key 与 `setStatus` 的 key 逐字匹配。图标一律加；颜色在文本没上色时刷整段，在发它的扩展已经自己上色时只刷图标（pi-telegram 和 pi-ssh-remote 都会自己上色，后者重连时用的是 `warning`）。主题里不存在的 token 回退成不上色 |

二进制解析顺序：`config.binary` → `~/.claude/ccline/ccline` → `PATH` 中的 `ccline`。

## 实现要点

- `render(width)` 是同步热路径，**绝不在里面 spawn**：只返回缓存帧；宽度变化只记录并投递一次刷新请求。
- 刷新由 `session_start` / `turn_start` / `turn_end` / `model_select` / `thinking_level_select` / `session_info_changed` / git 分支变化触发，经 `RefreshScheduler` 单飞 + 节流 + latest-wins：任何时刻最多一个子进程，排队请求合并为一次，读的是发起时刻的最新状态。
- **耗时这类随时间变化的段靠定时器推进**：纯事件刷新只能在事件发生时算一次「现在 − 起点」，所以 agent 运行期间（`agent_start` → `agent_end`）另有 `RefreshTicker` 按 `liveRefreshMs` 投递刷新请求，`耗时` 才会逐秒走；run 结束即停表，之后只有一次已排队的刷新可能落地，再没有周期刷新。下一轮的 `turn_start` 会重新起表；如果在 run 途中才装上/打开 footer，`attach()` 读 `ctx.isIdle()` 后直接起表。
- 超时 5s（可配）或非 0 退出：保留上一帧并在行尾加 ` ·stale`（放得下才加），不刷屏、不抛错。
- 找不到二进制：footer 显示一行安装提示。
- 行宽一律用 `visibleWidth` / `truncateToWidth` 计算，不用 `.length`。
- **其他扩展的 `ctx.ui.setStatus` 照样可见**：`render(width)` 读 `footerData.getExtensionStatuses()`，按 key 排序、用空格拼成一行、超宽时用 dim `…` 截断。整条状态还放得下时，追加到最后一条 ccline 行尾部；放不下才独占一行。两种情况都不会为了合并而裁剪状态本身。读的是实时 map，`setStatus` 自己会触发重绘，所以状态变化不受 1Hz 节流限制。
- **status 可以带徽标**：`setStatus` 交过来的是文本，有没有上色取决于发它的扩展（pi 自带 footer 不再加任何样式）。所以本扩展按 status key 加 Nerd Font 图标和主题色（内置条目在 `config.ts` 的 `DEFAULT_STATUS_BADGES`，目前是 pi-herdr-pstack 的 `poteto-mode`、pi-telegram、pi-search 的 `search` 行，以及 pi-ssh-remote 的 `user@host:path` 行）。图标计入整行的可见宽度再截断；文本自带 ANSI 时只给图标上色，发它的扩展保留自己选的配色；颜色每帧走一次 `theme.fg()`，token 不在主题里就退成纯文本。
- 因为 footer 槽位全局只有一个，本扩展装上后其他扩展的自定义 footer（例如 pi-cursor-provider 的 fast 徽标）会被顶掉；它们的 status 行仍会显示。反过来它们抢占时 ccline 帧会消失，需要 `/pi-ccline on` 取回。
- **provider 只能拼进模型段。** ccline 2.0.1 的输入 schema 没有 provider 字段，`model` 段只渲染 `display_name`，所以 provider 以 `名称 (provider)` 的形式追加在模型名后；名字里已经带同样的后缀时不重复追加。`showProvider: false` 可关掉。**窄 footer 不再追加它**：宽度低于 `MIN_PROVIDER_WIDTH`（80 列，见 `input.ts`）时不加这个后缀，给 ccline 的折行留出空间。用的是发起本次刷新时捕获的宽度，所以 resize 会在下一次刷新生效；`showProvider: false` 在任何宽度下都优先。两个开关都表示「屏幕上不要出现 provider」，所以 `model.name` 里本来就带的 `(provider)` 也会被剥掉（`withoutProvider`），而 `(preview)` 这类其它限定词不动。至于能省下几行，取决于 ccline 配置、模型名长度和当前宽度——这个阈值只减少折行，不保证行数。除此之外 ccline 仍按 `COLUMNS` 自行折行/截断：宽度 40 时模型段只剩 `GPT-5.6`。
- 输入 JSON **省略 `version` 字段**：ccline 2.0.1 会把它当 Claude Code 版本校验，传 pi 的版本会被直接拒绝。
- **缓存命中率：** `prompt_cache` 从第二条 assistant 消息起才发。这是 ccline 自己的显示门槛（`requests > 1`），它的理由是一次请求通常只是在写缓存——但首个请求确实可能命中之前会话已缓存的 prefix，所以这是显示行为，不是对「第一次请求」的事实断言。若在门槛前就发 `hit_ratio`，ccline 还会回退到 `cold` 文案，而那是 pi 无法断言的。`current_usage` 仍然只填 `input_tokens`：pi 的上下文估计值本就包含缓存 token，而缺少 `total_input_tokens` 时 ccline 会把 `current_usage` 各项相加，把 cache 数填进去会让它们被重复计入上下文进度条。
- **输出速度与运行中的工具走 ccline 的 bridge，不走 stdin。** ccline 的 `timing.tps` / `timing.ttft` 与 `activity.tools` 读的是其数据目录（`$CCLINE_HOME` 或 `~/.claude/ccline`）下的 `bridge/<session>.json`，也就是它家在 Claude Code 里的伴生 mod 写的文件。statusline 载荷里既没有单次请求耗时，也没有运行中工具列表，所以本扩展自己实测、自己跟踪，并按同样的 `v: 1` 结构原子写入。因为两者共用一个文件，每次写入都带全量：最后答完那次请求的计时 + 当前运行中的工具，所以工具起止不会把 `tok/s` 清掉，新回答也不会把已结束的工具留在那里。ttft = 流开始 → 首个内容块；pi 是在 provider 开始响应后才发 `message_start`，所以这个数不含建立连接的等待。tps = 该回答的 output token 除以「首个内容块 → `message_end`」的时长，所以等首字的耗时不算进生成速度。计时用单调时钟（`performance.now()`），只有 bridge 的新鲜度标记用墙钟。`tools` 会跳过带 `parentToolCallId` 的调用（codemode 脚本、工具内部再调工具），所以这段只列用户真正发起的调用。`session_shutdown` 时删除该文件；ccline 也会忽略超过 6 小时的 bridge。
- 没有运行时依赖，只用 `node:child_process` / `node:fs` / `node:os` / `node:path` 和 pi 提供的 peer 包 `@earendil-works/pi-tui`。
- 非 TUI 模式（`-p`、json、rpc）不安装 footer、不 spawn。
- 扩展自己的配置写在 `~/.pi/agent/pi-ccline/config.json`，不碰 pi 的 `settings.json`。

## 验证

```sh
# 单元测试（输入映射、宽度截断、节流/latest-wins、二进制解析、超时、footer 生命周期）
npm test

# 用 fixture 跑真实 ccline，宽 120 与 40 各一次（打印可见宽度，验证不越界）
node --experimental-strip-types scripts/render-once.ts --fixture fixtures/basic.json

# 只跑某个宽度 / 指定二进制 / 隔离 HOME
node --experimental-strip-types scripts/render-once.ts --width 40 --binary ~/.claude/ccline/ccline --raw

# 完全隔离：配置从该 HOME 读，子进程 HOME 也指向它（state 不会写进你的 ~/.claude）
node --experimental-strip-types scripts/render-once.ts --home "$(mktemp -d)" --binary ~/.claude/ccline/ccline

# 去掉 fixture 里的 "(provider)" 后缀，也就是 footer 在 80 列以下实际发送的内容
node --experimental-strip-types scripts/render-once.ts --width 74 --no-provider
```

`--home` 会把该目录同时用于三处：查 `~/.claude/ccline/ccline`、读 `<home>/.pi/agent/pi-ccline/config.json`、以及给子进程设置 `HOME`/`USERPROFILE`。如果解析到的是 npm 包装脚本（`@cometix/ccline/bin/ccline.js`），它可能自己往这个 HOME 里铺主题等资源，想得到干净结果就同时用 `--binary` 钉死真实二进制。

`scripts/render-once.ts` 不启动 pi、不发模型请求，只验证「输入 → 二进制 → 行」这一段。fixture 里的模型名是写死的，所以宽度低于 80 时会提示 footer 本来会省略的 provider 后缀。`--no-provider` 渲染的是 footer 实际会发送的内容，且只对 80 列以下生效——宽 footer 照样带后缀。

## 已知限制

- **5h / 7d 配额段永远为空。** pi 不提供 `rate_limits`，字段整段省略，ccline 自然不显示。
- **ccline 会写 `~/.claude/ccline/state/`**（会话状态、模型缓存、update.lock）。这是上游行为，扩展无法关闭。另外本扩展会写 `~/.claude/ccline/bridge/<session>.json` 供 `timing.tps` 段使用，会话关闭时删掉。
- **缓存段只显示命中率。** 冷热状态、TTL 倒计时、miss 次数与原因需要 pi 没有的数据（provider 的缓存过期时间、重建原因），这些字段一律不发；配置里用 `format = "{hit}% hit"` 就只剩这一个数字，而第二次请求之前整段直接消失，而不是谎称 `cold`。
- **`tok/s` 描述的是最后一次答完的请求，不是滚动平均。** 它按请求实测，只在回答结束时更新（非流式 provider、或只有几个 token 的回答不会产生样本，上一轮的数值会继续显示到下一次更新）。`duration` 和 `tok/s` 没有关系：前者是会话墙钟时长，后者是流式速度。
- **工具段只显示「此刻在跑」的调用。** ccline 只点名最老的两个、其余的折成 `+N`，elapsed 取最老那个的耗时；没有历史、没有单工具耗时、没有输出。带 `parentToolCallId` 的调用（codemode 脚本、工具内部再调工具）不列；子 agent 内部的调用只有 pi 把它交给主扩展时才会出现，目前不会。
- **依赖外部二进制。** 没有 `ccline` 时 footer 只有一行安装提示；升级 `ccline` 后无需重启扩展，但二进制路径会被缓存到下一次解析（`/pi-ccline on` 或新会话会重算）。
- **上游兼容性只覆盖已测版本。** ccline 2.0.1 的 `input.rs` 每个字段都是 `Option` + lenient 反序列化，同一大版本内字段换形状一般只会让对应段消失；但大版本之间已经发生过必填字段变化（1.1.x → 2.0.x），升级 ccline 后请用 `scripts/render-once.ts` 复跑一次。
- **需要 Nerd Font v3+。** 图标字体缺失时会显示成方块；Windows 未测试。
- **上下文 token 只有一套口径：当前上下文。** `context_window` 只发 `current_usage.input_tokens`（= `getContextUsage().tokens`）和 `used_percentage`，不发 `total_input_tokens` / `total_output_tokens`。原因是 ccline 优先取累计值，那样进度条百分比会和 token 数互相矛盾（长会话显示成 `15% · 512k/272k`）。代价：会话累计输入/输出 token 不出现在 footer 里；成本与时长仍来自 `cost` 段。pi 只给聚合估计值，没有 input/cache 拆分，所以 `current_usage` 里只填 `input_tokens`。
- **分支视角。** 汇总只覆盖 `getBranch()` 可见的当前分支；compaction 之后仍按分支上现存记录计算，不等于「整个会话生命周期总量」。切分支后数字会变。
- **不传 `transcript_path`。** pi 的 session jsonl 不是 Claude Code 的 transcript 格式，传过去只会让上游读到无法解析的内容；因此在那个位置上显示的信息来自 JSON 本身而不是重新解析会话文件。
- **刷新频率上限 1Hz。** 流式输出期间上下文用量变化不会逐 token 刷新，只在节流窗口后更新一次。
- **`耗时` 只在 agent 运行期间逐秒走。** 定时器随 run 起停，空闲时停在最后一刻的值，直到下一个事件（发消息、切模型、切分支等）再刷新；`liveRefreshMs` 只控制运行期间的刷新请求节奏，不开启空闲刷新。`liveRefreshMs` 与 `refreshThrottleMs` 都是 1000 时，稳态约 1s 一次，实际间隔受两者共同限制。若以后想让空闲也逐秒走，需要改 `agent_end` 的停表逻辑，属于待评估的耗电取舍。
- **每次定时刷新都是一次进程创建。** 本机实测 spawn ccline 约 24ms（二进制自身 4.4ms），所以运行期间约每秒一次；`liveRefreshMs: 0` 可以彻底关掉。
- **首次刷新可能用 100/120 列。** 首帧宽度优先取 `process.stdout.columns`，拿不到时用 120，pi 第一次绘制后会按真实宽度重刷一次（多一次 4ms 级 spawn）。

## 目录

```
extensions/pi-ccline/
  index.ts    生命周期、setFooter、命令、CclineFooter（缓存帧 + 单飞刷新）
  input.ts    pi 状态 → ccline 输入 JSON（纯函数）
  binary.ts   路径解析/缓存、带超时与中止的 spawn、--version 探测
  render.ts   输出归一化：分行、按可见宽度截断、stale 标记
  refresh.ts  单飞 + 节流 + latest-wins 调度器，以及驱动 `耗时` 的定时器
  turn.ts     从流事件实测单次请求耗时、跟踪运行中的工具，并写 ccline 的 bridge 文件
  config.ts   配置读写
  *.test.ts   node --test
scripts/render-once.ts   用 fixture 跑一次真实 ccline
fixtures/basic.json      人工验收用输入
```
