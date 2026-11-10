// 对话流的纯逻辑：NDJSON 分行与事件归并。浏览器和 Node 测试共用，不依赖 DOM。

export type ChatEvent =
  | { type: 'step'; step: number }
  | { type: 'delta'; step: number; text: string }
  | { type: 'tool'; step: number; call_id: string; name: string; args: string }
  | { type: 'tool_end'; call_id: string; name: string; ok: boolean }
  | { type: 'retry'; attempt: number; reason: string }
  | { type: 'warning'; message: string }
  | { type: 'done'; answer: string; stop_reason: string; citations: { valid: string[]; invalid: string[] }; known_tokens: number; unknown_calls: number }
  | { type: 'error'; message: string }

export interface ToolProgress { call_id: string; name: string; args: string; ok?: boolean }

export interface AssistantTurn {
  role: 'assistant'
  /** 流式时是当前这一步的正文；结束后是最终回答 */
  text: string
  status: 'streaming' | 'done' | 'error' | 'stopped'
  tools: ToolProgress[]
  warnings: string[]
  citations?: { valid: string[]; invalid: string[] }
  stop_reason?: string
  tokens?: number
  error?: string
}

export interface UserTurn { role: 'user'; text: string }
export type ChatTurn = UserTurn | AssistantTurn

export function newAssistantTurn(): AssistantTurn {
  return { role: 'assistant', text: '', status: 'streaming', tools: [], warnings: [] }
}

export function applyChatEvent(turn: AssistantTurn, event: ChatEvent): AssistantTurn {
  switch (event.type) {
    // 调用工具前的过渡语和重试前收到的半段都不是最终回答，新一步开始时清空
    case 'step': case 'retry': return { ...turn, text: '' }
    case 'delta': return { ...turn, text: turn.text + event.text }
    case 'tool': return { ...turn, tools: [...turn.tools, { call_id: event.call_id, name: event.name, args: event.args }] }
    case 'tool_end': return { ...turn, tools: turn.tools.map((t) => t.call_id === event.call_id ? { ...t, ok: event.ok } : t) }
    case 'warning': return { ...turn, warnings: [...turn.warnings, event.message] }
    case 'done': return { ...turn, text: event.answer, status: 'done', citations: event.citations, stop_reason: event.stop_reason, tokens: event.known_tokens }
    case 'error': return { ...turn, status: 'error', error: event.message }
  }
}

export function lineSplitter(): { push(chunk: string): string[]; flush(): string[] } {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      return lines.filter((line) => line.trim())
    },
    flush() {
      const rest = buffer.trim()
      buffer = ''
      return rest ? [rest] : []
    },
  }
}

const TOOL_LABELS: Record<string, string> = {
  list_datasets: '查看已接入数据', get_dataset_stats: '统计数据', search_feedback: '检索原文', get_feedback: '读取原文',
  load_dataset: '导入文件', list_files: '查看目录', analyze_dataset: '生成完整报告', analyze_sentiment: '情感评估',
  start_watch: '开始监听', watch_status: '查询监听', stop_watch: '停止监听', analyze_topics: '主题统计', analyze_business: '商业分析',
  get_analysis_coverage: '分析覆盖', get_content_timeline: '内容时间轴', read_profile: '读取画像', record_profile: '记录画像',
  search_learnings: '查找经验', record_learning: '记录经验', playbook_update: '更新手册',
}
export const toolLabel = (name: string): string => TOOL_LABELS[name] ?? name
