# 任务：pi-ccline（pi 扩展 → 委派原版 CCometixLine 二进制渲染 footer）

## 0. 一句话

写一个 pi 扩展：从 pi 会话采集状态 → 拼成 Claude Code `statusLine` 形状的 JSON → spawn 原版 `ccline` 二进制 → 把它的 stdout 当作 pi 的 footer 显示。**不要重写渲染器**，渲染、主题、配色、折行全部由上游负责。

## 1. 背景（已核验，不要重新论证，也不要改成别的方案）

- pi 1.4.0 **没有** `statusLine` 机制；footer 只能由扩展 `ctx.ui.setFooter(factory)` 整体替换。
- 原版 CCometixLine（`Haleclipse/CCometixLine`，MIT，npm `@cometix/ccline@2.0.1`，发布于 2026-10-24）作为 CLI 读 stdin JSON、向 stdout 输出带 ANSI 的一行或多行。
- 本机实测（darwin-arm64，2026-10-25，用 `npm pack @cometix/ccline` + `@cometix/ccline-darwin-arm64` 在临时目录跑）：
  - 单次渲染 **4.4ms**，二进制 4.1MB，只链系统库。
  - 最小输入 `{"cwd": "...", "model": {"display_name": "GPT-5.6"}}` 就能渲染；`src/input.rs` 里每个字段都是 `Option` + lenient 反序列化 → **缺字段只掉对应段，不会失败**。
  - `COLUMNS=<宽>` 控制折行：`COLUMNS=40` 时输出两行 → 正好对应 footer 契约里的 `string[]`。
  - **必须省略 `version` 字段**：传 `"version": "pi 1.4.0"` 会被拒绝，输出 `ccline needs Claude Code 2.1.153 or newer (running 1.4.0)`。不传则正常。
  - 运行时会写 `$HOME/.claude/ccline/state/`。
- 生态里已有的 pi 移植**不采用**：`pi-cometixline` 单版本且无公开仓库，`pi-cometix-footer` 是自研渲染（观感接近但非同一套）。本包的价值就是复用上游渲染。

## 2. 目标行为

屏幕上看到的就是 ccline 的渲染结果，扩展只负责喂数据。需要正确映射的字段（名字以 `src/input.rs` 为准）：

| ccline 输入字段 | 数据来源 |
|---|---|
| `model.id` / `model.display_name` | `ctx.model` |
| `effort.level` | `ctx.thinkingLevel` |
| `cwd` / `workspace.current_dir` | `ctx.cwd` |
| `context_window.current_usage` / `.context_window_size` / `.used_percentage` / `.total_input_tokens` / `.total_output_tokens` | `ctx.getContextUsage()` + 会话 usage 汇总 |
| `cost.total_cost_usd` / `cost.total_duration_ms` | assistant 消息 `usage.cost.total` 累加 |
| `session_id` / `session_name` | `ctx.sessionManager`（有则填） |
| `rate_limits` | **不填**（pi 无数据源）→ 该段自动消失 |

**禁止**编造 usage、百分比或成本；未知就省略字段。

## 3. 关键约束（硬性）

1. `render(width)` 是同步热路径，每次重绘都会被调用 → **绝对不能在里面 spawn 子进程**。做法：缓存上一帧 + 事件驱动异步刷新 + `tui.requestRender()`。
2. 刷新触发：`session_start`、`turn_start` / `turn_end`、`model_select`、`thinking_level_select`、`session_info_changed`、`footerData.onBranchChange`；节流 ≥1000ms；同一时刻只允许一个在飞的子进程，多次请求合并成 latest-wins。
3. 二进制解析顺序：`config.binary` → `~/.claude/ccline/ccline` → `PATH` 中的 `ccline`。找不到时 footer 显示一行人类可读提示（含安装命令），**never throw**。
4. 超时 5s；超时或非 0 退出 → 保留上一帧并标记 stale，不刷屏。
5. ANSI 宽度：ccline 输出含转义序列，对齐/截断必须用 pi 的可见宽度工具（`visibleWidth` / `truncateToWidth`，参考 `examples/extensions/custom-footer.ts`），不能用 `.length`。
6. 不写用户的 `~/.pi/agent/settings.json`；验证只用 `pi -e <包路径>`。
7. 不 `git init`、不 `git commit`（用户未授权提交）。
8. 不加运行时依赖：只用 `node:child_process` / `node:fs` / `node:path` 和 pi 提供的 peer 包。
9. 代码注释英文，README 中文。

## 4. 配置

`~/.pi/agent/pi-ccline/config.json`（缺失或坏 JSON 一律回退默认值，不报错）：

```json
{ "enabled": true, "binary": null, "timeoutMs": 5000, "refreshThrottleMs": 1000, "liveRefreshMs": 1000, "showProvider": true, "env": {} }
```

命令 `/pi-ccline`：`on` / `off` / `status` / `path`（`path` 显示解析到的二进制路径与 `ccline --version` 输出）。

## 5. 建议结构

```
extensions/pi-ccline/
  index.ts        // 生命周期、setFooter、命令、节流与排队
  input.ts        // pi 状态 → ccline 输入 JSON（纯函数，可测）
  binary.ts       // 路径解析/缓存、版本探测、带超时的 spawn
  render.ts       // 输出归一化（分行、ANSI 宽度截断、stale 提示）
  config.ts       // 配置读写
  *.test.ts       // node --test
scripts/render-once.ts        // 用 fixture 跑一次真实 ccline 并打印输出（人工验收）
fixtures/basic.json           // 输入 fixture
README.md
HANDOFF.md
package.json
```

## 6. 测试

- `node --test extensions/pi-ccline/`（Node 24 默认支持 type stripping；纯模块用 `import type`，保证能在 Node 里直接跑）
- 必测：输入映射（无模型 / 无 cost / context 未知）、未知字段省略、ANSI 截断、窄宽度、二进制缺失、超时、latest-wins
- 取本地二进制（临时目录，**不要全局安装**）：
  ```sh
  TMP=$(mktemp -d) && cd "$TMP"
  npm pack @cometix/ccline @cometix/ccline-darwin-arm64
  mkdir -p a b && tar xzf cometix-ccline-2.0.1.tgz -C a && tar xzf cometix-ccline-darwin-arm64-2.0.1.tgz -C b
  HOME=$(mktemp -d) ./b/package/ccline < fixture.json   # 隔离 ~/.claude
  ```

## 7. 完成标准（必须逐条可验证）

1. `node --test` 全绿。
2. `node --experimental-strip-types -e "import('<abs>/extensions/pi-ccline/index.ts').then(m=>console.log(typeof m.default))"` → `function`。
3. `node --experimental-strip-types scripts/render-once.ts --fixture fixtures/basic.json` 打印真实 ccline 输出（宽度 120 与 40 各一次）。
4. `pi -e <包路径>` 能加载、`/pi-ccline status` 正常；加载无报错（可用 `pi -e <path> -p "ok"` 验证一次）。
5. README 写清：能力、安装（本地路径 / npm）、配置项、已知限制。
6. 不做：TUI 视觉的最终人工确认（留给用户）。

## 8. 已知限制（必须写进 README）

- 5h/7d 配额段永远为空（pi 不提供 `rate_limits`）。
- ccline 会写 `~/.claude/ccline/state/`。
- 依赖外部二进制：`npm i -g @cometix/ccline`。
- 上游 schema 变化时降级为丢段，不会崩。
- 需要 Nerd Font v3+（本机 Maple Mono Normal NF CN 已具备）；Windows 未测。

## 9. 修复记录

- 2026-10-25 **footer 显示 model 的 provider**。ccline 2.0.1 的输入 schema 没有 provider 字段（`model` 段只渲染 `display_name`，实测 `display_name` 原样输出、不被 models.toml 改写），因此把 `ctx.model.provider` 以 `名称 (provider)` 追加到 `display_name`，例如 `Claude Fable 5.1 (anthropic)`。开关为 `config.showProvider`（默认 `true`）；名字已带相同后缀时不重复追加。验证：`node --test` 74 项全绿；`scripts/render-once.ts` 用带 `(openai-codex)` 的 fixture 在宽度 120 输出 ` GPT-5.6 Codex (openai-codex) · High │  ~/…`（宽度 40 时被上游自己的折行截成 `GPT-5.6`，属正常）。

- 2026-10-25 **耗时不是秒级更新**。根因：刷新完全事件驱动（`turn_start` / `turn_end` 等），而 `cost.total_duration_ms` 是 spawn 那一刻算的 `now − 分支最早 entry`，所以显示节奏等于 turn 边界节奏（约 5s、不固定）。修法：新增 `RefreshTicker`（`refresh.ts`）与配置 `liveRefreshMs`（默认 1000，0 关闭，非 0 下限 250），`agent_start`/`turn_start` 起表、`agent_end`/`agent_settled` 停表，只沿用同一个 `RefreshScheduler`（单飞 + 节流 + latest-wins）。空闲不 spawn。验证：`node --test` 65 项全绿；用真实 ccline 2.0.1 跑 250ms ticker，3 秒内 `耗时` 依次出现 5s → 6s → 7s → 8s。

- 2026-10-26 **新增缓存命中率与 tok/s**（0.2.0）。先在真实二进制上反向确认了数据来源：`cache` 指标从 stdin 的 `prompt_cache` 读，`hit_ratio` 是 0–1 小数且 `requests > 1` 才显示（缺失时回退到 `cold` 文案）；`timing.tps` / `timing.ttft` **只**读 `$CCLINE_HOME|~/.claude/ccline` 下 `bridge/<session>.json`（伴生 mod 写的 v1 文件，超过 6h 视为过期），指标 id 写 `timing` 不报错但静默不渲染。据此：`input.ts` 按分支累计 `cacheRead / (input + cacheRead + cacheWrite)` 并在第二次请求起发 `prompt_cache`；新增 `turn.ts` 用 `message_start` → 首个 `message_update` → `message_end` 实测 ttft / tps（单调时钟），原子写 bridge，`session_shutdown` 时删除。验证：`node --test` 88 项全绿；用真实 ccline 2.0.1 + 真实 `writeTurnBridge` 输出，宽度 120/80/40 分别得到 `99% hit` 与 `75 tok/s`，无越宽；无 `prompt_cache` 与无 bridge 时两段干净消失，命中 0 显示 `0% hit`。

- 2026-10-26 **新增运行中工具段（activity.tools）**。同一份 bridge 文件里再加 `tools:[{name, since(ms)}]`：`tool_execution_start`/`tool_execution_end` 维护 `Map<toolCallId, {name, since}>`，跳过带 `parentToolCallId` 的嵌套调用（codemode、工具内调工具），并把写入收敛成 `flushBridge()`——每次同时带「上次答完的 turn」与「当前 runningTools」，否则会互相清空（ccline 一个会话只读一个 bridge 文件）。验证：`node --test` 91 项全绿；真实 ccline 2.0.1 在 width 120/80/40 均得到 `Bash · Read · 14s`，与 `99% hit`、`75 tok/s` 共存无越宽；空 tools 时整段消失，嵌套调用不进列表。

- 2026-10-27 **窄 footer 不再追加 provider 后缀**。宽度低于 `MIN_PROVIDER_WIDTH`（80 列，`input.ts`）时不往 `display_name` 里加 `(provider)`，给 ccline 自己的折行留空间；用的是发起本次刷新时捕获的宽度，`showProvider: false` 仍在任何宽度优先。两个开关都表示「屏幕上不要 provider」，所以 `model.name` 里自带的同名后缀也会被 `withoutProvider` 剥掉，`(preview)` 这类其它限定词不动。验证：`npm test` 全绿；真实 ccline 2.0.1 + `render-once --width 120` 输出 `GPT-5.6 Codex (openai-codex) · High │ 15% · 42k/272k │ 99% CH`，`--width 74 --no-provider` 输出 `GPT-5.6 Codex · High │ …`，两行均不越宽。

- 2026-10-27 **其他扩展的 status 放得下就并进最后一行**。`render.ts` 新增 `mergeStatusIntoLastLine`：整条 status（含徽标）加分隔空格仍放得进当前宽度时，追加到最后一条 ccline 行尾；放不下就保留原来的独占行再截断。不为合并而裁剪 status 本身。验证：`npm test` 全绿，新增合并且独占行、ANSI/宽字形宽度、无行可附、整条过宽四组用例。

- 2026-10-27 **pi-ssh-remote 的 `ssh-remote` 状态加服务器徽标**。该插件自己用 `theme.fg("accent", …)` 给 `user@host:path` 上色、重连时改用 `warning`，所以内置徽标只给图标上色（`U+F233` `nf-fa-server` + `accent`），文本颜色原样保留；图标落在 BMP 的 Font Awesome 段，与已有三条徽标一致；pi-tui 的 `visibleWidth` 把该码位计为 1 格（实测），footer 用例另断言整行不越宽。验证：`npm test` 119 项全绿，含「连接态与重连态都保留自己的颜色」的 footer 端到端用例。

## 10. 参考

- pi 安装目录：`/Users/caph/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent`
  - `docs/tui.md`、`docs/extensions.md`、`docs/packages.md`
  - `examples/extensions/custom-footer.ts`（setFooter + visibleWidth/truncateToWidth 的官方示例）
  - `dist/core/extensions/types.d.ts`（`setFooter`、`ContextUsage`、`ExtensionContext`）
  - `dist/core/footer-data-provider.d.ts`（`getGitBranch` / `onBranchChange` / `getExtensionStatuses`）
- 上游：`https://github.com/Haleclipse/CCometixLine`（`src/input.rs` 定义 stdin schema）
- 工作目录就是包根（`~/Workspace/pi-packages/pi-ccline`），不要改 `../` 下的其它包。
