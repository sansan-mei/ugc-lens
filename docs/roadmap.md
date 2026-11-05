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

### 第 7 步：统一数据格式与数据导入

- 目标：定义 `FeedbackItem` / `Dataset`；不绑定任何软件，任意 JSON 文件由模型识别结构、代码按规则转换成统一格式。
- 要掌握的概念：让模型输出“规则”而不是“数据”；用试转换结果给模型反馈；按结构指纹缓存模型的结论。
- 完成标准：读入一个 JSON 文件，转换成统一格式并打印统计数量；结构相同的文件第二次读入不调用模型。
- 笔记：
  - 代码：`src/dataset/`（统一格式、`computeStats`），`src/ingest/`（`shape.ts` 结构摘要与指纹、`mapping.ts` 映射规则、`apply.ts` 试转换、`infer.ts` 模型推断、`cache.ts` 规则缓存、`index.ts` 的 `loadDataset`）。设计见 `docs/architecture.md` 第 5 节。
  - 运行：`npm run stats` 读测试样本；`node examples/07_dataset_stats.ts <文件> [--fresh]` 读自己的文件，`--fresh` 不用缓存。
  - 一开始写的是 media_crawl 专用的 B 站适配器（按文件名白名单识别）。这会把 ugc-lens 和一个软件绑在一起，改成了通用导入，专用适配器已删除。
  - 为什么让模型写规则，而不是让模型逐条转换：3 万条弹幕逐条转换又贵又慢，模型还可能改写原文，破坏后面的引用校验。现在一个文件只调用一两次模型（1.4～3 万 token），转换由代码完成，原文一个字都不经过模型。
  - 为什么不让模型写转换代码：要执行模型写的任意代码，风险大，也难以验证。规则是数据，能用 Zod 校验、能试转换、能缓存、人也能看懂。
  - 试转换报告就是给模型的反馈：哪个集合导入了多少条、每个字段的命中率、哪里错了。模型按报告改规则，和第 5 步“参数错误提示”是同一个思路。
  - 真实数据上发现的问题，都是靠试转换报告暴露、再改规则检查解决的：
    - 模型把 `title` 写在 `content` 下面而不是 `fields` 里，Zod 默认悄悄丢掉。改用 `strictObject`，多写的字段报错。
    - 回复沿用评论的字段规则，回复没有 `reply_count`，模型怎么改都去不掉。改成：写了 `children.fields` 就完全按它来，沿用时缺少的字段只警告。
    - MediaCrawler 的文件里同一条评论出现两次，被当成 ID 重复。改成：ID、正文、所属内容都相同的去重。
    - 模型有时不写内容 ID，程序生成的 `content-1` 又被别的文件复用。改成：有 `content` 规则时必须有 ID 来源。
    - 缓存复用太严格（没有 AI 总结的视频，`summary` 路径不存在就算错误）。改成：缓存规则用在新文件上时，可选字段缺失只警告。
  - 真实数据验证（DeepSeek）：
    - 26 个 B 站 `bilibili_all.json`：调用模型 2 次（第一个文件没有弹幕，规则里没有弹幕集合，遇到有弹幕的文件时提示“有数组没被使用”，于是重新识别），其余全部复用缓存；3330 条评论、7306 条回复、33637 条弹幕，与手写适配器的结果完全一致。
    - 小红书 `all_xhs.json`、知乎 `all_zhihu.json`（回答 → 评论 → 回复三层）、YouTube `youtube_all.json`、MediaCrawler 的扁平评论文件（B 站、知乎、快手），都是第一次提交就通过。
    - MediaCrawler 的 `*_contents_*.json`、`*_creators_*.json` 被模型用 `reject_file` 拒绝，说明是视频列表或用户列表，没有互动内容。
  - 测试：`test/ingest/`（convert、paths、shape、mapping、apply、infer、cache、index），`test/dataset/stats.test.ts`。模型用假模型代替，剧本里直接给出 `submit_mapping` 的参数。
  - 测试样本：从真实 B 站文件截取几条，用户名、mid、rpid、弹幕发送者、封面替换成假值，`@用户名` 替换为 `@某用户`。
### 第 8 步：数据工具

- 目标：实现 `get_dataset_stats`、`search_feedback`、`get_feedback`。
- 要掌握的概念：工具结果的长度控制（分页、截断说明），避免把整个数据集塞进上下文。
- 完成标准：`ask "这个视频的评论主要在吐槽什么"`，Agent 自己检索后回答，并给出评论 ID 作为证据。
- 笔记：
  - 代码：`src/dataset/query.ts`（筛选、排序、分页、回复索引、引用核对），`src/dataset/store.ts`（内存里的数据集列表），`src/tools/data/`（四个工具和统一的单行格式），`src/ask/`（`askDataset`）。设计见 `docs/architecture.md` 第 4.4 节。
  - 运行：`npm run ask` 用测试样本问两个问题（第二个是追问）；`node examples/08_ask.ts <文件...> "问题" "追问"` 用自己的文件。命令行的 `ask` 命令放到 MCP / CLI 入口时再做。
  - 为什么要工具而不是把数据发给模型：3 万条弹幕放不进上下文，放得进也贵。模型只看概况和它查出来的那几十条，原文留在本机。
  - 长度控制的三层：每页条数上限（50）、正文截断（150 字，注明全文长度）、整个结果的字符上限（8000，按整行截断）。截断时一定告诉模型“还有多少、下一页从哪里开始”，否则模型会以为看到的就是全部。
  - 每条结果都以 `[ID]` 开头，回答里也用 `[ID]` 引用，`findCitations` 核对是否存在。第 9 步的引用校验在这个基础上再抽查原文是否支持结论。
  - 真实模型验证（DeepSeek，测试样本 12 条）：第一个问题 5 步、约 1.2 万 token，引用 12 个 ID 全部存在，并主动说明样本只有 3 条评论、回复只搜集到 18%；追问“点赞最多的那条吐槽下面的回复”接着上一轮对话，2 步完成。模型一开始会先调用 `list_datasets`，在 system prompt 里说明只有一个数据集时可以省略。
  - 冒烟时发现：模型引用原文“价格嘛[干杯][干杯]”，`[干杯]` 被当成编造的 ID。改成：原文里出现过的方括号内容不算引用。
  - 测试：`test/dataset/query.test.ts`、`store.test.ts`，`test/tools/data/`（格式、数据集选择、四个工具的分页和截断），`test/ask/index.test.ts`（假模型跑追问、连续追问、步数上限）。

### 第 9 步：分析流水线

- 目标：实现第 6 节的固定步骤：统计、分块总结、合并、引用校验、写报告。
- 完成标准：`analyze` 一个文件，生成带引用的 Markdown 报告，报告末尾有耗时和 token 消耗。
- 用户决定：弹幕先由代码去重、找高峰，只把去重后和高峰附近的交给模型；引用校验只用代码；默认四个分析方向，可传入关注点；预算保持软上限，开始前估算 token。
- 用户决定（参考同类项目后）：先分块找观点，再合并精炼成最多两层的主题，代码校验引用并统计支持条数；每条观点带纳入标准；不做逐条分配和模型自我检查。设计见 `docs/architecture.md` 第 6.3～6.6 节。
- 笔记：
  - 9.1 纯代码分析与分块：`src/analysis/`（归一化、停用词、新词发现、分词、关键词、区分度、时间轴高峰、弹幕去重），`src/pipeline/chunk.ts`。设计见 `docs/architecture.md` 第 6.1、6.2 节。运行：`npm run chunks`，或 `node examples/09_chunks.ts <文件>`。
  - 参考了 media_crawl 的词频分析（`Intl.Segmenter` + 词典保护 + 停用词 + 垃圾词规则 + 每条只计一次）和弹幕时间轴分段；另外加了新词发现（凝固度 + 自由度）、对数几率比区分度、MAD 稳健峰值检测。
  - 为什么要新词发现：`Intl.Segmenter` 会把“国开”拆成“国/开”、“靠谱”拆成“靠/谱”。media_crawl 用远程词库解决，ugc-lens 直接从这批数据里找词，“肺活量”“憋死”“打火石”“学院派”“谢甲催”这类词都能找出来，不需要维护词库。
  - 为什么峰值用中位数和 MAD：均值和标准差会被一个极端高峰拉高，导致其他高峰都“不显著”。
  - 真实数据上发现的问题：
    - B 站表情 `[笑哭]`、`[吃瓜]` 被当成高频新词。改成：发现新词和分词前先去掉方括号表情。
    - “跟肾”“这不是测”“个视频”这类片段的自由度在 1.2～1.4，阈值提高到 1.5 后去掉。
    - “应该”“直接”“需要”排在关键词前面，补进停用词。
    - 一个 9.8 万条的文件里有 6.4 万条“666”评论，按热度装块时几乎全是“666”。加了复读合并和刷屏压缩：一级内容从 9 万条合并到 1.2 万条，放进块里的从 806 条增加到 1931 条。
  - 性能（9.8 万条）：新词发现约 90ms，关键词约 350ms，分块约 200ms。
  - 9.2 分块总结：`src/pipeline/summarize.ts`（`summarizeChunks`、`estimateSummarize`、`parseFindings`），`src/llm/tokens.ts`（token 估算）。设计见 `docs/architecture.md` 第 6.3 节。运行：`npm run summarize`，或 `node examples/09_summarize.ts <文件> [--chars 80000] [--focus 价格,售后]`。
  - 用户决定（省 token）：引用只给块内编号，被引用的内容超过 80 字才附摘句；默认交给模型 8 万字；低信息内容只计数不发送；用户名、日期、IP 属地照发（地区本身就是要分析的信息）。
  - 省 token 的做法：每块只调用一次（不走 Agent 循环，省掉“回复完成”那次调用）；短编号代替十几位的原 ID；格式错误不重试，代码保留合格的部分；固定内容放在 system prompt，各块开头相同，命中提示词缓存；关闭思考模式。
  - 坑：DeepSeek 默认开着思考模式，开着思考时指定工具的 `tool_choice` 直接返回 400。关闭思考后能指定工具，而且思考内容不再计入输出 token。其他提供商如果也拒绝，自动改用 `auto`。
  - 坑：截断 500 字时正好把 emoji 拆成两半，DeepSeek 报“unexpected end of hex escape”，那一块失败。截断改为不拆代理对，客户端发送前再把半个代理对换成 U+FFFD。
  - 真实模型验证（DeepSeek `deepseek-flash`，关闭思考）：
    - 测试样本 12 条：2 块，输入 2293、输出 434 token，2 秒。
    - 荒野独居 7987 条：7 块 7.4 万字，输入 5.7 万、输出 4 千 token，7 秒；引用全部通过校验。
    - 测肺活量 9.8 万条：抽样后 8 块 8.2 万字，低信息内容 1114 条没有发送，输入 6.2 万、输出 4 千 token，7 秒；重跑时缓存命中 85%。
  - token 估算一开始按汉字 0.6、其他 0.3 算，比实际少约 30%。用两份数据的实际用量校准为 0.9、0.4，每次请求再加 100，误差在 10% 以内。
  - 各块的观点重复很多（如“测的是肺活量不是肾”在 6 块里都出现），这正是 9.3 合并要做的事。
  - 9.3 合并与报告：`src/pipeline/merge.ts`（`mergeFindings`、`parseThemes`）、`src/pipeline/report.ts`（`renderReport`）、`src/pipeline/analyze.ts`（`analyzeDataset`）。设计见 `docs/architecture.md` 第 6.4～6.6 节。运行：`npm run analyze`，或 `node examples/09_analyze.ts <文件> [--chars 80000] [--focus 价格,售后] > report.md`；报告同时保存到 `.ugc-lens/reports/`。命令行的 `analyze` 命令在第 13 步发布时再做。
  - 用户决定：报告只放正常结果，优先 Markdown。校验丢掉的数量、失败块的原因只放在返回值里；报告末尾一小节运行信息，有块没完成时只用一句话说明。
  - 合并只调用一次模型：输入是各块观点的一行摘要（结论｜纳入标准｜条数），不发原文；模型只回观点编号和标题。编号由代码校验（存在、方向一致、只用一次），漏掉的观点单独成为主题；调用失败时每个观点单独成为主题，报告照样生成。观点都来自同一块时不调用。
  - 引用、作者、属地、点赞、“类似内容 N 条”都由代码从原数据取，模型不输出这些。每个主题按点赞取 3 条引用。
  - 真实数据上发现的问题：B 站导出的属地是“IP属地：广东”，统计里全带前缀，按“广东”筛选也对不上。导入时统一去掉前缀（`toLocation`）。
  - 真实模型验证（DeepSeek `deepseek-flash`，关闭思考）：
    - 荒野独居 7987 条：7 块 + 合并 1 次，42 个主题，12 秒，输入 6.0 万（缓存命中 5.6 万）、输出 4.9 千 token。
    - 测肺活量 9.8 万条：8 块 + 合并 1 次，34～38 个主题，13 秒，输入 6.5 万、输出 5.3 千 token。

### 第 9.5 步：通用文本记录（推迟到发布后）

- 用户决定：第一版先不做，发布后用户亲自测试再决定怎么做。第一版保持现状：数据按 UGC 的统一格式导入，分析提示词不写死“视频”，非 UGC 数据如果能被识别成这个格式也能分析，但不专门支持。
- 目标：不只分析 UGC，也能分析商品评价、问卷开放题、客服工单、访谈记录等“一条文本加一些元数据”的数据。
- 要做的：统一格式加一个通用类型；支持 CSV 导入（列由模型识别，规则照样缓存）；提示词和报告里不出现“视频”“弹幕”这类假设，按数据实际有的字段展示；分析方向可配置。
- 不做：以数字为主的表格分析（写代码计算、画图），见 `docs/architecture.md` 第 1 节。
- 完成标准：拿一份非 UGC 的 CSV（例如问卷开放题），`analyze` 能生成带引用的报告。

### 第 10 步：监听目录

- 目标：`watch` 命令，新文件写入完成后自动触发分析；任务状态持久化，重启后继续未完成的任务。
- 完成标准：把文件复制进目录后自动生成报告；同一文件不重复分析。
- 用户决定：按文件名规则触发，默认只认 `*_all.json`，可配置；搜集工具全部完成后才写 `*_all.json`，文件出现就算数据齐了；分析过的文件被覆盖也跳过，只分析一次；启动时已有的文件默认不分析，加 `--existing` 才分析。
- 笔记：
  - 代码：`src/store/tasks.ts`（任务状态）、`src/watch/`（`pattern.ts` 文件名规则和扫描，`index.ts` 的 `watchDirectory`）、`src/cli/`（`index.ts` 命令行入口，`watch.ts` 参数和输出格式）。设计见 `docs/architecture.md` 第 6.7 节。运行：`npm run watch -- <目录>`，或 `node src/cli/index.ts watch <目录> [--pattern ...] [--existing] [--retry-failed]`。
  - 为什么只认 `*_all.json`：搜集工具每个视频文件夹里有 comment、danmaku、summary、detail、all 五个 JSON，全分析会把同一个视频分析好几遍。
  - 写完判定：文件出现后再等大小和修改时间 2 秒不变。大文件写入要时间，`fs.watch` 在文件刚创建时就会触发。
  - 发现新文件：`fs.watch` 递归监听 + 每 30 秒定时扫描兜底。没有用 chokidar，少一个依赖。
  - 任务按绝对路径记录在 `.ugc-lens/tasks.json`，先写临时文件再改名。文件损坏时报错，不自动清空（清空后分析过的文件会被重复分析）。
  - 被 Ctrl+C 打断的任务保持 `running`，下次启动时和 `pending` 一起重新排队；失败的不自动重试，`--retry-failed` 才重试。
  - 真实验证：监听临时目录，复制进荒野独居的 `bilibili_comment.json` 和 `bilibili_all.json`，只有 all 被分析：7 块 + 合并，8 次调用，输入 6.0 万、输出 5.1 千 token，约 20 秒出报告；目录里原有的文件没有分析。重启后覆盖 all 文件，没有重复分析。
  - 测试：`test/store/tasks.test.ts`、`test/watch/pattern.test.ts`、`test/watch/index.test.ts`（真实临时目录 + 注入的分析函数）、`test/cli/watch.test.ts`。

### 第 10.5 步：npm 入口与发布（插入）

- 目标：配好命令行入口和代码入口，配好 CI，先发布 0.0.1 看看实际效果。MCP（第 11 步）延后。
- 要做的：命令行补 `analyze`、`ask`；`src/index.ts` 导出代码 API；编译成 JS 发布（Node 不运行 `node_modules` 里的 `.ts`）；CI 检查每次提交，`package.json` 版本号变化时自动发布。
- 用户决定：版本 0.0.1；第一版命令行带 `watch`、`analyze`、`ask`；第一次由用户在本机 `npm publish`，之后 CI 用 npm Trusted Publishing（不用 token）；版本号更新时发布。
- 完成标准：`npm pack` 得到的包在一个空目录里安装后，`ugc-lens analyze <文件>` 能生成报告；CI 通过。
- 笔记（推送后 CI 通过、首次发布成功再打勾）：
  - 命令行：`src/cli/index.ts` 分发 `analyze`、`ask`、`watch`，`--help`、`--version`；参数不对退出码 2，配置或导入错误退出码 1 且不打印调用栈。结果打印到标准输出，进度打印到标准错误。
  - 坑：Node 不对 `node_modules` 里的 `.ts` 做类型剥离，装好的包直接跑源码会报错，所以发布前必须编译。`tsc` 的 `rewriteRelativeImportExtensions` 只改 `.js` 里的导入，`.d.ts` 里仍然是 `./x.ts`，使用者的 TypeScript 会找不到，`scripts/build.ts` 编译后再改一遍声明文件。
  - 包里只有 `dist/`、README、LICENSE，约 97 KB；运行时依赖只有 zod。
  - Trusted Publishing 要求包已经存在才能配置，所以第一次由用户在本机发布。配置后 2 天内必须有一次成功的 CI 发布，否则配置过期。
  - 验证：在空目录安装 `npm pack` 的包，`--version`、`--help` 正常；写一个 TypeScript 文件导入 `ugc-lens` 能通过类型检查；`analyze`、`ask` 用 DeepSeek 跑通测试样本。

---

## 阶段三：对外接入与迭代

### 第 11 步：MCP 服务

- 目标：把数据工具和 `analyze`、`ask` 作为 MCP 工具暴露出去，附 `SKILL.md`。
- 完成标准：在 Claude Code 里配置后，能直接让它分析某个文件。

### 第 12 步：playbook 与 learnings

- 目标：分析规则从代码中移到 `playbook.md`；每次运行后追加 `learnings.md`。
- 完成标准：修改 playbook 中一条规则，重跑回归样本后能看到报告的对应变化。

### 第 13 步：更多文件格式

- 目标：支持 JSONL 等文件格式（CSV 随第 9.5 步再做）。第一个 npm 版本已在第 10.5 步发布。
- 完成标准：`npx ugc-lens analyze` 能直接分析 JSONL 文件。

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
- [x] 第 7 步　统一数据格式与数据导入
- [x] 第 8 步　数据工具
- [x] 第 9 步　分析流水线
- [ ] 第 9.5 步　通用文本记录（推迟到发布后）
- [x] 第 10 步　监听目录
- [ ] 第 10.5 步　npm 入口与发布
- [ ] 第 11 步　MCP 服务
- [ ] 第 12 步　playbook 与 learnings
- [ ] 第 13 步　更多文件格式
- [ ] 第 14 步　图形界面（可选）
