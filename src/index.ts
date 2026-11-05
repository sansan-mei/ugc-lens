/** 代码 API。命令行和以后的 MCP 服务只通过这些函数使用核心功能 */

export { loadLlmConfig, ConfigError, type LlmConfig, type LlmConfigFile } from './config.ts'
export { createChatClient, LlmError, type ChatClient, type ChatClientOptions } from './llm/client.ts'
export { PROVIDERS, type ProviderId, type ProviderPreset, type Region } from './llm/providers.ts'
export type { ChatMessage, ToolDefinition, Usage } from './llm/types.ts'

export { createLlmModel, type LlmModelOptions } from './agent/llm_model.ts'
export type { AgentModel, AgentModelRequest } from './agent/model.ts'
export { createFakeModel, type FakeModel, type FakeReply, type FakeScript } from './agent/fake_model.ts'
export { runAgent, DEFAULT_LIMITS, type AgentLimits, type AgentRunResult, type RunAgentOptions, type StopReason } from './agent/loop.ts'
export type { RunEvent, RunEventListener } from './agent/events.ts'

export { loadDataset, datasetId, ImportError, type ImportErrorCode, type LoadDatasetOptions } from './ingest/index.ts'
export type { ContentInfo, Dataset, FeedbackAuthor, FeedbackItem, FeedbackKind, ImportReport } from './dataset/types.ts'
export { computeStats, type DatasetStats } from './dataset/stats.ts'
export { findCitations, getFeedback, getReplies, searchFeedback, type FeedbackPage, type FeedbackQuery } from './dataset/query.ts'

export { analyzeDataset, type AnalyzeOptions, type AnalyzeProgress, type AnalyzeResult } from './pipeline/analyze.ts'
export { DEFAULT_DIRECTIONS, type Finding, type FindingRef } from './pipeline/summarize.ts'
export type { Theme } from './pipeline/merge.ts'
export { askDataset, type AskOptions, type AskResult } from './ask/index.ts'

export { openTaskStore, defaultTasksPath, type Task, type TaskStatus, type TaskStore } from './store/tasks.ts'
export { watchDirectory, type AnalyzeOutcome, type WatchEvent, type WatchOptions } from './watch/index.ts'
export { DEFAULT_PATTERNS } from './watch/pattern.ts'

export { defineTool, type ToolSpec } from './tools/define.ts'
export type { AgentTool } from './tools/types.ts'
export { createDataTools } from './tools/data/index.ts'

export { createSession, SESSION_SYSTEM_PROMPT, type ChatSession, type SessionOptions } from './chat/session.ts'
