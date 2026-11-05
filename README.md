# ugc-lens

面向中文社媒用户互动内容（评论、回复、弹幕等）的轻量分析 Agent。直接启动后用自然语言描述目标，它会选择工具导入数据、生成带原文引用的报告、连续追问或监听目录。以 npm 包形式提供命令行和代码调用，也提供 stdio MCP 服务供宿主调用。

> 状态：0.0.x 试用版。目前只支持 JSON 文件，接口和报告格式还可能调整。

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

## MCP 接入

先用 `ugc-lens init` 配置模型。MCP 由宿主启动，不需要自己开一个服务终端。Claude Code 中可以添加：

```bash
claude mcp add --transport stdio ugc-lens -- npx -y ugc-lens@0.0.4 mcp --cwd /绝对路径/数据项目
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
      "args": ["-y", "ugc-lens@0.0.4", "mcp", "--cwd", "/绝对路径/数据项目"]
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
