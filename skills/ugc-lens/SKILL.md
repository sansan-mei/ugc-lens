---
name: ugc-lens
description: 使用 ugc-lens（MCP 服务、命令行，或不需要 API key 的宿主模型模式）分析本地 JSON、JSONL、CSV、TXT、Markdown 等文件中的评论、回复、弹幕、字幕、问卷、工单和访谈记录，生成带原文 ID 引用的报告，支持连续追问、情感与主题统计、商业机会分析和目录监听；不负责搜集平台数据。Use for large comment, danmaku or feedback datasets (especially Chinese social media exports) when the user wants cited reports via the ugc-lens package.
license: MIT
compatibility: 需要 Node.js 22.18+ 和 npm 包 ugc-lens（可用 npx 临时运行）。完整流水线调用用户用 ugc-lens init 配置的模型；宿主模型模式不需要 key。
metadata:
  author: sansan-mei
  homepage: https://github.com/sansan-mei/ugc-lens
---

# ugc-lens 数据分析

用户提供的是本地结构化数据或文本文件，支持 JSON、JSONL/NDJSON、CSV/TSV、TXT、Markdown、LOG。结构化文件列由 ugc-lens 识别，纯文本使用内置规则，不要自行假设字段名，也不要把整个大文件读进上下文。工具名前缀由宿主决定，以下使用服务内名称。

## 准备

先确认当前可用哪种方式，再开始分析：

1. **MCP 已连接**：工具列表里有 `analyze`、`load_dataset` 等工具时直接使用，跳到“选择工具”。
2. **未连接但可执行命令**：运行 `ugc-lens --version`（或 `npx -y ugc-lens --version`）确认已安装，需要 Node.js 22.18 或更高版本。可以直接用命令行完成任务：
   - `ugc-lens analyze <文件> --focus 方向1,方向2`：完整报告打印到标准输出，并保存到当前目录 `.ugc-lens/reports/`；`--scenario reputation|competitor` 切换场景。
   - `ugc-lens ask <文件> "问题1" "问题2"`：带 `[ID]` 依据的追问。
   - 运行前确认工作目录，报告、缓存和经验会写到该目录的 `.ugc-lens/`；长任务给出合理超时。
3. **需要长期接入**：向用户提议注册 MCP，由用户确认后再修改宿主配置。`--cwd` 写数据项目的绝对路径：
   - Claude Code：`claude mcp add --transport stdio ugc-lens -- npx -y ugc-lens mcp --cwd /绝对路径/数据项目`
   - Codex：在 `~/.codex/config.toml` 添加 `[mcp_servers.ugc-lens]`，`command = "npx"`，`args = ["-y", "ugc-lens", "mcp", "--cwd", "/绝对路径/数据项目"]`
   - 其他宿主按 stdio MCP 配置同样的命令和参数；需要固定版本时把 `ugc-lens` 写成 `ugc-lens@版本号`。
4. **模型配置**：导入识别、`analyze` 和 `ask` 使用 ugc-lens 自己的模型配置，不使用宿主的模型授权。缺少配置时请用户在终端自行运行交互式的 `ugc-lens init`；不要让用户把 key 发进聊天，也不要替用户写入密钥。
5. **没有配置模型 key**：不要卡在配置上，直接用下面的“宿主模型模式”，由你自己的模型完成分析；需要逐条情感、主题统计或想省宿主额度时，再建议用户配置 key。
6. **无法安装 ugc-lens**：数据量不大（几千条以内的短文本）时，改用 `cited-feedback-analysis` 技能；安装方式 `npx skills add sansan-mei/ugc-lens --skill cited-feedback-analysis`。

## 宿主模型模式（不需要 key）

ugc-lens 负责导入、统计、分块、检索和引用核验，你负责理解内容和写报告。命令都输出 JSON；在数据项目目录运行（`.ugc-lens/` 写在当前目录），未全局安装时把 `ugc-lens` 换成 `npx -y ugc-lens`。

1. `ugc-lens host describe <文件>`：`mapped: true` 时跳到第 3 步。media_crawl 的 B 站 `*_all.json`、TXT、Markdown、JSONL 字符串、JSON 字符串数组都内置支持。
2. `mapped: false` 时，根据返回的 `shape`（每行一个路径、类型和示例）写映射规则 JSON，保存到临时文件后运行 `ugc-lens host mapping <文件> <规则.json>`；按返回的错误修改，直到 `ok: true`。规则格式：
   - `{"platform": "unknown", "content": {...可选}, "collections": [{"kind": "comment", "path": "$.posts", "fields": {"text": "body", "id": "pid", "likes": "like", "created_at": "time", "author_location": "city"}, "children": [{"kind": "reply", "path": "replies", "recursive": true}]}]}`
   - `kind` 取 comment、reply、danmaku、answer、record；`path` 以 `$` 开头指向数组本身；字段只用摘要里出现的路径，没有就不写。CSV/TSV 的集合路径是 `$.rows`，字段用 `column_1` 等键，没有 ID 列时 `id` 写 `source_id`。弹幕的时间点写 `video_time`，扁平回复写 `parent_id`；字幕写在 `content.transcript`（`path`、`start`、`end`、`text`）。
3. `ugc-lens host prepare <文件> [--focus 方向1,方向2] [--scenario reputation|competitor]`：输出目录里有 `facts.md`（代码算出的概况、属地、关键词、弹幕高峰、字幕时间轴）、`guide.md`（分块格式、分析方向、当前分析手册规则、写报告要求）、`chunks/*.md` 和 `manifest.json`。先读 `guide.md` 并照做。
4. 按 `manifest.json` 的顺序逐块阅读，记录候选观点和原文 ID。块很多时分批读并保留笔记；没读完的块要在报告“局限”里写明。
5. 需要精确数量用 `ugc-lens host search <文件> "词1|词2"`（空格表示都要出现，`--kinds comment,reply` 可限定类型），报告 `total` 并写明检索词；需要全文或回复链用 `ugc-lens host get <文件> <ID>`。
6. 写 Markdown 报告：核心结论带证据和反例，引用写 `[ID]`，直接引用写 `"逐字摘句" [ID]`；附录放 `facts.md` 的内容。保存到用户同意的位置。
7. `ugc-lens host verify <文件> <报告.md>`：修正 `invalid_ids` 和 `quote_mismatches`，直到 `ok: true`。最后告诉用户报告路径、分析覆盖范围（`facts.md` 的“分析范围”）和核验结果。

### 逐条情感、主题占比和商业机会

用户要情感分布、主题占比或商业机会时，由你逐条标注，ugc-lens 校验并用与完整流水线相同的代码汇总：

1. 导出：
   - 情感：`ugc-lens host label-export <文件> sentiment [--target 评价对象] [--kinds comment,reply]`
   - 主题：先根据分块内容写 `topics.json`（`[{"id":"price","title":"价格","criteria":"纳入标准"}]`，1～20 个），再 `ugc-lens host label-export <文件> topics --topics topics.json`
   - 商业机会：`ugc-lens host label-export <文件> business [--goal 目标]`
   - 条数很多时先看返回的 `items`，用 `--kinds`、`--content` 缩小范围，或 `--sample 500` 随机抽样（结果会注明是样本），并告诉用户。
2. 读输出目录的 `task.md`（规则与每行格式），逐个读取 `batches/*.jsonl`，把结果写到 `answers/` 下同名文件，每行一个 JSON，覆盖该批全部 ID。
3. `ugc-lens host label-import <文件> <任务目录>`：按 `errors` 修正（越界分数、未定义的主题、不是原文子串的商业摘句、重复或批外 ID），补齐 `missing`，直到 `ok: true`。
4. 报告中使用返回的 `summary`（分布、比例、`topics[].count/share`、`opportunities`），写明分母、覆盖率和 `scope_note`；比例只描述导入样本，情绪不等于支持或反对立场。完整逐条结果在 `result.json`。

### 补查反例与改进分析规则

- 每条核心结论写完后，运行 `ugc-lens host recheck <文件> --query "关键词1|同义词" [--query ...] --exclude 已引用ID1,ID2`，逐条判断候选是反例、限定、支持还是无关；反例和限定用 `"摘句" [ID]` 写进该结论，写明检索词和核对条数。未发现反例不等于不存在。
- 用户想调整以后的分析规则时，`ugc-lens host propose summarize add --text="- 新规则"`（章节 common、ask、summarize、merge；修改或删除用 patch/remove 加 `--match="原文"`）。这只写待审修改，告诉用户运行 `ugc-lens playbook --apply <ID>` 后才生效。

### 宿主模式做不到的

- 监听目录自动分析需要常驻模型，宿主模式不支持；可以建议配置 key 后用 `ugc-lens watch`。
- 几万条以上逐条标注会消耗大量宿主额度，优先抽样或建议配置 key 走完整流水线。

默认优先用中文表格展示情感分布、主题占比、痛点、机会与对比，关键数字加粗；较长解释和行动步骤用列表，用户明确要求优先。

## 选择工具

- 需要完整分析报告时调用 `analyze`，用 `file` 指定路径，可用 `directions` 指定用户关注点。工具会自动导入、运行流水线并保存报告；向用户给出返回的报告路径。
- 宿主自己回答具体问题时，先 `load_dataset`，再用 `get_dataset_stats`、`search_feedback` 和 `get_feedback` 查证。只有一个数据集时可以省略 `dataset_id`；有多个时用 `list_datasets` 选择。
- 需要情感数值或分布时调用 `analyze_sentiment`，由服务配置的模型分批逐条评分、代码汇总。可以传 `target` 指定评价对象，或按 `kinds`、`content_id` 筛选。最后一轮根据汇总解释，不凭检索示例估计百分比；情绪不等于支持/反对立场。
- 精确主题占比用 `analyze_topics`；可传主题及纳入标准，也可自动发现后逐条归类。区分模型总结的估计支持数与实际逐条归类数。多标签比例可能超过 100%，未归类和不确定属于成功处理分母；失败、预算跳过不属于分母。
- 商业分析用 `analyze_business`，引用原文，列出假设、验证动作、投入及优先级；无证据不凑数量，不补造 ROI。少量机会可能语义相似，不能把引用数说成独立用户数或市场规模。
- 时间核对用 `get_content_timeline`，按 `content_id` 隔离，并按返回的 offset 翻页；只解释返回的字幕原文与弹幕，不猜画面或原因。可用 `get_analysis_coverage` 检查导入数量，处理阶段见固定报告或逐条工具覆盖率。
- 需要 ugc-lens 配置的模型代为查询并回答时调用 `ask`，第一次用 `file` 或 `dataset_id` 和 `question`；同一数据集连续追问时传回 `conversation_id`，不需要重复导入。新问题需要独立上下文时不传这个 ID。

## 查询和证据

`search_feedback` 的关键词以空格表示同时匹配，以 `|` 表示任意匹配；支持按点赞、类型、属地等筛选。根据返回的下一页 `offset` 翻页。搜索结果正文会截断，需要全文或回复链时调用 `get_feedback`。

结论用工具结果里真实出现的 `[ID]` 引用，保留原文。区分样本中的支持数量和全平台比例；回复可能未全部搜集，不据此推断没有回复。`ask` 返回 `citations.invalid` 时不要把这些 ID 当作证据。

搜集比例不是采样完成率，不能仅因非全量就断言样本无效或搜集失败。无采样设计元数据时不推测置信度；仅在问题依赖缺失字段或完整回复链时说明相应限制。情感工具的比例分母为已评估条数（含无法判断），均值只使用有效数值；必须说明实际覆盖率及失败、跳过项，不能当作全平台比例。默认独立 token 预算 30000，可用 `token_budget` 调整；用量在结果中单独返回，未并入外层 ask 的 token 统计。完整逐条结果在返回的 JSON `path` 中，汇总仅附少量示例，需要全文时用 `get_feedback` 核对。

`ask` 返回 `web_citations` 时（服务以 `--web` 启动），其中 `[web:N]` 是外部网页资料，不是数据证据；`invalid`、`invalid_quotes`、`unverified_urls` 中的条目不要当作依据。外部资料不计入数据统计。

`analyze` 可传 `scenario`（`reputation` 危机与口碑、`competitor` 竞品对比）调整分析重点；默认补查核心发现，报告中的“补查”只覆盖所列关键词，不能说成已确认不存在反例。

## 路径和运行

相对路径以 MCP 启动时 `--cwd` 指定的目录为准。宿主与服务工作目录不同时使用绝对路径。数据集和追问历史仅在本次服务进程内保留，重启后需要重新导入；相同文件的结构映射可从磁盘缓存复用。

握手和工具发现不需要 API key；导入时识别结构、`analyze` 和 `ask` 使用 ugc-lens 的模型配置。配置缺失时说明错误并指导用户运行 `ugc-lens init`，不要要求用户把 key 发进聊天或写进可提交的宿主配置。

`analyze` 会写报告，模型调用也会产生用量。按用户任务选择工具，不为了一个具体问题重复生成整份报告。工具报错时根据错误修正路径或参数，实际成功后再说明完成。

## 规则和经验

需要针对当前操作者提供建议时可读取 `read_profile`。关注点学习默认开启，已有关闭状态保留；只从用户附带要求、追问和明确自述提取，单纯发文件或常规分析不学习，模型答复不作为来源；用户可用 `ugc-lens profile --disable` 关闭；不要求用户每次写人设提示词，不把其他人物或评论作者当成操作者。画像仅作背景，候选与过期条目应条件表达，当前要求优先。宿主不能直接写入画像，内部 `ask` 可从真实用户问题增量学习；纠正、确认、删除与关闭由 `profile` 子命令处理。不要声称已记住尚未实际保存的内容。

情感结果的混合项单列，即使均值为零也不称为中性。主题发现的额外用量在 `discovery` 返回，逐条阶段预算单独计算；商业结果默认只展示前 15 条，完整结果在 `path`，必须说明省略。完整报告不会默认增加情感、逐条主题和商业模型调用。

MCP 命令行默认启用项目经验文件。`search_learnings` 按关键词和 `dataset_id` 分页返回历史原记录，核对当前样本后才能参考。`record_learning` 只记录带有效 `evidence_ids` 的候选经验，不代表跨数据集规律；不要写入密钥或完整私人问答。

用户需要调整分析规则时，可用 `playbook_update` 提出 `add` / `patch` / `remove` 建议，章节为 `common`、`ask`、`summarize` 或 `merge`。这只写待审文件，不能说规则已生效。向用户展示修改，并说明由用户运行 `ugc-lens playbook --apply <ID>` 或 `--reject <ID>`；已有待审修改时先处理它。应用后仅影响下次分析或新对话，现有 `conversation_id` 的提示词不变。

## 通用文本

问卷、评价、工单、访谈等通用记录的 `kind` 是 `record`，可以传给 `search_feedback.kinds`。TXT/LOG 每个非空行是一条记录，Markdown 按空行分段，来源 ID 如 `line_3` 对应原文起始行；CSV/TSV 首个非空记录是表头。表头错误、JSONL 损坏或编码错误时请按工具错误修正输入，不要猜测缺失记录。完整报告可用 `directions` 指定用户关心的主题。单纯导入 TXT 等内置格式并查询原文不需要模型配置；报告和 `ask` 仍需配置模型。
