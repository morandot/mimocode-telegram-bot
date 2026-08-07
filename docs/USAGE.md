# MiMoCode Telegram Bot 使用手册

> 基于源码 `src/` 分析，服务端协议对应 MiMoCode v0.1.7+（serve + HTTP + SSE）。

---

## 1. 架构总览

```
Telegram 用户 ──消息──▶ Telegram API ──长轮询──▶ grammy Bot (bot.ts)
                                                   │
                                     ┌─────────────┴─────────────┐
                                     │      MimoClient (mimo.ts)  │
                                     │   HTTP + SSE（fetch）      │
                                     └─────────────┬─────────────┘
                                                   │
                                          mimo serve（本地子进程，
                                          MIMO_SERVE_PORT 默认 4096）
```

- **进程模型**：bot 启动时自动 `spawn("mimo", ["serve", "--port", ...])`，之后全部通过 HTTP API 交互（创建/继续会话、发送消息、回复权限），运行事件经 SSE 长连接推送。进程崩溃自动重启（2s 退避）。
- **外部服务**：设置 `MIMO_API_URL` 后不再自启 serve，直接连接已有服务（如远程服务器上的 `mimo serve`）。
- **权限审批**：`MIMO_SKIP_PERMISSIONS=false`（默认）时，agent 的权限请求以 inline 按钮形式发到 Telegram（✅ 允许一次 / ⚡ 总是允许 / ❌ 拒绝），按钮回调即回复服务端 `permission.reply`；`true` 时自动放行（等价 `--dangerously-skip-permissions`）。
- **会话持久化**：会话存于 serve 的 SQLite，bot 重启或 serve 重启后会话仍在，`/sessions` + 回复数字可切回。
- **进度指示**：`sendChatAction("typing")` 每 4s 刷新，任务结束自动消失。
- **超时控制**：`MIMO_RUN_TIMEOUT_MS`（默认 300000ms）墙钟超时后自动 `session.abort`；`0` 禁用。
- **会话恢复**：绑定会话失效（服务端 404）时自动新建会话重试一次。

### 关键设计决策

| 机制 | 实现 |
|------|------|
| 连接方式 | 常驻 `mimo serve` + HTTP/SSE，不再每次 spawn `mimo run` |
| 会话绑定 | `Map<chatId → sessionId>`，每个 Telegram 私聊独立维护 |
| 并发控制 | `Set<chatId>`，同一 chat 同时只能有一个任务在跑 |
| 内容分片 | 3500 字符为界，换行优先切分，超长降级为 `.txt` 文档 |
| 消息模式 | 事件以独立新消息发送，不做消息编辑替换 |
| 事件重连 | SSE 断线指数退避重连（1s→30s），断线期间内容以消息端点为兜底 |

---

## 2. 配置文件 (.env)

```bash
# ─── 必填 ───
TELEGRAM_BOT_TOKEN=123456:ABC...       # 从 @BotFather 获取
TELEGRAM_ALLOWED_USER_ID=111111,222222 # 逗号分隔的白名单，空则拒绝启动

# ─── 可选 ───
MIMO_WORK_DIR=/path/to/project         # serve 的工作目录（默认当前目录）
MIMO_WORKDIR_ROOT=/path/to/project     # /workdir 浏览器的根目录边界
MIMO_WORKDIR_BROWSE=false              # 是否启用 /workdir（默认关闭）
MIMO_SERVE_PORT=4096                   # 自启 serve 的端口（默认 4096）
MIMO_API_URL=http://127.0.0.1:4096     # 连接已有 serve（设置后不再自启）
MIMO_SKIP_PERMISSIONS=false            # true=自动放行所有权限（危险）
MIMO_CLI_PATH=mimo                     # serve 可执行文件路径
MIMO_RUN_TIMEOUT_MS=300000             # 单次消息墙钟超时（0=禁用）

# 控制各事件类型在 Telegram 中的可见性。
# 取值: full(完整内容) / brief(单行摘要) / hint(仅占位提示) / off(不显示)
MIMO_SHOW_TEXT=full           # 最终文本回复（默认 full）
MIMO_SHOW_REASONING=off       # 思考过程（/think 可临时开启）
MIMO_SHOW_TOOL_USE=off        # 工具调用（读写文件、执行命令等）
MIMO_SHOW_STEP_START=off      # 步骤开始
MIMO_SHOW_STEP_FINISH=off     # 步骤结束（含 token/cost 统计）
```

### 启动时的自检顺序

1. 检查 `.env` 是否存在，不存在则从 `.env.example` 复制
2. 解析 `TELEGRAM_BOT_TOKEN`（缺失抛异常）
3. 解析 `TELEGRAM_ALLOWED_USER_ID`（为空则抛异常，拒绝启动）
4. 解析端口、超时、可见性等环境变量（无效值报错或 fallback）
5. 启动（或连接）`mimo serve`，轮询 `/global/health` 直至就绪（最多 30s）
6. 打开 SSE 事件流（`GET /event`，自动重连）
7. 注册 bot 命令
8. 启动 grammy bot 长轮询

---

## 3. 完整命令参考

### 3.1 `/start` — 欢迎与快捷面板

显示版本与快捷操作按钮（Status / Sessions / Model / New Session）。

### 3.2 `/help` — 完整命令列表

### 3.3 自由文本消息 — 核心交互

任何文本消息（不在其它交互流中）都会发送给当前会话的 agent：

- 首个消息自动创建会话（标题取消息前 50 字符）
- 运行期间实时推送 `MIMO_SHOW_*` 对应的事件（reasoning / tool_use / step_start / step_finish）
- 完成后发送最终回复（Markdown → Telegram HTML 转换，3500 字符分片，超 5 片降级为文档）
- 纯数字消息若与 `/sessions` 列表匹配则切换会话

### 3.4 权限审批（非命令，自动出现）

agent 需要执行命令/写文件时，Telegram 出现：

```
🔐 权限请求: <permission> (<patterns>)
[✅ 允许一次] [⚡ 总是允许] [❌ 拒绝]
```

- 点击后立即回复服务端，不阻塞任务太久（无人应答时请求由服务端超时兜底）
- `MIMO_SKIP_PERMISSIONS=true` 时不出现按钮，全部自动放行

### 3.5 `/new` — 新建会话

删除当前 chat 绑定的服务端会话并清空本地状态（model/agent 选择一并重置）。旧会话在服务端被删除。

### 3.6 `/cancel` 和 `/stop` — 取消任务

调用 `POST /session/{id}/abort` 终止当前运行。若没有运行中的任务则提示"无任务运行"。

### 3.7 `/sessions` — 会话列表与会话切换

列出服务端最近会话（最多 15 条 + 计数），显示 id 前 16 位、标题、相对时间、当前标记。之后 5 分钟内回复数字即可切换。

### 3.8 `/status` — 连接与状态

显示：serve 地址、版本、权限模式（auto-approve / interactive buttons）、会话总数、当前模型与 agent、当前会话的活动时间。

### 3.9 `/model` — 模型管理

- `/model` — 显示当前模型（默认 default）
- `/model <provider/model>` — 设置该 chat 的模型，如 `xiaomi/mimo-v2.5-pro`

### 3.10 `/use` — Agent 模式切换

- `/use` — 列出服务端可用 agent（`GET /agent`，过滤 subagent）
- `/use plan|build|compose` — 设置该 chat 的 agent

### 3.11 `/compose` — Compose 工作流

`/compose <需求>` 以 compose agent 运行一次任务。注意：MiMoCode v0.1.8+ 起 compose agent 已弃用，推荐在 build agent 下使用 `/compose-next` skill。

### 3.12 `/max` — 最大并行采样模式

`/max <复杂任务>` 以 variant=max 运行（需模型与配置支持 Max Mode）。

### 3.13 `/think` — 思考模式

`/think <问题>` 单次运行强制显示 reasoning 内容（不受 `MIMO_SHOW_REASONING=off` 限制）。

### 3.14 `/delete` — 删除会话

`/delete` 删除当前会话；`/delete <sessionID>` 删除指定会话。删除当前绑定会话时同步清空本地状态。

### 3.15 `/version` — 版本信息

显示 serve 的 MiMoCode 版本（来自 `/global/health`）。

### 3.16 `/workdir` — 工作目录管理器

在 `MIMO_WORKDIR_ROOT` 边界内浏览目录并切换。切换后重启 `mimo serve`（新目录生效），SSE 自动重连，会话在服务端持久化不受影响。

> 已移除命令：`/models`（服务端无模型列表 API）、`/stats`、`/export`、`/providers`（纯 CLI 命令，serve 架构下无对应端点）。需要时请直接在主机上运行 `mimo models` / `mimo stats` 等。

---

## 4. 权限与安全

### 4.1 白名单机制

`TELEGRAM_ALLOWED_USER_ID` 逗号分隔，空值拒绝启动（防止开放代理）。未授权用户的消息与按钮全部拒绝。

### 4.2 错误信息脱敏

错误消息中的文件路径（Unix/Windows）被掩码为 `<path>`，ANSI 转义剥离，超过 100 字符截断。

### 4.3 权限确认

| 配置 | 行为 |
|------|------|
| `MIMO_SKIP_PERMISSIONS=false`（默认） | 权限请求 → Telegram inline 按钮审批 |
| `MIMO_SKIP_PERMISSIONS=true` | 全部自动放行（等同 `--dangerously-skip-permissions`） |

> 重要：MiMoCode v0.1.5+ 的 headless 模式对无响应的权限请求**自动拒绝**。若在 bot 环境设置了 `MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS=1`，会绕过 bot 的按钮审批直接放行——两者不要同时使用。

### 4.4 事件可见性控制

`MIMO_SHOW_*` 五档开关控制事件推送粒度（见第 2 节）。`error` 事件（模型/服务端报错）始终在最终回复失败时展示。

---

## 5. 内容渲染细节

- Markdown → Telegram HTML：代码块/行内代码/粗斜体/链接/任务列表/水平线，未闭合代码围栏兜底处理
- ANSI 与 `<system-reminder>` 标签剥离
- 长回复分片：3500 字符/片，换行优先；超过 5 片整体降级为 `response.txt` 文档发送
- 文档降级时手动反转义 HTML 实体（`&lt;` → `<`），避免二次解码

---

## 6. 开发与测试

```bash
bun run lint                          # Biome 检查
bun run typecheck                     # 类型检查
bun test                              # 单元测试（含 fake serve 全流程）
bun tests/integration.ts              # 集成测试（真实 mimo serve）
MIMO_SKIP_REAL_PROMPT=1 bun tests/integration.ts   # 跳过真实 LLM prompt
```

### 单元测试覆盖（src/mimo.test.ts）

- `parseModel` / `toRunEvent` / `parseSse` 纯函数（事件协议转换）
- `MimoServer`：managed/外部模式、url、health 探测
- `MimoClient`（node:http fake serve）：会话 CRUD、prompt 参数、SSE 事件累积、404 自动重试、超时 abort、权限路由（按钮回调 / 自动放行）

### 集成测试（tests/integration.ts）

需真实 `mimo` CLI（未装则跳过）。覆盖：serve 启动与健康检查、agent 列表、真实 prompt 往返、失效会话自动恢复、会话 CRUD。
