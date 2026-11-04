import type { Usage } from '../llm/types.ts'

export type RunEvent =
  | { type: 'run_start'; run_id: string; kind: 'agent' | 'pipeline' }
  /** final 为 true 表示收尾调用 */
  | { type: 'model_start'; run_id: string; step: number; final: boolean }
  | { type: 'model_delta'; run_id: string; step: number; text: string }
  | { type: 'model_end'; run_id: string; step: number; usage: Usage; tool_calls: number }
  | { type: 'tool_start'; run_id: string; step: number; call_id: string; name: string; args: unknown }
  | {
      type: 'tool_end'
      run_id: string
      step: number
      call_id: string
      name: string
      ok: boolean
      duration_ms: number
    }
  | { type: 'pipeline_stage'; run_id: string; stage: string; progress?: number }
  | { type: 'run_end'; run_id: string; stop_reason: string; usage: Usage; duration_ms: number }

export type RunEventListener = (event: RunEvent) => void
