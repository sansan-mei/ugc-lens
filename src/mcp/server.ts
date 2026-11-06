import { currentTask, withTask } from '../agent/usage.ts'
import { createMemoryTools } from '../memory/tools.ts'
import type { MemoryOptions } from '../memory/playbook.ts'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { createLlmModel } from '../agent/llm_model.ts'
import type { AgentModel } from '../agent/model.ts'
import { askDataset } from '../ask/index.ts'
import { loadLlmConfig } from '../config.ts'
import type { Dataset } from '../dataset/types.ts'
import { loadDataset } from '../ingest/index.ts'
import { createChatClient } from '../llm/client.ts'
import type { ChatMessage } from '../llm/types.ts'
import { analyzeDataset, type AnalyzeOptions, type AnalyzeResult } from '../pipeline/analyze.ts'
import { denyAll } from '../tools/approval.ts'
import { createDataTools } from '../tools/data/index.ts'
import { createProfileTools } from '../memory/profile.ts'
import { resolveDataset } from '../tools/data/shared.ts'
import { defineTool } from '../tools/define.ts'
import type { ToolContext } from '../tools/types.ts'
import type { WebSession } from '../web/tools.ts'
import { scenarioIds } from '../analysis/scenarios.ts'

export interface McpServerOptions {
  tokenBudget?: number
  memory?: MemoryOptions
  cwd?: string
  model?: AgentModel
  analysisModel?: AgentModel
  modelName?: string
  load?: typeof loadDataset
  analyze?: (options: AnalyzeOptions) => Promise<Pick<AnalyzeResult, 'markdown' | 'path' | 'calls' | 'usage' | 'memory_warning'>>
  /** 开启联网时为每段 ask 对话创建会话；只在服务内部的 ask 使用，不向宿主暴露联网工具 */
  web?: () => WebSession
}

interface AskConversation {
  dataset_id: string
  history?: ChatMessage[]
  web?: WebSession
  busy: boolean
}

const selector = {
  file: z.string().min(1).optional().describe('JSON、JSONL、CSV、TSV、TXT、Markdown 或 LOG 文件路径，相对于服务工作目录；提供后自动导入'),
  dataset_id: z.string().min(1).optional().describe('已导入的数据集 ID，不能与 file 同时提供；只有一个数据集时可省略'),
}

/** 每次创建独立状态；宿主直接调数据工具时，不需要再嵌套一个问答 Agent。 */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const cwd = resolve(options.cwd ?? process.cwd())
  const lifetime = new AbortController()
  const datasets = new Map<string, Dataset>()
  const conversations = new Map<string, AskConversation>()
  const store = { list: () => [...datasets.values()], get: (id: string) => datasets.get(id) }
  const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
  const server = new McpServer({ name: 'ugc-lens', version }, {
    instructions: '分析本地 结构化数据与文本记录。load_dataset 导入后可直接使用数据工具查询；analyze 生成报告；ask 使用配置的模型回答并返回 conversation_id，继续追问时传回该 ID。所有相对路径以服务 cwd 为准。',
  })
  let models: { ask: AgentModel; analysis: AgentModel; name?: string } | undefined
  const getModels = () => {
    if (models) return models
    if (options.model) {
      models = { ask: options.model, analysis: options.analysisModel ?? options.model, name: options.modelName }
    } else {
      const config = loadLlmConfig({}, cwd)
      const client = createChatClient(config)
      models = {
        ask: createLlmModel(client, { temperature: 0.2 }),
        analysis: options.analysisModel ?? createLlmModel(client, { temperature: 0, maxTokens: 4_000, disableThinking: true }),
        name: config.model,
      }
    }
    return models
  }
  const importFile = async (file: string, signal: AbortSignal): Promise<Dataset> => {
    const path = resolve(cwd, file)
    const cached = store.list().find((dataset) => dataset.file_path === path)
    if (cached) return cached
    const dataset = await (options.load ?? loadDataset)(path, {
      model: { complete: (request) => getModels().analysis.complete(request) }, signal, cacheDir: join(cwd, '.ugc-lens', 'mappings'),
    })
    signal.throwIfAborted()
    datasets.set(dataset.id, dataset)
    return dataset
  }
  const select = async (args: { file?: string; dataset_id?: string }, signal: AbortSignal): Promise<Dataset> => {
    if (args.file && args.dataset_id) throw new Error('file 和 dataset_id 只能提供一个')
    return args.file ? importFile(args.file, signal) : resolveDataset(store, args.dataset_id)
  }
  const dataTools = createDataTools(store, { memory: options.memory, sentimentModel: { complete: (request) => getModels().analysis.complete(request) } })
  const tools = [
    ...dataTools,
    ...(options.memory ? createProfileTools(options.memory, () => '').filter((tool) => tool.name === 'read_profile') : []),
    ...(options.memory ? createMemoryTools(store, options.memory) : []),
    defineTool({
      name: 'load_dataset', description: '导入本地 结构化数据或文本文件，返回 dataset_id。后续查询可复用，不需要反复发送原始文件。',
      parameters: z.object({ file: z.string().min(1) }),
      async execute({ file }, ctx) {
        const dataset = await importFile(file, ctx.signal)
        return JSON.stringify({ dataset_id: dataset.id, file: dataset.file_path, items: dataset.items.length, contents: dataset.contents.length })
      },
    }),
    defineTool({
      name: 'analyze', description: '对本地数据文件或已导入数据生成完整的 Markdown 分析报告，返回报告正文和保存路径。需要配置 ugc-lens 模型。',
      parameters: z.object({
        ...selector,
        directions: z.array(z.string().min(1)).min(1).optional().describe('关注方向；不传使用默认分析方向'),
        max_total_chars: z.number().int().positive().optional().describe('发送给模型的评论总字数上限，默认 80000'),
        scenario: z.enum(scenarioIds() as [string, ...string[]]).optional().describe('场景手册：reputation 危机与口碑，competitor 竞品对比'),
        recheck: z.boolean().optional().describe('是否用关键词补查核心发现的反例，默认 true，多一次模型调用'),
      }),
      async execute({ directions, max_total_chars, scenario, recheck, ...args }, ctx) {
        const dataset = await select(args, ctx.signal)
        const models = getModels()
        const result = await (options.analyze ?? analyzeDataset)({
          memory: options.memory, dataset, model: models.analysis, modelName: models.name, cwd, directions,
          maxTotalChars: max_total_chars, scenario, recheck, signal: ctx.signal,
        })
        ctx.signal.throwIfAborted()
        return JSON.stringify({ dataset_id: dataset.id, path: result.path, markdown: result.markdown, calls: result.calls, usage: result.usage, memory_warning: result.memory_warning })
      },
    }),
    defineTool({
      name: 'ask', description: '使用 ugc-lens 配置的模型查询数据并回答，返回带 [ID] 的回答和引用核对结果。连续追问时传回 conversation_id；宿主自己分析时可直接调用数据工具。',
      parameters: z.object({
        ...selector,
        question: z.string().trim().min(1),
        conversation_id: z.string().min(1).optional().describe('上一轮返回的 ID；不填则创建独立对话'),
      }),
      async execute({ conversation_id, question, ...args }, ctx) {
        const previous = conversation_id ? conversations.get(conversation_id) : undefined
        if (conversation_id && !previous) throw new Error('找不到追问会话，请不传 conversation_id 开始新对话')
        if (previous?.busy) throw new Error('这段对话的上一轮尚未完成，请等待后重试')
        if (previous) previous.busy = true
        try {
          const dataset = previous && !args.file && !args.dataset_id
            ? resolveDataset(store, previous.dataset_id)
            : await select(args, ctx.signal)
          if (previous && previous.dataset_id !== dataset.id) throw new Error('追问会话绑定了其他数据集，请不传 conversation_id 开始新对话')
          const web = previous?.web ?? options.web?.()
          const result = await askDataset({ memory: options.memory, model: getModels().ask, tools: { sentimentModel: getModels().analysis }, datasets: [dataset], question, history: previous?.history, web, signal: ctx.signal })
          ctx.signal.throwIfAborted()
          const id = conversation_id ?? randomUUID()
          conversations.set(id, { dataset_id: dataset.id, history: result.run.messages, web, busy: false })
          return JSON.stringify({
            conversation_id: id, dataset_id: dataset.id, answer: result.answer, citations: result.citations, web_citations: result.web_citations,
            stop_reason: result.run.stop_reason, steps: result.run.steps.length, usage: result.run.usage, playbook: result.playbook, memory_warning: result.memory_warning, profile_learning: result.profile_learning,
          })
        } finally { if (previous) previous.busy = false }
      },
    }),
  ]
  const readOnly = new Set([...dataTools.filter((tool) => !['analyze_sentiment', 'analyze_topics', 'analyze_business'].includes(tool.name)).map((tool) => tool.name), 'search_learnings', 'read_profile'])
  for (const tool of tools) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: fromJsonSchema<Record<string, unknown>>(tool.parameters),
      annotations: { readOnlyHint: readOnly.has(tool.name), destructiveHint: false, openWorldHint: !readOnly.has(tool.name) },
    }, async (args, request) => withTask(async () => {
      const signal = AbortSignal.any([lifetime.signal, request.mcpReq.signal])
      const context: ToolContext = { run_id: randomUUID(), cwd, signal, approve: denyAll }
      try {
        signal.throwIfAborted()
        const text = await tool.execute(args, context)
        return { content: [{ type: 'text', text }], structuredContent: { task_usage: currentTask()!.snapshot() } }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `错误：${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({ task_usage: currentTask()!.snapshot() })}` }] }
      }
    }, options.tokenBudget))
  }
  server.server.onclose = () => {
    lifetime.abort()
    datasets.clear()
    conversations.clear()
  }
  return server
}
