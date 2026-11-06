# ugc-lens

面向中文文本记录和社媒用户互动内容（问卷、工单、访谈、评论、回复、弹幕等）的轻量分析 Agent。直接启动后用自然语言描述目标，它会选择工具导入数据、生成带原文引用的报告、连续追问或监听目录。以 npm 包形式提供命令行和代码调用，也提供 stdio MCP 服务供宿主调用。

> 状态：0.0.x 试用版。支持 JSON、JSONL/NDJSON、CSV/TSV、TXT、Markdown 和日志文本，接口和报告格式还可能调整。

## 安装

需要 Node.js 22.18 或更高版本。

```
npm install -g ugc-lens
# 或者不安装，直接用 npx ugc-lens ...
```

## 持续对话

配置好模型后，直接运行：

```bash
ugc-lens
# 在源码项目内测试，无需构建：
node src/cli/index.ts
```

进入会话后直接输入，例如：

```text
你 > 看看 ./data 目录有哪些数据
你 > 分析 ./data/video_all.json，重点看价格和售后
你 > 刚才提到价格贵的评论，点赞最多的是哪条？
你 > 持续监听 ./data，有新文件就分析
你 > 现在分析到哪了？
你 > 停止监听
```

会话会记住已导入的数据和对话，监听在后台运行，可以继续提问。输入 `/exit`、`/quit`，或按 Ctrl+D、Ctrl+C 退出并停止后台监听。对话历史只在本次进程内保留，报告和监听任务状态保存到当前目录的 `.ugc-lens/`。原有子命令仍可单独使用。

## 配置模型

最简单的方式：

```
ugc-lens init
```

交互式地选提供商、从 `/models` 列表里选模型、填 API key 并发一次测试调用，写入全局配置 `~/.ugc-lens/config.json`（权限 600），所有目录下都能用。

也可以手动配置：在运行命令的目录里放一个 `.env`（或设置同名环境变量），选一个提供商并填它的 API key：

```
UGC_LENS_PROVIDER=deepseek
UGC_LENS_MODEL=deepseek-flash
DEEPSEEK_API_KEY=你的 key
```

支持 DeepSeek、通义千问、Kimi、智谱、MiniMax、OpenAI、Claude、Gemini、Grok、OpenRouter 和本地模型，变量名和差异见 [模型提供商](docs/providers.md)。优先级：环境变量 > 当前目录的 `.env` / `.ugc-lens/config.json` > 全局配置。

## 使用

```
ugc-lens                                          # 持续对话，自动选择工具
ugc-lens init                                     # 初始化模型配置

# 分析一个文件：报告打印到标准输出，同时保存到 .ugc-lens/reports/
ugc-lens analyze bilibili_all.json > report.md
ugc-lens analyze bilibili_all.json --focus 价格,售后     # 只看这些方向

# 追问：回答里用 [ID] 标出依据，多个问题依次追问
ugc-lens ask bilibili_all.json "评论主要在吐槽什么？" "点赞最多的那条下面怎么回复的？"

# 监听目录：新出现的 *_all.json 写完后自动分析，每个文件只分析一次
ugc-lens watch ./data
ugc-lens watch ./data --pattern "*_all.json,*_comments.json" --existing

ugc-lens <命令> --help    # 查看全部选项
```

- 文件结构第一次由模型识别，规则缓存在 `.ugc-lens/mappings/`，同样结构的文件之后不再调用模型。
- 报告包括：概况、IP 属地、关键词、弹幕高峰、各方向（主要观点、吐槽点、正面评价、争议）的主题和原文引用，末尾是耗时和 token 用量。
- 统计、去重、关键词、引用校验都由代码完成，模型只负责分块总结和合并，一个 10 万条评论的文件大约用 6～7 万 token。
- `watch` 的任务状态存在 `.ugc-lens/tasks.json`，按 Ctrl+C 停止后再启动会继续没做完的任务。

## 输入格式

所有入口共用导入器：命令行、持续对话、MCP 和代码 API 都支持下列格式。

| 格式 | 读取方式 |
|---|---|
| JSON | 保留原有任意结构识别；字符串数组可直接导入 |
| JSONL / NDJSON | 每个非空行一个 JSON 对象或字符串，对象可以包含嵌套字段；同一文件保持类型一致 |
| CSV | 首个非空记录为表头，支持逗号或分号分隔、引号内换行和双引号转义 |
| TSV | 首个非空记录为表头，制表符分隔，支持带引号的字段 |
| TXT / LOG | 每个非空行作为一条记录，ID 对应原始行号，例如 `line_3` |
| MD / Markdown | 用空行分隔段落，保留段内换行，ID 对应段落起始行 |

CSV/TSV 列由模型识别，规则会缓存；列名或顺序变化后重新识别。前导零 ID、日期等单元格保留为字符串，再按映射转换已知元数据字段。表头需要唯一且非空，损坏的 JSONL 行、CSV 引号或列数会明确报错。TXT、LOG、Markdown 和字符串数组用内置映射，无需额外调用模型识别格式；生成报告和问答仍使用配置的模型。

通用数据使用 `record` 类型，可分析商品评价、问卷开放题、客服工单、访谈等。报告使用“文本记录”等名称，默认方向为主要主题、反复出现的问题、需求与建议、差异与分歧，也可用 `--focus` 指定方向。短答案如“好”“无”会保留，不套用评论的低信息过滤。长记录也不采用评论的 500 字截断；超过分块软上限时独立成块，仍受 `--chars` 总预算限制，放不下的记录会体现在报告覆盖率里。

```bash
ugc-lens analyze survey.csv --focus 主要问题,改进建议
ugc-lens analyze feedback.jsonl
ugc-lens ask notes.txt "有哪些反复出现的问题？"
ugc-lens analyze interviews.md
ugc-lens watch ./data --pattern "*.jsonl,*.ndjson,*.csv,*.tsv,*.txt,*.md,*.log"
# 在源码目录测试，无需构建：
node src/cli/index.ts analyze survey.csv
```

监听默认仍只匹配 `*_all.json`；其他格式通过 `--pattern` 指定。文件上限 100 MB，支持 UTF-8（含 BOM）和带 BOM 的 UTF-16 LE/BE。GBK 等编码需先转为 UTF-8；Excel 工作簿、PDF、Word 等二进制文件不属于此次支持范围。CSV 主要用于文本记录，暂不提供数值表格分析或执行公式。

## 分析手册与经验

分析规则放在 Markdown 手册里，按“项目 `.ugc-lens/playbook.md` → 全局 `~/.ugc-lens/playbook.md` → 包内默认”选择。`init` 首次创建全局副本，已有内容会保留。

```bash
ugc-lens playbook                     # 查看当前规则、来源、版本和待审修改
ugc-lens playbook --init              # 将当前规则复制为项目副本，再用编辑器修改
ugc-lens playbook --apply <ID>        # 应用模型提出的待审修改
ugc-lens playbook --reject <ID>       # 丢弃待审修改
# 源码内使用：node src/cli/index.ts playbook
```

手册保留“共同规则、追问、分块总结、合并”四个章节与正整数版本，最多 4000 字符。每次分析开始时读取一次，同一次分析的总结和合并使用相同快照；持续对话开始后也保持不变。编辑或应用规则后，下次分析或新对话生效。报告会标明版本和内容指纹，即使忘记修改版本号也能识别差异。

分析和数据问答完成后，CLI 与 MCP 自动向项目 `.ugc-lens/learnings.md` 追加运行观察，例如失败分块、无效引用、规则版本。不会额外调用模型，也不保存完整问题或回答。`--no-save` 只关闭报告保存，经验仍会记录；记录失败时保留结果并给出警告。

对话和 MCP 提供 `search_learnings`（按关键词、数据集分页检索）、`record_learning`（附真实原文 ID 的候选经验）和 `playbook_update`（提出待审规则修改）。历史经验只在需要时检索，仍须核对当前样本；候选经验不会自动变成规则。模型提出的规则修改必须由用户用上面的命令应用。

代码 API 默认使用包内规则，不写经验文件。传入 `memory: { cwd: process.cwd() }` 启用项目规则和记录；也可将 `loadPlaybook(...)` 返回的快照通过 `playbook` 传给 `askDataset` / `analyzeDataset`。

## 情感分析与采样

在持续对话或 `ask` 中直接说“分析这份数据的情感分数和正负面比例”，模型会调用 `analyze_sentiment`。它分批让 AI 对每条原文给出 -1～1 的分数及理由，再由代码汇总，最后让对话模型解读。可指定评价对象、`kinds` 和 `content_id`；不指定对象时评估文本整体情绪，情绪不等于对某个选择的支持/反对。

每条记录等权，不按点赞加权。分数 >0.2 为正面、<-0.2 为负面，其余中性；正负混合单列，不因均值为 0 算作中性。无法判断单独计数，并保留反讽标记与实际评价对象。比例以已评估条数（含无法判断）为分母，均值仅使用有效数值；同时返回导入样本内的实际评估覆盖率。完整逐条评分保存在当前工作目录 `.ugc-lens/sentiment/*.json`。默认独立 token 预算 30000，达到预算后返回已完成部分；预算为软上限，失败、遗漏和超长未处理项均不会算作中性。此用量在工具结果中单独返回，不包含在外层对话的 token 统计中。当前 `analyze` 固定报告流水线不会自动增加情感调用。

采样数据可以分析样本内主题和情绪，搜集占平台全量的比例并不等于采样完成率。缺少采样设计元数据时，不推测置信度或整体误差保证，也不把样本内比例说成平台全量比例。默认手册已更新；已有项目或全局 `playbook.md` 保留原文，需要手动同步上述采样和情感规则，新对话才会加载。

代码调用可使用 `analyzeSentiment({ dataset, model, target?, kinds?, contentId?, tokenBudget? })`，返回完整逐条评分和汇总，不自动写文件。

## 深入分析

0.0.8 增加以下分析工具，持续对话和 `ask` 可按自然语言自动选择，MCP 宿主可直接调用。情感、主题、痛点及机会建议默认优先用中文表格呈现，长解释或步骤再用列表。

| 能力 | 用法与统计口径 |
|---|---|
| 主题占比 | `analyze_topics` 先发现主题及纳入标准，或接收明确的 `topics: [{id,title,criteria}]`，再分批逐条归类；比例分母为成功归类条数，含不确定和未归类。允许多标签，总比例可以超过 100%。 |
| 商业机会 | `analyze_business` 提供有原文摘句的痛点、假设、最小验证动作、投入和优先级；不凑数量或自动估算 ROI，可传 `goal` 指定任务。 |
| 时间轴 | `get_content_timeline` 按内容 ID 对齐弹幕时间窗口与字幕，支持分页；无字幕不猜画面，不将同时间段的现象当作因果。 |
| 覆盖记录 | `get_analysis_coverage` 展示各导入集合及重复信号；固定报告另展示成功块、失败块、跳过与未选择数量。成功总结块不表示已逐条归类。 |

主题和商业分析可用 `kinds`、`content_id` 筛选，默认逐条阶段预算 30000；主题发现阶段额外用量在 `discovery` 中返回，不包含在逐条阶段预算内。完整结果保存在 `.ugc-lens/topics/` 和 `.ugc-lens/business/`，代码 API `classifyTopics`、`analyzeBusiness` 不自动写文件。固定 `analyze` 流水线新增覆盖及时间轴表，主题精确归类、情感和商业分析仍按需调用，不默认增加这些模型请求。

### 本地用户画像

开源包不内置个人背景。关注点学习默认开启，只从用户随文件附带的要求、主动追问及明确自述中增量学习；只发文件、常规分析、寒暄或简单继续不调用学习模型。记录的是用户在意的维度和分析要求，不是模型答复，也不把提问主题当作用户经历，持续写入本地 `~/.ugc-lens/user.md`；自动学习会额外调用一次模型，用量单独显示，不包含在外层对话 token 统计中。用户已关闭或尚无有效关注点时使用通用分析，已有关闭状态会保留。

```bash
ugc-lens profile --enable                 # 关闭后重新开启，初始无需操作
ugc-lens profile                          # 查看画像和条目 ID
ugc-lens profile --set skills --text '擅长编程'
ugc-lens profile --set goal --text '验证产品需求' --project
ugc-lens profile --confirm <ID>           # 确认候选
ugc-lens profile --delete <ID>            # 删除并阻止旧引用重学
ugc-lens profile --disable                # 停止读取与学习，保留文件
ugc-lens profile --clear                  # 清空画像、修订并关闭
ugc-lens profile --learn ./my_history.txt # 仅导入自己选择的用户发言，按空行分段
```

画像区分自述（`self_report`）、推断（`candidate`）和用户修正（`confirmed`）；自述不是经过外部核验的事实。每条有引用、来源摘要、时间与作用域，超过 180 天标记为过期。用户修正优先，不被模型自动覆盖；模型读取画像作为建议背景，不作为市场需求证据或操作指令。Markdown 内的 JSON 数据块可手动编辑，容量上限为 200 个当前条目和 200 个修订。

项目目标按工作目录隔离。多人共用一个系统账户时，可用 `UGC_LENS_PROFILE=alice` 选择独立画像，所有命令需使用同一变量；命名画像写到 `~/.ugc-lens/profiles/alice/user.md`。自动学习不扫描其他软件历史，不把待分析评论或模型/工具回复当成操作者资料。`--learn` 仅接受选定的纯用户发言 TXT（上限 100 KB、20000 字符和 20 段，每段最多 4000 字符）；不要把混有其他角色的完整聊天转储直接导入。

需要个性化建议时，模型可调用 `read_profile`；对话内部的 `record_profile` 只接受本轮用户原文引用。MCP 宿主直接提供只读的 `read_profile`，通过 `ask` 内部对话才会按真实问题增量学习。代码 API 传入 `memory` 后遵从启用状态，`memory.profile` 可指定画像名。项目或全局旧 playbook 保留原文；默认手册现为版本 4。

画像的删除与关闭不会改写已经发送给模型的历史消息；操作后开启新对话，避免继续沿用旧上下文中的背景。

## MCP 接入

先用 `ugc-lens init` 配置模型。MCP 由宿主启动，不需要自己开一个服务终端。Claude Code 中可以添加：

```bash
claude mcp add --transport stdio ugc-lens -- npx -y ugc-lens@0.0.10 mcp --cwd /绝对路径/数据项目
```

测试本地源码时：

```bash
claude mcp add --transport stdio ugc-lens -- node /绝对路径/ugc-lens/src/cli/index.ts mcp --cwd /绝对路径/数据项目
```

两种配置选一种。在 Claude Code 的 `/mcp` 中确认连接，然后直接说“分析 `/绝对路径/video_all.json`，重点看价格”，宿主会选择工具。`--cwd` 指定配置、缓存、报告和相对数据路径的基准目录；服务沿用环境变量、项目配置、全局配置的优先级。

其他支持 stdio 的宿主可使用同等配置：

```json
{
  "mcpServers": {
    "ugc-lens": {
      "command": "npx",
      "args": ["-y", "ugc-lens@0.0.10", "mcp", "--cwd", "/绝对路径/数据项目"]
    }
  }
}
```

| 工具 | 用途 |
|---|---|
| `load_dataset` | 导入 JSON，返回数据集 ID |
| `list_datasets` | 列出本次服务已导入的数据 |
| `get_dataset_stats` | 查看数据概况 |
| `search_feedback` | 按关键词、类型、点赞等筛选并分页 |
| `get_feedback` | 查看全文和回复链 |
| `analyze_sentiment` | 分批逐条情感评分，返回汇总、示例和完整结果路径 |
| `analyze_topics` | 发现主题后逐条多标签归类，精确统计样本内占比 |
| `analyze_business` | 附原文证据、假设和验证动作的商业机会 |
| `get_analysis_coverage` | 导入集合数量、跳过与重复正文信号 |
| `get_content_timeline` | 按内容对齐弹幕时间与字幕，支持分页 |
| `read_profile` | 读取已开启且当前项目可见的用户画像，需启用 memory |
| `analyze` | 自动导入并生成完整报告，返回正文和保存路径 |
| `ask` | 调用配置的模型回答，返回引用核对结果及追问 ID |

`analyze`、`ask` 可以传 `file` 自动导入，也可用 `dataset_id`；两者不能同时提供。`ask` 返回 `conversation_id`，继续追问时传回这个 ID 和新 `question`，可省略文件。数据集和对话只在当前服务进程内保留；报告和映射缓存保存在磁盘。MCP 本身不使用宿主的模型授权，识别结构和模型分析仍需要 ugc-lens 的模型配置；握手和工具发现不需要 key。

技能指引位于 [skills/ugc-lens/SKILL.md](skills/ugc-lens/SKILL.md)，随 npm 包提供，可按宿主的技能安装方式添加。代码调用者可从 `ugc-lens/mcp` 导入 `createMcpServer` 创建独立实例。

## 代码调用

```ts
import { analyzeDataset, createChatClient, createLlmModel, loadDataset, loadLlmConfig } from 'ugc-lens'

const config = loadLlmConfig()
const model = createLlmModel(createChatClient(config), { temperature: 0, disableThinking: true })
const dataset = await loadDataset('bilibili_all.json', { model })
const result = await analyzeDataset({ model, dataset })
console.log(result.markdown)
```

还导出了 `askDataset`（追问）、`watchDirectory`（监听目录）、`computeStats`、`searchFeedback` 等，类型声明随包提供。

## 文档

- [架构设计](docs/architecture.md)：定位、分层、Agent 循环、工具规范、数据格式、分析流水线
- [模型提供商](docs/providers.md)：支持的厂商、配置格式、各家差异
- [开发路线](docs/roadmap.md)：按步骤实现，每一步的目标、要掌握的概念和完成标准
- [更新记录](docs/changelog/)：每次更新一份，文件名为 `日期-大致功能.md`
- [项目指令](AGENTS.md)：协作规则

## 开发

```
bun install          # 安装依赖
npm run typecheck    # 类型检查
npm test             # 测试
npm run build        # 编译到 dist/（发布用）
node src/cli/index.ts analyze <文件>   # 开发时直接运行源码
npm run loop         # 用假模型演示 Agent 循环
npm run tools        # 真实模型 + 基础工具（需要 .env）
npm run params       # 参数纠错实验（需要 .env）
npm run retry        # 重试演示与 token 预算（budget 部分需要 .env）
npm run stats        # 模型识别 JSON 文件结构，转换成统一格式并打印统计（需要 .env）
npm run ask          # 用数据工具追问，回答带评论 ID 作为证据（需要 .env）
npm run chunks       # 新词发现、关键词、弹幕高峰和分块结果，不调用模型做分析
npm run summarize    # 分块总结：每块调用一次模型，打印各方向的观点、引用和 token 用量（需要 .env）
npm run analyze      # 完整分析，Markdown 报告打印出来并保存到 .ugc-lens/reports/（需要 .env）
npm run watch -- <目录> # 监听目录，新出现的 *_all.json 写完后自动分析（需要 .env）
```

发布：修改 `package.json` 的版本号并推送到 master，GitHub Actions（`release.yml`）会检查、编译并发布到 npm，然后打 `v版本号` 标签。

## 许可

MIT
