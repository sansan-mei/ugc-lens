# ugc-lens

面向中文社媒用户互动内容（评论、回复、弹幕等）的轻量分析 Agent。直接启动后用自然语言描述目标，它会选择工具导入数据、生成带原文引用的报告、连续追问或监听目录。以 npm 包形式提供命令行和代码调用，MCP 服务后续提供。

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
