# ugc-lens

面向中文社媒用户互动内容（评论、弹幕等）的轻量分析 Agent，以 npm 包形式提供命令行、代码调用和 MCP 服务。

> 状态：设计阶段，尚未实现。

## 文档

- [架构设计](docs/architecture.md)：定位、分层、Agent 循环、工具规范、数据格式
- [模型提供商](docs/providers.md)：支持的厂商、配置格式、各家差异
- [开发路线](docs/roadmap.md)
- [更新记录](docs/changelog/)：每次更新一份，文件名为 `日期-大致功能.md`
- [项目指令](AGENTS.md)：协作规则

## 开发

```
bun install          # 安装依赖
npm run typecheck    # 类型检查
npm test             # 测试
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
```：按步骤实现，每一步的目标、要掌握的概念和完成标准
