/** 概况页自动分析的纯逻辑，不依赖 DOM，Node 测试直接覆盖 */

export type AnalysisTask = 'sentiment' | 'topics'
export interface JobStatus { state: 'idle' | 'running' | 'done' | 'error'; error?: string; started_at?: string; finished_at?: string }
export type AnalysisStatus = Record<AnalysisTask, JobStatus>
export interface AnalysisSettings { auto_sentiment: boolean; auto_topics: boolean; token_budget: number }

export const ANALYSIS_TASKS: ReadonlyArray<{ id: AnalysisTask; name: string; desc: string }> = [
  { id: 'sentiment', name: '情感分析', desc: '逐条评分，统计正面、中性、负面、混合的比例' },
  { id: 'topics', name: '主题统计', desc: '先发现主题，再逐条归类，统计各主题占比' },
]

export function analysisTaskView(status: JobStatus): { text: string; action: string | null; running: boolean } {
  switch (status.state) {
    case 'running': return { text: '分析中…', action: null, running: true }
    case 'done': return { text: '已完成', action: '重新分析', running: false }
    case 'error': return { text: `失败：${status.error ?? '未知原因'}`, action: '重试', running: false }
    default: return { text: '尚未分析', action: '开始分析', running: false }
  }
}

export const anyRunning = (status: Partial<AnalysisStatus>): boolean => Object.values(status).some((s) => s?.state === 'running')
