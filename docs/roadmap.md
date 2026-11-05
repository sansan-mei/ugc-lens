# 开发路线

按步骤实现，每一步都能独立运行、能看到效果。先把 Agent 循环和 function call 吃透，再接业务。

每一步的格式：**目标 → 要掌握的概念 → 完成标准**。完成一步后在这里打勾，并把踩过的坑记到该步骤下面的“笔记”里。

**每一步的完成标准都包含测试**：在 `test/` 下有对应的测试用例，`npm test` 全部通过。测试规范见 `AGENTS.md`。

---

## 阶段一：Agent 基础

### 第 0 步：项目初始化

- 目标：搭好能运行 TypeScript 的空项目。
- 内容：`package.json`、`tsconfig.json`、`.env.example`（列出 [providers.md](providers.md) 中各家的 key 环境变量），用 `tsx` 直接运行 `.ts` 文件。
- 完成标准：`node examples/00_hello.ts` 能打印输出。
- 笔记：
  - Node 22.18 起可以直接运行 `.ts` 文件（类型剥离），不需要 tsx。代价是不能用 `enum`、`namespace` 这类需要编译的语法（tsconfig 里的 `erasableSyntaxOnly` 会检查），相对导入要写 `.ts` 后缀。
  - 依赖全部固定精确版本，`bunfig.toml` 和 `.npmrc` 已配置，新增依赖时自动写入精确版本。

### 第 1 步：调用一次模型

- 目标：用 `fetch` 直接调用 OpenAI 兼容的 `/chat/completions` 接口，不用 SDK。
- 要掌握的概念：
  - `messages` 数组和三种角色：`system`、`user`、`assistant`
  - 请求参数：`model`、`temperature`、`max_tokens`
  - 返回结构：`choices[0].message`、`finish_reason`、`usage`
- 要实现：读取配置，根据 `provider` 和 `region` 得到接口地址和 key（提供商预设表见 [providers.md](providers.md)）。
- 完成标准：发一个问题，打印回答和 token 用量；换一个提供商只需改配置。
- 笔记：
  - 代码：`src/llm/providers.ts`（预设表）、`src/config.ts`（读取配置）、`src/llm/client.ts`（调用接口）。
  - 运行：`npm run models` 列出模型，`npm run chat -- "问题"` 发起对话。
  - DeepSeek 当前 `/models` 返回 `deepseek-flash`、`deepseek-v4-pro`，默认用 `deepseek-flash`。
  - 测试：`test/config.test.ts`（配置优先级、region、.env、错误提示）、`test/llm/client.test.ts`（用本地 HTTP 服务模拟接口）。

### 第 2 步：多轮对话

- 目标：在命令行里和模型连续对话。
- 要掌握的概念：模型本身没有记忆，“记忆”就是每次把完整的 `messages` 发过去；历史越长，token 越多。
- 完成标准：第二轮问“我刚才问了什么”，模型能答对；每轮打印累计 token。
- 笔记：
  - 代码：`examples/02_multi_turn.ts`，运行 `npm run multi`。
  - 多轮对话不需要改模型客户端，只是调用方自己维护 `messages` 数组。
  - 观察：第一轮 input 48 token，第二轮 69 token。历史越长，每轮发送的 token 越多，这是后面要做上下文压缩的原因。
  - `deepseek-flash` 回答很短时 output token 也有几十个，可能包含了模型内部推理的 token，统计费用时要注意。
  - 后来把历史管理抽成 `src/llm/conversation.ts`，示例只负责命令行交互。测试：`test/llm/conversation.test.ts`。

### 第 3 步：Agent 循环骨架（用假模型）

- 目标：先不接真实模型，用一个按剧本返回结果的“假模型”写出循环。
- 为什么用假模型：循环的难点是控制流程（何时继续、何时停止、出错怎么办），跟模型能力无关。假模型的结果固定，便于反复测试每种分支。
- 要掌握的概念：
  - 循环结构：调用模型 → 有工具请求就执行并把结果放回 messages → 没有就结束
  - 终止条件：`max_steps`、超时、取消（`AbortController`）
  - 运行记录 `steps`：每一步记录下来，结束时完整打印
- 完成标准：准备 3 个剧本并都能跑通：
  1. 直接回答（0 次工具调用）
  2. 调用 2 次工具后回答
  3. 一直请求工具，最终被 `max_steps` 停止
- 笔记：
  - 代码：`src/agent/loop.ts`（循环）、`src/agent/fake_model.ts`（假模型）、`src/agent/events.ts`（运行事件）、`src/tools/types.ts`（工具定义）、`src/cli/format_event.ts`（把事件打印成文本）。
  - 运行：`npm run loop` 跑全部 4 个场景（多了一个“连续调用不存在的工具，被 `tool_errors` 停止”），`node examples/03_agent_loop.ts 2` 只跑某一个。
  - 循环只依赖 `AgentModel` 接口（`complete(request)`），所以假模型和真实模型可以互换。第 4 步只需要让真实客户端实现这个接口。
  - 停止检查放在“工具执行之后、下一次调用模型之前”。这样收尾说明可以附加在还没发出的工具结果上，不需要伪造 user 消息。
  - 收尾调用仍然带工具定义，但 `tool_choice` 设为 `none`。
  - 假模型会检查剧本是否合理：`tool_choice` 为 `none` 时还返回工具调用，或者剧本用完，都会报错。这能提前发现测试写错的情况。
  - 测试：`test/agent/loop.test.ts`（16 个用例，覆盖 6 种停止原因、工具错误、参数错误、事件顺序和循环不变式）、`test/cli/format_event.test.ts`。

### 第 4 步：接入真实模型的 function call

- 目标：把假模型换成真实模型，实现三个基础工具 `read_file`、`write_file`、`run_command`。
- 要掌握的概念：
  - 请求里的 `tools` 字段：工具名、描述、参数的 JSON Schema
  - 返回里的 `tool_calls`：`id`、`function.name`、`function.arguments`（是字符串，需要自己 `JSON.parse`）
  - 工具结果消息：`{ role: "tool", tool_call_id, content }`，`tool_call_id` 必须对应上
  - `tool_choice`：`auto` / `none` / 指定工具
  - 模型可能在一次返回里请求多个工具（并行调用）
  - 有副作用的工具需要人工确认，确认方式由入口层决定
- 完成标准：问“现在几点，离今年结束还有几天”，模型调用工具后回答；打印完整 `steps`。
- 笔记：
  - 代码：`src/llm/client.ts`（发送 tools、解析 tool_calls）、`src/agent/llm_model.ts`（把客户端包装成 `AgentModel`）、`src/tools/builtin/`（三个工具和只读白名单）、`src/tools/approval.ts`（确认请求）、`src/cli/approve.ts`（命令行 y/N 确认）。
  - 运行：`npm run tools -- "问题"`。不在终端里运行时，需要确认的操作一律拒绝。
  - 循环代码没有改动，只给 `ToolContext` 加了 `cwd` 和 `approve`。第 3 步的 `AgentModel` 接口设计让真实模型可以直接替换假模型。
  - 没有工具时请求里不带 `tools` 和 `tool_choice`，部分提供商遇到空数组会报错。
  - 客户端会统一各家 tool_calls 的格式差异：缺 `id` 时补上，`arguments` 是对象时转成字符串。
  - DeepSeek 实测：先调用 `date` 取得时间（只读命令，不需要确认），再想用 `python3` 计算天数，被拒绝后改为自己推算。推算结果有一处前后不一致（“距 1 月 1 日 57 天”与“到 12 月 31 日含今天 58 天”），说明日期计算这类事情应该交给工具做。
  - 坑：`readline` 的 `question()` 在输入流结束时既不返回也不报错，确认函数会一直挂住。需要同时监听 `close` 事件，测试里已覆盖。
  - 测试：`test/llm/client.test.ts`（tools 往返）、`test/agent/llm_model.test.ts`（真实客户端 + 循环，走本地 HTTP 服务）、`test/tools/`（三个工具、白名单、参数辅助函数）、`test/cli/approve.test.ts`。
### 第 5 步：工具注册与参数校验

- 目标：抽象出统一的 `Tool` 定义，用 Zod 描述参数，新增 `calculate` 工具。
- 要掌握的概念：
  - 用一份 Zod 定义生成 JSON Schema，并校验模型传回的参数
  - 工具的 `description` 怎么写，会直接影响模型是否调用、怎么传参
  - 参数错误、工具报错时，把错误作为工具结果返回，让模型自己修正
- 完成标准：故意让模型传错参数（例如描述写得含糊），观察它收到错误后能自己修正；连续出错 3 次时循环停止。
- 笔记：
  - 代码：`src/tools/define.ts`（`defineTool`、`toParametersSchema`、`ToolArgumentError`）、`src/tools/builtin/calculate.ts`。三个基础工具改用 Zod，删除了手写的 `args.ts`，路径处理移到 `src/tools/paths.ts`。
  - 依赖：`zod@4.6.7`。Zod 4 自带 `z.toJSONSchema`，不需要额外的转换库。
  - 转换结果要清理：默认输出带 `$schema`（部分提供商会拒绝），`z.number().int()` 会带上 `maximum: 9007199254740991` 这类边界，都去掉。
  - 用 `io: 'input'` 生成 JSON Schema：带默认值的字段对模型来说是可选的。
  - 循环保留底层 `AgentTool` 接口，假模型测试里手写的工具不受影响。
  - 运行：`npm run params`。实验工具 `days_between` 要求日期写成 `YYYY/MM/DD`，规则用 `refine` 写，不出现在 JSON Schema 里，描述也只写了“计算两个日期的间隔”。
  - DeepSeek 实测：第 1 步并行发出 2 个调用，都按习惯写成 `2026-11-05`，收到“日期格式必须是 YYYY/MM/DD（收到："2026-11-05"）”后，第 2 步全部改对，最终答案正确（50 天、93 天）。错误提示写清楚“哪个参数、错在哪、收到什么”，模型一次就能改对。
  - 教训：`refine` 的规则模型事先看不到，每次都要先错一次，浪费一轮调用。真实工具里能用 `regex`、`enum` 表达的约束，就不要用 `refine`。
  - 连续出错 3 次停止已在第 3 步实现（`tool_errors`），本步没有改动。
  - 测试：`test/tools/define.test.ts`、`test/tools/builtin/calculate.test.ts`、`test/tools/paths.test.ts`，`test/agent/loop.test.ts` 新增“参数错误与执行失败区分”。
### 第 6 步：预算与稳定性

- 目标：补齐终止条件和模型调用的重试。
- 要掌握的概念：token 预算、总耗时上限、限流和网络错误的指数退避重试、达到上限后的“收尾回答”。
- 完成标准：把预算设得很小，循环能按 `token_budget` 停止，并给出说明信息不足的收尾回答。
- 笔记：
  - 代码：`src/llm/retry.ts`（可重试判断、退避时间、`Retry-After` 解析、`withRetry`）、`src/llm/client.ts`（把网络错误、超时、HTTP 错误统一成带 `retryable` 标记的 `LlmError`）。终止条件和收尾调用在第 3 步已经实现，这一步没有改。
  - 运行：`npm run retry -- retry` 用本地模拟服务演示重试（不消耗 token），`npm run retry -- budget` 用真实模型验证 token 预算。
  - 本地演示：503 → 等 0.9 秒重试 → 429（`Retry-After: 2`）→ 按要求等 2 秒 → 成功。
  - 怎么区分“单次请求超时”和“运行总超时”：两者都表现为 `TimeoutError`。客户端先看调用方的 `signal` 是否已触发：触发了就是运行被取消或总时间用完，原样抛出、不重试；否则才是单次请求超时，可以重试。
  - 等待重试用可取消的 `setTimeout`（`node:timers/promises`），运行被取消时不会继续等完。
  - 重试信息通过 `AgentModelRequest.onRetry` 回调从客户端传到循环，再由循环发出 `model_retry` 事件。客户端不需要知道运行事件。
  - DeepSeek 实测 token 预算 3000：第 1 步后累计约 1000，第 2 步本身约 3000，之后触发 `token_budget`，收尾调用约 5600，总计约 8800。**预算是软上限**：只在每一步开始前检查，正在进行的调用和收尾调用都不受限制。历史越长，每次调用越贵（每次都要重发全部历史），超出越多。
  - 限流不单独处理：429 走同一套重试逻辑。主动限速（控制并发数）等第 9 步流水线需要并行调用时再做。
  - 测试：`test/llm/retry.test.ts`，`test/llm/client.test.ts` 新增“重试”一组（503 后成功、429 带等待时间、4xx 不重试、重试用完、连接失败、调用方取消），`test/agent/loop.test.ts` 新增 `model_retry` 事件，`test/config.test.ts` 新增 `max_retries`。
---

## 阶段二：接入业务数据

### 第 7 步：统一数据格式与第一个数据源

- 目标：定义 `FeedbackItem` / `Dataset`，实现 media_crawl 的 B 站数据适配器。
- 完成标准：读入一个 `bilibili_all.json`，转换成统一格式并打印统计数量。
- 笔记：
  - 代码：`src/dataset/types.ts`（统一格式）、`src/dataset/stats.ts`（`computeStats`）、`src/sources/`（文件识别 `detectFile`、`loadDataset`、B 站适配器 `media_crawl/bilibili.ts`）。格式说明见 `docs/architecture.md` 第 5 节。
  - 运行：`npm run stats` 读测试样本；`node examples/07_dataset_stats.ts <文件>` 读自己的文件。
  - 先看真实数据再定格式：本机 26 个 `bilibili_all.json`（3330 条评论、7306 条回复、33637 条弹幕）全部转换成功，ID 没有重复，弹幕时间全部能解析。
  - 文件里没有视频 ID，只能从路径取：优先找 BV 号目录，其次取目录名末尾的 av 号。两者都没有就报错，不猜。
  - 时间单位不统一：评论 `time` 是毫秒，`pubdate` 是秒，弹幕 `time` 是视频内的 `时:分:秒`。统一转成 ISO 时间和 `video_time_sec`。
  - 平台显示的回复数（`replyCount` 合计 14335）远大于实际搜集到的（7306），统计里分开给出 `reported` 和 `collected`，分析结论要考虑样本不完整。
  - 原始数据用 Zod 校验：格式不对时报出具体位置（如 `video_comments.0.content`），而不是在后面某处读到 `undefined`。
  - 文件识别用白名单：只认 `bilibili_all.json`；小红书、知乎等文件名明确提示“暂不支持”，`all_search.json` 等汇总文件忽略。
  - 测试样本：从真实文件截取几条，用户名、mid、rpid、弹幕发送者、封面替换成假值，`@用户名` 替换为 `@某用户`。
  - 测试：`test/sources/index.test.ts`、`test/sources/media_crawl/bilibili.test.ts`、`test/sources/validate.test.ts`、`test/dataset/stats.test.ts`。

### 第 8 步：数据工具

- 目标：实现 `get_dataset_stats`、`search_feedback`、`get_feedback`。
- 要掌握的概念：工具结果的长度控制（分页、截断说明），避免把整个数据集塞进上下文。
- 完成标准：`ask "这个视频的评论主要在吐槽什么"`，Agent 自己检索后回答，并给出评论 ID 作为证据。

### 第 9 步：分析流水线

- 目标：实现第 6 节的固定步骤：统计、分块总结、合并、引用校验、写报告。
- 完成标准：`analyze` 一个文件，生成带引用的 Markdown 报告，报告末尾有耗时和 token 消耗。

### 第 10 步：监听目录

- 目标：`watch` 命令，新文件写入完成后自动触发分析；任务状态持久化，重启后继续未完成的任务。
- 完成标准：把文件复制进目录后自动生成报告；同一文件不重复分析。

---

## 阶段三：对外接入与迭代

### 第 11 步：MCP 服务

- 目标：把数据工具和 `analyze`、`ask` 作为 MCP 工具暴露出去，附 `SKILL.md`。
- 完成标准：在 Claude Code 里配置后，能直接让它分析某个文件。

### 第 12 步：playbook 与 learnings

- 目标：分析规则从代码中移到 `playbook.md`；每次运行后追加 `learnings.md`。
- 完成标准：修改 playbook 中一条规则，重跑回归样本后能看到报告的对应变化。

### 第 13 步：第二个数据源与发布

- 目标：接入 MediaCrawler 的输出，发布第一个 npm 版本。
- 完成标准：`npx ugc-lens analyze` 在一台新电脑上能直接运行。

---

### 第 14 步（可选）：图形界面

- 目标：`ugc-lens ui` 启动本地 Web 页面，展示任务列表、运行进度和报告。
- 前提：运行事件（架构文档第 3.5 节）和只读查询接口已经稳定。
- 完成标准：在页面上选择一个文件发起分析，实时看到进度，结束后直接阅读报告。

---

## 进度

- [x] 第 0 步　项目初始化
- [x] 第 1 步　调用一次模型
- [x] 第 2 步　多轮对话
- [x] 第 3 步　Agent 循环骨架（假模型）
- [x] 第 4 步　真实模型的 function call
- [x] 第 5 步　工具注册与参数校验
- [x] 第 6 步　预算与稳定性
- [x] 第 7 步　统一数据格式与第一个数据源
- [ ] 第 8 步　数据工具
- [ ] 第 9 步　分析流水线
- [ ] 第 10 步　监听目录
- [ ] 第 11 步　MCP 服务
- [ ] 第 12 步　playbook 与 learnings
- [ ] 第 13 步　第二个数据源与发布
- [ ] 第 14 步　图形界面（可选）
