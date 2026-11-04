# ugc-lens 架构设计

> 版本：v0.1 草案。实现过程中有变化，先改这份文档再改代码。

## 1. 定位

ugc-lens 是一个**分析用户互动内容（评论、弹幕、回复等）的轻量 Agent**，以 npm 包发布。核心不依赖任何界面，图形界面作为可选入口后续提供（见第 2.1 节）。

- 输入：各平台搜集得到的数据文件（如 media_crawl 的 `*_all.json`、MediaCrawler 的输出）。
- 输出：带证据引用的分析报告（Markdown / 单文件 HTML），以及可追问的结论。
- 使用方式：命令行、代码调用、MCP 服务（供 Claude Code、Codex 等宿主 Agent 调用）。

不做的事：
- 不做数据搜集（第二版通过数据源接口接入外部搜集工具）。
- 不做通用研究 Agent，不做多 Agent 协作。
- 不绑定任何一个数据来源或模型厂商。

## 2. 总体分层

```
┌──────────────────────────────────────────────────────┐
│ 入口层   CLI (watch / analyze / ask)   MCP 服务   代码 API │
└──────────────┬───────────────────────────┬───────────┘
               │                           │
     ┌─────────▼─────────┐       ┌─────────▼─────────┐
     │  分析流水线 (固定步骤) │       │  Agent 循环 (ask)   │
     │  解析→统计→分块总结→  │       │  模型自己决定调用哪些工具 │
     │  合并→引用校验→写报告  │       └─────────┬─────────┘
     └─────────┬─────────┘                 │
               │        ┌──────────────────▼──┐
               └───────►│  工具层 (function call) │
                        └──────────┬──────────┘
          ┌────────────────────────┼───────────────────────┐
   ┌──────▼──────┐        ┌────────▼───────┐       ┌───────▼───────┐
   │ 数据源适配器   │        │ 模型客户端         │       │ 本地存储          │
   │ media_crawl  │        │ OpenAI 兼容接口    │       │ 任务状态 / 报告     │
   │ MediaCrawler │        │ (见 providers.md)  │       │ playbook /     │
   │ 通用 JSON/CSV │        │                  │       │ learnings      │
   └─────────────┘        └────────────────┘       └───────────────┘
```

两条执行路径共享同一套工具层：

| 路径 | 什么时候用 | 谁决定下一步 |
|---|---|---|
| 分析流水线 | 新数据文件到达、`analyze` 命令 | 代码（步骤固定） |
| Agent 循环 | `ask` 追问、MCP 调用、第二版研究循环 | 模型 |

原则：**能用固定步骤完成的不交给模型决定**。只有需要根据中间结果选择下一步的场景才用 Agent 循环。

### 2.1 图形界面（可选，后续）

- 核心包不包含任何界面代码。命令行、MCP、图形界面都只是入口层，调用同一套代码 API。
- 图形界面优先做成本地 Web 页面：`ugc-lens ui` 启动一个本地 HTTP 服务并打开浏览器，不引入 Electron。
- 为了让界面以后能直接接入，核心从第一版起就要提供两样东西：
  1. **运行事件流**（第 3.5 节）：界面靠它显示进度，命令行也用它打印进度。
  2. **只读的状态与报告接口**：任务列表、报告、数据集统计都能通过代码 API 查询，不需要界面去读内部文件。

## 3. Agent 循环

### 3.1 基本原理

Agent 的本质是一个 while 循环：

```
messages = [system, user]
loop:
    response = 调用模型(messages, tools)
    messages.push(response)
    if response 没有 tool_calls:
        结束，response.content 就是最终回答
    for each tool_call in response.tool_calls:
        result = 执行工具(tool_call.name, tool_call.arguments)
        messages.push({ role: "tool", tool_call_id, content: result })
    检查终止条件（步数、token、时间、取消）
```

要点：
- **模型不会执行任何东西**。它只返回“我想调用某个工具、参数是什么”，执行是我们的代码做的。
- **循环由工具调用驱动**。模型不再请求工具时，循环自然结束。
- **messages 就是 Agent 的全部记忆**。每轮都把完整历史发给模型。

### 3.2 终止条件

任何一条满足就停止，并在结果里写明停止原因：

| 条件 | 默认值 | 停止原因 |
|---|---|---|
| 模型不再请求工具 | - | `completed` |
| 最大循环步数 | 10 | `max_steps` |
| 累计 token 预算 | 100k | `token_budget` |
| 总耗时 | 5 分钟 | `timeout` |
| 用户取消（AbortSignal） | - | `aborted` |
| 连续工具错误 | 3 次 | `tool_errors` |

停在 `max_steps`、`token_budget`、`tool_errors` 时，做一次**收尾调用**，让模型基于已有信息回答，并说明哪些信息不足：

- 请求里仍然带上工具定义，但设置 `tool_choice: "none"`，模型只能用文字回答。部分提供商要求：历史里出现过工具调用时，请求必须带工具定义。
- 收尾说明附加在**最后一条、还没发给模型的工具结果**末尾，不额外插入 user 消息（见第 8.2 节）。停止检查发生在工具执行之后、下一次调用模型之前，所以这条工具结果一定还没发出去。
- `timeout`、`aborted` 不做收尾调用：时间已经用完，或用户已经取消。

### 3.3 错误处理

- 工具执行出错**不抛异常中断循环**，而是把错误信息作为工具结果返回给模型，让它换参数重试或换方法。
- 模型返回的参数不是合法 JSON，或者不符合 schema：同样作为工具结果返回错误说明。
- 模型接口本身出错（网络、限流）：在模型客户端里按指数退避重试，重试用完再让循环失败。

### 3.4 循环的输出

```ts
interface AgentRunResult {
  answer: string            // 最终回答
  stop_reason: 'completed' | 'max_steps' | 'token_budget' | 'timeout' | 'aborted' | 'tool_errors'
  steps: AgentStep[]        // 每一步的模型输出和工具调用，用于调试和展示
  usage: { input_tokens: number; output_tokens: number }
  duration_ms: number
}
```

`steps` 是调试和学习的关键：每次运行都能完整回看模型“想了什么、调了什么、拿到了什么”。

### 3.5 运行事件

循环和流水线在运行过程中发出事件，入口层（命令行、MCP、图形界面）订阅后各自展示：

```ts
type RunEvent =
  | { type: 'run_start'; run_id: string; kind: 'agent' | 'pipeline' }
  | { type: 'model_start'; run_id: string; step: number; final: boolean }   // final：收尾调用
  | { type: 'model_delta'; run_id: string; step: number; text: string }     // 流式输出时的增量文本
  | { type: 'model_end'; run_id: string; step: number; usage: Usage; tool_calls: number }
  | { type: 'tool_start'; run_id: string; step: number; call_id: string; name: string; args: unknown }
  | { type: 'tool_end'; run_id: string; step: number; call_id: string; name: string; ok: boolean; duration_ms: number }
  | { type: 'pipeline_stage'; run_id: string; stage: string; progress?: number }
  | { type: 'run_end'; run_id: string; stop_reason: string; usage: Usage; duration_ms: number }
```

每个事件都带 `run_id`，同时有多个运行时（比如监听目录时并发分析），入口层也能区分。

核心只负责发出事件，不关心谁来显示。这样命令行打印进度和图形界面画进度条，用的是同一份数据。

### 3.6 完整流程图

对应 `src/agent/loop.ts` 的 `runAgent`：

```
                         runAgent(options)
                                │
         ┌──────────────────────▼──────────────────────┐
         │ 初始化                                       │
         │ messages = 复制初始消息（不改调用方的数组）        │
         │ 合并 limits、生成 run_id、合并取消信号与超时信号     │
         │ emit run_start                               │
         └──────────────────────┬──────────────────────┘
                                │
     ┌─────────────────────────►│  step = 1, 2, 3 …
     │                          ▼
     │        ┌───────────────────────────────────┐   是
     │        │ ① 停止检查                          ├────────┐
     │        │ 取消？→ aborted   超时？→ timeout     │        │
     │        │ token 超预算？→ token_budget         │        │
     │        │ 连续全失败达上限？→ tool_errors        │        │
     │        │ step > maxSteps？→ max_steps        │        │
     │        └─────────────────┬─────────────────┘        │
     │                          │ 否                        │
     │                          ▼                           │
     │        ┌───────────────────────────────────┐        │
     │        │ ② 调用模型（tool_choice: auto）       │        │
     │        │ emit model_start / model_end       │        │
     │        │ 累加 usage                          │        │
     │        │ 抛异常：因取消/超时 → 停止；否则向上抛出   ├────────┤
     │        └─────────────────┬─────────────────┘        │
     │                          ▼                           │
     │        ┌───────────────────────────────────┐        │
     │        │ ③ messages.push(assistant 消息)     │        │
     │        │ steps.push(本步记录)                 │        │
     │        └─────────────────┬─────────────────┘        │
     │                          ▼                           │
     │                 有 tool_calls 吗？ ── 没有 ── completed ─┤
     │                          │ 有                         │
     │                          ▼                           │
     │        ┌───────────────────────────────────┐        │
     │        │ ④ 逐个执行工具（executeToolCall）     │        │
     │        │ emit tool_start / tool_end         │        │
     │        │ 工具不存在 / 参数不是 JSON 对象 /      │        │
     │        │ 执行抛异常 → 都转成“错误：…”文字       │        │
     │        │ 每个 tool_call 都 push 一条 tool 消息  │        │
     │        └─────────────────┬─────────────────┘        │
     │                          ▼                           │
     │        ┌───────────────────────────────────┐        │
     │        │ ⑤ 本步工具全部失败？                  │        │
     │        │ 是：连续失败计数 +1   否：清零          │        │
     │        └─────────────────┬─────────────────┘        │
     └──────────────────────────┘                          │
                                                           ▼
                                   ┌───────────────────────────────────┐
                                   │ 停止原因是 max_steps / token_budget   │
                                   │ / tool_errors 吗？                  │
                                   └───────┬────────────────┬──────────┘
                                         是│                │否
                                           ▼                │ completed：answer = 模型回答
                    ┌──────────────────────────────────┐   │ timeout / aborted：answer 为空
                    │ ⑥ 收尾调用 finalize               │   │
                    │ 收尾说明附加到最后一条还没发出的       │   │
                    │ tool 消息末尾（不插入 user 消息）     │   │
                    │ 调用模型（tool_choice: none）       │   │
                    │ 结果记为 final 步，作为 answer       │   │
                    └────────────────┬─────────────────┘   │
                                     ▼                     ▼
                    ┌──────────────────────────────────────────┐
                    │ emit run_end                             │
                    │ 返回 { run_id, answer, stop_reason, steps, │
                    │        messages, usage, duration_ms }     │
                    └──────────────────────────────────────────┘
```

读图要点：

- 停止检查（①）在每一步开头，也就是**上一步工具执行之后、下一次调用模型之前**。所以收尾时最后一条消息一定是还没发出的 tool 消息，可以把说明附加在上面。
- 只有模型接口异常会向上抛出；工具层面的所有错误都变成 tool 消息交给模型（第 3.3 节）。
- 所有停止情况都从循环的 `break` 出来，收尾、发出 `run_end`、组装结果统一在循环外处理。

## 4. 工具层（function call）

### 4.1 工具定义

```ts
interface Tool<P> {
  name: string              // snake_case，如 search_feedback
  description: string       // 写给模型看：做什么、什么时候用、返回什么
  parameters: ZodSchema<P>  // 参数校验，同时转成 JSON Schema 发给模型
  handler: (params: P, ctx: ToolContext) => Promise<ToolResult>
}
```

- 参数用 Zod 定义，一份定义同时用于“告诉模型参数格式”和“校验模型传回的参数”。
- `description` 的质量直接决定模型会不会正确使用工具，要当作提示词来写。
- 工具结果统一转成字符串返回给模型，超过长度上限时截断，并注明“已截断，可用分页参数继续读取”。

### 4.2 工具清单（按实现顺序）

| 阶段 | 工具 | 作用 |
|---|---|---|
| 基础 | `read_file` / `write_file` / `run_command` | 读写本地文件、执行命令，验证调用链路和确认机制（见 4.3） |
| 练习 | `calculate` | 有参数的工具，验证参数校验 |
| 数据 | `list_datasets` | 列出已导入的数据集 |
| 数据 | `get_dataset_stats` | 数量、时间分布、地域分布、高赞内容 |
| 数据 | `search_feedback` | 按关键词、时间、点赞数筛选互动内容，分页返回 |
| 数据 | `get_feedback` | 按 ID 读取单条内容及上下文（回复链） |
| 报告 | `list_reports` / `get_report` | 读取已生成的报告 |
| 第二版 | `collect` | 通过数据源接口补充搜集 |

### 4.3 基础工具与确认

`src/tools/builtin/` 提供三个通用工具，用来练习 function call，也让 `ask` 能直接查看本地文件：

| 工具 | 参数 | 行为 | 需要确认 |
|---|---|---|---|
| `read_file` | `path`、`offset`、`limit` | 带行号返回文本，默认每次 500 行、最多 1 万字符，结果末尾提示下一段的 `offset`；拒绝目录、二进制和超过 10 MB 的文件 | 不需要 |
| `write_file` | `path`、`content` | 写入完整内容，自动创建上级目录 | 覆盖已有文件时需要 |
| `run_command` | `command` | 用 shell 在工作目录执行，合并 stdout 和 stderr，返回退出码；30 秒超时，输出超过 1 万字符时保留开头和结尾 | 只读白名单以外的命令需要 |

规则：

- **路径不限制范围**。相对路径以工作目录（`runAgent` 的 `cwd`，默认 `process.cwd()`）为基准，支持 `~`。
- **确认由入口层提供**。工具通过 `ctx.approve(request)` 请求确认，命令行在终端里询问 y/N，代码调用方传入自己的函数。没有提供确认函数时**一律拒绝**。用户拒绝时工具返回错误，交给模型换个办法。
- **只读白名单偏保守**（`command_policy.ts`）：命令名在白名单内（`ls`、`cat`、`rg`、`git status` 等），不含重定向、`;`、`&&`、`$`、反引号等字符，也不带 `find -exec`、`sort -o` 这类会写文件或执行程序的参数，才直接执行。管道只允许连接白名单命令。判断不了的写法一律需要确认。
- **子进程拿不到模型 key**：执行命令时去掉所有以 `_API_KEY` 结尾的环境变量。
- 超时或取消时结束整个进程组，避免命令留下后台子进程。

## 5. 统一数据格式

所有数据源都先转换成统一格式，后续步骤只认这一种格式。

```ts
interface FeedbackItem {
  id: string                       // 全局唯一：`${platform}:${原始ID}`
  platform: 'bilibili' | 'douyin' | 'xhs' | 'youtube' | 'zhihu' | 'weibo' | string
  kind: 'comment' | 'reply' | 'danmaku'
  content_id: string               // 所属视频或帖子
  parent_id?: string               // 回复的上级评论
  text: string
  author?: { id?: string; name?: string; location?: string }
  likes?: number
  reply_count?: number
  created_at?: string              // ISO 8601
  video_time_sec?: number          // 弹幕在视频中的时间点
}

interface Dataset {
  id: string
  source: string                   // 数据源适配器名称，如 media_crawl
  file_path: string
  content: { id: string; title?: string; url?: string; author?: string }[]
  items: FeedbackItem[]
  imported_at: string
}
```

具体字段在接入第一个数据源时，根据 media_crawl 和 MediaCrawler 的实际输出再确认。

## 6. 分析流水线（固定步骤）

```
1. 识别与解析   找到匹配的数据源适配器，转成 Dataset
2. 统计        纯代码：数量、分布、高赞、关键词
3. 分块总结     评论按数量分块，并行调用模型，每块输出结构化要点 + 引用 ID
4. 合并        汇总各块要点，生成整体结论
5. 引用校验     检查结论引用的 ID 是否存在；抽查原文是否支持结论
6. 写报告      输出 Markdown / HTML，附运行信息（耗时、调用次数、token）
7. 复盘        记录本次问题到 learnings.md
```

## 7. 规则迭代：playbook 与 learnings

| 文件 | 作用 | 修改方式 |
|---|---|---|
| `playbook.md` | 分析规则和提示词，按平台、数据类型分节，带版本号 | Agent 提出修改建议，人确认后合入 |
| `learnings.md` | 每次运行暴露的问题、用户反馈、总结出的规则 | 只追加，Agent 自动写 |

- 包内带一份默认 playbook，`init` 时复制到用户目录，之后只改用户的副本。
- 每份报告记录所用的 playbook 版本。
- 准备 3~5 个固定样本作为回归集，修改 playbook 后重跑对比。

## 8. 记忆与上下文

参考 Hermes Agent 的记忆设计（MEMORY.md / USER.md、冻结快照、会话检索、上下文压缩）。ugc-lens 要记住的是**分析经验**，不是用户画像。

### 8.1 分层

| 层 | 内容 | 生命周期 | 怎么进入模型 |
|---|---|---|---|
| 运行上下文 | 一次运行的 `messages` | 单次运行 | 每次调用全部发送 |
| 运行记录 | `steps` 和事件，保存到 `.ugc-lens/runs/<run_id>.json` | 长期 | 不注入；用于调试、展示和检索 |
| playbook | 分析规则（第 7 节） | 长期，有字数上限 | 运行开始时注入 system prompt，运行中冻结 |
| learnings | 每次运行暴露的问题和反馈 | 长期，只追加 | 不注入；Agent 需要时用工具检索 |
| 数据集与报告 | 统一格式的数据、生成的报告 | 长期 | 不注入；通过数据工具读取 |

### 8.2 规则

1. **system prompt 在一次运行中不变**。运行开始时组装（基础指令 + playbook 快照），运行中不修改。运行中提出的 playbook 修改，下一次运行才生效。这样每次调用的前缀相同，能命中提供商的提示词缓存。
2. **不伪造消息、不改历史**。循环中不插入程序生成的 user 消息，不修改已经发给模型的消息。唯一的例外是以后的上下文压缩（8.3）。
3. **工具调用与结果严格对应**。带 `tool_calls` 的 assistant 消息后面，必须紧跟每个 `tool_call_id` 对应的 tool 消息，工具出错也要有结果。
4. **playbook 有字数上限**（默认 4000 字符）。写入超限时工具返回错误，附上当前用量、超出多少和现有条目，由 Agent 合并或删除旧条目后重试；不自动压缩。
5. **写入只能通过工具**。`playbook_update` 工具接收一批 `add` / `patch` / `remove` 操作，`patch` 和 `remove` 用唯一子串定位条目。写入先放进待审核区（`.ugc-lens/playbook.pending.json`），用户确认后才生效。模型口头说“已记录”不算数。
6. **写入前检查内容**。拒绝疑似密钥、隐藏的 Unicode 字符、类似“忽略之前的指令”的注入内容，因为 playbook 会进入 system prompt。
7. **检索返回原文**。检索 learnings 和运行记录时返回原文片段，不经过模型总结，避免丢失细节。

### 8.3 上下文长度

第一版不做上下文压缩，靠这两点控制长度：工具结果截断和分页（第 4.1 节）；`ask` 循环有步数上限。

以后需要时参考 Hermes 的做法：用到上下文窗口一定比例时，保留开头几条和最近若干条消息，中间部分用单独一次模型调用生成摘要。这是唯一允许改动历史的情况。

## 9. 目录结构（规划）

```
ugc-lens/
  src/
    agent/        Agent 循环、终止条件、运行记录
    llm/          模型客户端（OpenAI 兼容）
    tools/        工具定义与注册
    sources/      数据源适配器
    pipeline/     分析流水线
    store/        本地状态与报告读写
    cli/          命令行入口
    mcp/          MCP 服务
  playbook/       默认 playbook
  examples/       练习脚本、样本数据
  test/           测试用例（node:test），目录结构与 src/ 对应
  docs/
```

## 10. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript | 类型约束工具参数和数据格式 |
| 运行时 | Node.js ≥ 22.18（开发和运行都用 Node） | 以兼容为主；Bun 只用于安装依赖 |
| 模型接口 | OpenAI 兼容 Chat Completions，用户自选提供商 | 一个客户端覆盖国内外主流厂商和本地模型，见 [模型提供商](providers.md) |
| Agent 框架 | 不用，手写循环 | 便于学习和掌控细节，依赖少 |
| 参数校验 | Zod | 一份定义同时生成 JSON Schema 和做校验 |
| 本地状态 | JSON 文件 | 避免原生模块安装问题；数据量增长后再考虑 `node:sqlite` |
| 文件监听 | chokidar | 跨平台，支持写入完成判定 |
| MCP | 官方 TypeScript SDK | |
| 依赖版本 | 全部固定精确版本，不使用 `^`、`~` | 避免不同时间安装得到不同版本；由 `bunfig.toml`（`exact = true`）和 `.npmrc`（`save-exact=true`）强制 |

## 11. 待定问题

- [x] 模型提供商：用户自选，列表见 [providers.md](providers.md)
- [ ] 统一数据格式的字段，需对照 media_crawl 与 MediaCrawler 实际输出确认
- [ ] 报告格式：先 Markdown，HTML 何时加入
- [ ] 同一文件被覆盖后，是重新分析还是跳过
