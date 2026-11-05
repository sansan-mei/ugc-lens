import type { RunEvent } from '../agent/events.ts'

const MAX_ARGS_CHARS = 200

function formatArgs(args: unknown): string {
  const text = JSON.stringify(args) ?? ''
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}…` : text
}

/** 把运行事件转成一行便于阅读的文本，命令行和示例共用 */
export function formatEvent(event: RunEvent): string {
  switch (event.type) {
    case 'run_start':
      return `▶ 开始运行 ${event.run_id.slice(0, 8)}（${event.kind}）`
    case 'model_start':
      return `  [第 ${event.step} 步] 调用模型${event.final ? '（收尾）' : ''}`
    case 'model_delta':
      return event.text
    case 'model_end':
      return (
        `  [第 ${event.step} 步] 模型返回：` +
        `${event.tool_calls > 0 ? `请求 ${event.tool_calls} 个工具` : '文字回答'}` +
        `（input=${event.usage.input_tokens} output=${event.usage.output_tokens}）`
      )
    case 'model_retry':
      return `  [第 ${event.step} 步] 模型调用失败：${event.reason}\n  [第 ${event.step} 步] ${(event.delay_ms / 1000).toFixed(1)} 秒后第 ${event.attempt} 次重试`
    case 'tool_start':
      return `    → 工具 ${event.name}(${formatArgs(event.args)})`
    case 'tool_end':
      return `    ${event.ok ? '✓' : '✗'} 工具 ${event.name} ${event.ok ? '成功' : '失败'}（${event.duration_ms}ms）`
    case 'pipeline_stage':
      return `  [流水线] ${event.stage}${event.progress === undefined ? '' : ` ${Math.round(event.progress * 100)}%`}`
    case 'run_end':
      return (
        `■ 结束：${event.stop_reason}，` +
        `累计 input=${event.usage.input_tokens} output=${event.usage.output_tokens}，耗时 ${event.duration_ms}ms`
      )
  }
}
