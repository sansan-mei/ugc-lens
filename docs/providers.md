# 模型提供商

> 参考 Hermes Agent 2026 年 11 月的提供商列表（hermes-agent.nousresearch.com/docs/integrations/providers）精简而来。
> 各家接口地址以官方文档为准，实现第 1 步时逐个验证。

## 1. 原则

- **用户自己选**，不内置默认厂商。`init` 时交互式选择，或直接写配置文件。
- **当前统一走 OpenAI 兼容的 Chat Completions 接口**。第 18 步（可选）计划保留这条路径，同时为需要原生能力的模型增加 Responses / Messages 适配；是否可用按具体接口、模型及 endpoint 判断。
- **不内置默认模型名**。模型更新太快，写死很快就过时。`init` 时调用提供商的 `GET /models` 列出可选模型，由用户选择；接口不支持时让用户手动输入。
- **API key 只放全局配置或进程环境变量**。全局配置 `~/.ugc-lens/config.json` 不在任何 git 仓库里，`ugc-lens init` 会把 key 直接写进去（权限 600），任何目录下都能用。ugc-lens 不读取项目目录的 `.env`；项目的 `.ugc-lens/config.json` 写 `api_key` 会直接报错，避免 key 被误提交或随项目共享。

## 2. 支持列表

### 国内

| id | 名称 | 区域 | 默认接口地址 | key 环境变量 |
|---|---|---|---|---|
| `deepseek` | DeepSeek | - | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `qwen` | 通义千问（阿里云百炼 / DashScope） | cn | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| | | global | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | |
| `kimi` | Kimi（月之暗面） | cn | `https://api.moonshot.cn/v1` | `KIMI_API_KEY` |
| | | global | `https://api.moonshot.ai/v1` | |
| `glm` | 智谱 GLM / Z.ai | cn | `https://open.bigmodel.cn/api/paas/v4` | `GLM_API_KEY` |
| | | global | `https://api.z.ai/api/paas/v4` | |
| `minimax` | MiniMax | cn | `https://api.minimaxi.com/v1` | `MINIMAX_API_KEY` |
| | | global | `https://api.minimax.io/v1` | |

### 国际

| id | 名称 | 默认接口地址 | key 环境变量 |
|---|---|---|---|
| `openai` | OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic Claude | `https://api.anthropic.com/v1`（OpenAI 兼容层） | `ANTHROPIC_API_KEY` |
| `gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` |
| `xai` | xAI Grok | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `openrouter` | OpenRouter（聚合，几百个模型） | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |

### 本地与自定义

| id | 名称 | 默认接口地址 | key |
|---|---|---|---|
| `ollama` | Ollama | `http://localhost:11434/v1` | 不需要 |
| `lmstudio` | LM Studio | `http://localhost:1234/v1` | 可选 `LM_API_KEY` |
| `custom` | 任意 OpenAI 兼容接口（vLLM、llama.cpp、中转站等） | 用户填写 | 用户指定环境变量 |

## 3. 从 Hermes 列表中去掉的部分

| 类别 | 去掉的提供商 | 原因 |
|---|---|---|
| 订阅账号 OAuth 登录 | Nous Portal、ChatGPT/Codex 订阅、Claude Max、Qwen OAuth、MiniMax OAuth、SuperGrok | 登录流程复杂，依赖各家客户端授权方式，变动频繁，部分有服务条款风险 |
| 企业云 | AWS Bedrock、Google Vertex AI、Azure AI Foundry | 需要云账号凭证体系，个人用户少；需要时可用 `custom` 接入 |
| 小众聚合与推理平台 | Ramp Router、Fireworks、NovitaAI、AI Gateway、Arcee、GMI Cloud、Nebius、Actual Computer、Kilo Code、OpenCode Zen/Go、CommandCode、DeepInfra、NVIDIA、Hugging Face、Ollama Cloud | 用户少；都兼容 OpenAI 接口，可用 `custom` 接入 |
| 国内其他 | 阶跃星辰、小米 MiMo、腾讯 TokenHub/TokenPlan、阿里 Coding Plan/Token Plan | 用户少或属于特定套餐；可用 `custom` 接入 |

### 可考虑补充（Hermes 未列出，但国内常用）

- **火山方舟（豆包）**：`https://ark.cn-beijing.volces.com/api/v3`
- **硅基流动 SiliconFlow**：`https://api.siliconflow.cn/v1`

第一版先通过 `custom` 支持，有用户反馈再提升为预设。

## 4. 配置格式

两个位置：项目目录的 `.ugc-lens/config.json`（只对当前目录生效，可提交，不能写 `api_key`）和全局的 `~/.ugc-lens/config.json`（`ugc-lens init` 写入，含 key，权限 600）。格式相同：

```json
{
  "llm": {
    "provider": "deepseek",
    "model": "从 /models 列表中选择",
    "region": "cn",
    "base_url": null,
    "api_key_env": null,
    "api_key": null,
    "timeout_ms": 120000,
    "max_retries": 3
  }
}
```

- `region`：只对有国内 / 国际两个地址的提供商生效，默认 `cn`。
- `base_url`：填写后覆盖预设地址（中转站、代理时使用）。
- `api_key_env`：填写后改从这个环境变量读 key；不填就用预设的环境变量名。
- `api_key`：直接写 key，只能写在全局配置里；写在项目配置会报错并提示迁移。
- `timeout_ms`：单次请求的超时时间，默认 120000。
- `max_retries`：网络错误、超时、限流（429）、服务端错误（5xx）时最多重试几次，默认 3；设为 0 关闭重试。

读取优先级：代码参数 > 进程环境变量（`UGC_LENS_PROVIDER`、`UGC_LENS_MODEL`、`UGC_LENS_BASE_URL`、各家 key）> 项目配置（不含密钥）> 全局配置 > 预设。每一项单独取最高优先级的值，比如全局配置选好了提供商和 key，某个项目仍可用自己的 `.ugc-lens/config.json` 换模型。项目目录的 `.env` 不读取（2026-11-10 起）；开发本仓库时示例脚本用 `node --env-file-if-exists=.env` 载入仓库根目录的 `.env`。

### 4.1 端点与凭证绑定

配置优先级仍适用于普通字段；凭证复用还必须通过端点检查。代码参数、进程启动时的环境变量和全局配置属于可信来源，项目配置不可声明自身可信，也不能保存密钥。

- 全局凭证绑定全局 provider/region/base_url 解析出的端点；提供商环境变量凭证绑定其预设端点，可信配置指定 `api_key_env` 时绑定可信配置的端点。
- 项目仅修改模型或填写同一规范化端点可继续复用密钥；更改 provider、region、base_url 后，如端点变化，拒绝携带继承凭证，并在任何模型请求前报错。项目指定 `api_key_env` 不能绕过绑定。
- 用户可通过代码参数 `base_url` 或进程环境变量 `UGC_LENS_BASE_URL` 显式绑定目标端点，或更新全局配置。比较整个规范化 URL（包含路径），仅忽略末尾斜杠；不按同域名扩大授权。
- 项目 `.env` 不再读取；项目配置不能提供凭证，因此只能在可信来源绑定的端点上复用全局或进程凭证。

## 5. 要注意的差异

- **工具调用能力不一样**。用来跑 Agent 循环的模型必须支持 function call。部分本地小模型不支持，或者会把工具调用当成普通文本输出。`init` 时可以发一次测试调用，检查是否支持。
- **Ollama 默认上下文很短**。Hermes 文档提到：显存小于 24 GB 时，Ollama 默认上下文只有 4096 token，处理评论数据很容易被截断。文档里要提示用户设置 `OLLAMA_CONTEXT_LENGTH`。
- **Anthropic 和 Gemini 的兼容层不完整**。它们的 OpenAI 兼容接口能满足基本对话和工具调用，但部分参数会被忽略（例如严格的 JSON Schema 约束）。等原生接口确有必要时，再单独写适配器（Hermes 对 Anthropic 用的就是原生接口）。
- **推理模型的参数不同**。部分模型（如 DeepSeek 推理模型、OpenAI 推理系列）对 `temperature` 等参数有限制，模型客户端要允许按提供商去掉不支持的参数。
- **token 用量字段**。大多数提供商在返回的 `usage` 里给出 token 数，个别字段名不同，统计时要兼容。
- **思考模式**。DeepSeek（`deepseek-flash` 等）默认开着思考模式：思考内容按输出 token 计费，而且开着思考时不接受指定工具的 `tool_choice`（返回 400）。分析流水线调用模型时传 `disableThinking`，按预设里的 `thinkingOff` 加上关闭字段：DeepSeek 和智谱是 `thinking: {type: "disabled"}`，通义千问是 `enable_thinking: false`；其他提供商不发送任何字段。
- **提示词缓存**。DeepSeek 自动缓存请求开头相同的部分，命中数在 `usage.prompt_cache_hit_tokens`；OpenAI 和多数兼容接口在 `usage.prompt_tokens_details.cached_tokens`。客户端统一成 `cached_input_tokens`。
- **流式输出**。只有图形界面对话使用：请求带 `stream: true` 和 `stream_options: {include_usage: true}`，按 SSE 逐段接收正文，工具调用按 `index` 拼接 `arguments`，用量取最后一个事件的 `usage`。不返回流式用量的接口记为“未返回”。命令行、ask、分析流水线和 MCP 仍用非流式请求。


## 6. 第 18 步缓存兼容规划（可选，待实现）

核对日期：2026-11-05。以下为规划依据，不表示当前已支持这些参数；实际模型与中转服务能力需要再次验证。

| 平台/场景 | 官方接口的缓存差异 | ugc-lens 计划 |
|---|---|---|
| OpenAI / 直接 API 模型 | 前缀缓存；缓存模式、断点、路由 key 和保留时间的支持随模型代际、接口变化 | 保留兼容路径，增加 Responses；按能力映射参数，不假设 Codex 型号都能通过 Chat Completions 调用 |
| Claude | 原生 Messages 支持 `cache_control`，可自动选择或显式设置断点；OpenAI 兼容层明确不支持提示词缓存 | 增加原生适配，处理工具结果与 thinking 状态；统计缓存创建和读取，不能只读普通 `input_tokens` |
| DeepSeek | 服务端默认自动缓存，依赖可复用前缀及实际持久化匹配；用量返回命中与未命中 | 稳定前缀、读取实际命中；不盲加别家的 TTL/断点参数，不保证第二次请求一定命中 |
| Kimi | 官方自动前缀缓存，具体模型的 TTL、模式、写入计费及相关字段存在差异；当前文档列出 `prompt_cache_options` | 按模型及接口确认支持再发送，记录读写用量，不把旧版显式缓存接口或第三方网关行为作为通用协议 |
| Codex / Claude Code 等 MCP 宿主 | 外层模型请求由宿主发送，与 ugc-lens 内部模型调用分开 | 稳定工具定义、限制返回体、复用本地分析结果；不能通过 stdio MCP 给宿主强设缓存参数或获取宿主账单 |

统一设计：缓存读取仍属于总输入，上下文长度和 token 预算不减去命中量；读、写和普通输入分开核算，未知字段保留未知。缓存 key 不包含完整用户历史或密钥；支持范围不能只按 provider 名推断，配置自定义 endpoint 后需显式能力说明。默认遵从平台标准策略，不额外预热，不自动选择更贵的长 TTL。

本地阶段结果缓存与以上远端 KV 缓存分开。前者可以避免重复语义分析，但必须按数据/ID、任务要求、实际模型与 endpoint、有效提示词及相关画像失效，提供刷新和清理；后者仍调用模型生成新的答复，命中量以接口实际返回为准。详细约定见 [architecture.md 第 2.5 节](architecture.md#25-模型接口与缓存优化roadmap-第-18-步可选待实现)。

官方依据：

- [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Responses API](https://developers.openai.com/api/reference/responses/overview)
- [Claude Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Claude OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)
- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [Kimi 上下文缓存最佳实践](https://platform.kimi.com/docs/guide/context-caching)
