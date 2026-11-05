---
name: ugc-lens
description: 使用 ugc-lens MCP 工具分析本地 JSON 中的评论、回复和弹幕，生成带原文证据的报告或连续追问；不负责搜集平台数据。
---

# ugc-lens 数据分析

用户提供的是已经搜集好的 JSON 文件。文件结构由 ugc-lens 识别，不要自行假设字段名，也不要把整个大文件读进上下文。工具名前缀由宿主决定，以下使用服务内名称。

## 选择工具

- 需要完整分析报告时调用 `analyze`，用 `file` 指定路径，可用 `directions` 指定用户关注点。工具会自动导入、运行流水线并保存报告；向用户给出返回的报告路径。
- 宿主自己回答具体问题时，先 `load_dataset`，再用 `get_dataset_stats`、`search_feedback` 和 `get_feedback` 查证。只有一个数据集时可以省略 `dataset_id`；有多个时用 `list_datasets` 选择。
- 需要 ugc-lens 配置的模型代为查询并回答时调用 `ask`，第一次用 `file` 或 `dataset_id` 和 `question`；同一数据集连续追问时传回 `conversation_id`，不需要重复导入。新问题需要独立上下文时不传这个 ID。

## 查询和证据

`search_feedback` 的关键词以空格表示同时匹配，以 `|` 表示任意匹配；支持按点赞、类型、属地等筛选。根据返回的下一页 `offset` 翻页。搜索结果正文会截断，需要全文或回复链时调用 `get_feedback`。

结论用工具结果里真实出现的 `[ID]` 引用，保留原文。区分样本中的支持数量和全平台比例；回复可能未全部搜集，不据此推断没有回复。`ask` 返回 `citations.invalid` 时不要把这些 ID 当作证据。

## 路径和运行

相对路径以 MCP 启动时 `--cwd` 指定的目录为准。宿主与服务工作目录不同时使用绝对路径。数据集和追问历史仅在本次服务进程内保留，重启后需要重新导入；相同文件的结构映射可从磁盘缓存复用。

握手和工具发现不需要 API key；导入时识别结构、`analyze` 和 `ask` 使用 ugc-lens 的模型配置。配置缺失时说明错误并指导用户运行 `ugc-lens init`，不要要求用户把 key 发进聊天或写进可提交的宿主配置。

`analyze` 会写报告，模型调用也会产生用量。按用户任务选择工具，不为了一个具体问题重复生成整份报告。工具报错时根据错误修正路径或参数，实际成功后再说明完成。

## 规则和经验

MCP 命令行默认启用项目经验文件。`search_learnings` 按关键词和 `dataset_id` 分页返回历史原记录，核对当前样本后才能参考。`record_learning` 只记录带有效 `evidence_ids` 的候选经验，不代表跨数据集规律；不要写入密钥或完整私人问答。

用户需要调整分析规则时，可用 `playbook_update` 提出 `add` / `patch` / `remove` 建议，章节为 `common`、`ask`、`summarize` 或 `merge`。这只写待审文件，不能说规则已生效。向用户展示修改，并说明由用户运行 `ugc-lens playbook --apply <ID>` 或 `--reject <ID>`；已有待审修改时先处理它。应用后仅影响下次分析或新对话，现有 `conversation_id` 的提示词不变。
