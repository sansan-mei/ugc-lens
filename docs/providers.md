# 模型提供商

> 参考 Hermes Agent 2026 年 11 月的提供商列表（hermes-agent.nousresearch.com/docs/integrations/providers）精简而来。
> 各家接口地址以官方文档为准，实现第 1 步时逐个验证。

## 1. 原则

- **用户自己选**，不内置默认厂商。`init` 时交互式选择，或直接写配置文件。
- **统一走 OpenAI 兼容的 Chat Completions 接口**。下面所有提供商都支持这种协议，第一版只需要写一个模型客户端。
- **不内置默认模型名**。模型更新太快，写死很快就过时。`init` 时调用提供商的 `GET /models` 列出可选模型，由用户选择；接口不支持时让用户手动输入。
- **API key 只放环境变量或 `.env`**，配置文件里只写“从哪个环境变量读 key”，避免 key 被误提交到 git。（与 Hermes 的做法一致：配置文件管模型和地址，`.env` 管密钥。）

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

`.ugc-lens/config.json`：

```json
{
  "llm": {
    "provider": "deepseek",
    "model": "从 /models 列表中选择",
    "region": "cn",
    "base_url": null,
    "api_key_env": null,
    "timeout_ms": 120000,
    "max_retries": 3
  }
}
```

- `region`：只对有国内 / 国际两个地址的提供商生效，默认 `cn`。
- `base_url`：填写后覆盖预设地址（中转站、代理时使用）。
- `api_key_env`：填写后改从这个环境变量读 key；不填就用预设的环境变量名。

读取优先级：命令行参数 > 环境变量（`UGC_LENS_PROVIDER`、`UGC_LENS_MODEL`、`UGC_LENS_BASE_URL`）> 配置文件 > 预设。

## 5. 要注意的差异

- **工具调用能力不一样**。用来跑 Agent 循环的模型必须支持 function call。部分本地小模型不支持，或者会把工具调用当成普通文本输出。`init` 时可以发一次测试调用，检查是否支持。
- **Ollama 默认上下文很短**。Hermes 文档提到：显存小于 24 GB 时，Ollama 默认上下文只有 4096 token，处理评论数据很容易被截断。文档里要提示用户设置 `OLLAMA_CONTEXT_LENGTH`。
- **Anthropic 和 Gemini 的兼容层不完整**。它们的 OpenAI 兼容接口能满足基本对话和工具调用，但部分参数会被忽略（例如严格的 JSON Schema 约束）。等原生接口确有必要时，再单独写适配器（Hermes 对 Anthropic 用的就是原生接口）。
- **推理模型的参数不同**。部分模型（如 DeepSeek 推理模型、OpenAI 推理系列）对 `temperature` 等参数有限制，模型客户端要允许按提供商去掉不支持的参数。
- **token 用量字段**。大多数提供商在返回的 `usage` 里给出 token 数，个别字段名不同，统计时要兼容。
