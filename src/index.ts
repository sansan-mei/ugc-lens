/** 代码 API。命令行和 MCP 服务只通过这些函数使用核心功能 */

export { loadLlmConfig, ConfigError, type LlmConfig, type LlmConfigFile } from './config.ts'
export { createChatClient, LlmError, type ChatClient, type ChatClientOptions } from './llm/client.ts'
export { PROVIDERS, type ProviderId, type ProviderPreset, type Region } from './llm/providers.ts'
export type { ChatMessage, ToolDefinition, Usage } from './llm/types.ts'

export { createLlmModel, type LlmModelOptions } from './agent/llm_model.ts'
export type { AgentModel, AgentModelRequest } from './agent/model.ts'
export { createFakeModel, type FakeModel, type FakeReply, type FakeScript } from './agent/fake_model.ts'
export { runAgent, DEFAULT_LIMITS, type AgentLimits, type AgentRunResult, type RunAgentOptions, type StopReason } from './agent/loop.ts'
export type { RunEvent, RunEventListener } from './agent/events.ts'

export { loadDataset, datasetId, ImportError, type ImportErrorCode, type LoadDatasetOptions, type InputFormat } from './ingest/index.ts'
export type { ContentInfo, Dataset, FeedbackAuthor, FeedbackItem, FeedbackKind, ImportReport } from './dataset/types.ts'
export { computeStats, type DatasetStats } from './dataset/stats.ts'
export { findCitations, getFeedback, getReplies, searchFeedback, type FeedbackPage, type FeedbackQuery } from './dataset/query.ts'

export { analyzeDataset, type AnalyzeOptions, type AnalyzeProgress, type AnalyzeResult } from './pipeline/analyze.ts'
export { DEFAULT_DIRECTIONS, RECORD_DIRECTIONS, type Finding, type FindingRef } from './pipeline/summarize.ts'
export type { Theme } from './pipeline/merge.ts'
export { askDataset, type AskOptions, type AskResult } from './ask/index.ts'
export { analyzeSentiment, sentimentStats, type SentimentOptions, type SentimentRecord, type SentimentResult } from './sentiment/index.ts'
export { classifyTopics, type TopicDefinition } from './analysis/topics.ts'
export { analyzeBusiness } from './analysis/business.ts'
export { analysisCoverage } from './analysis/coverage.ts'
export { contentTimeline } from './analysis/content_timeline.ts'
export { configureProfile, loadProfile, visibleProfile, recordProfile, learnProfile, profilePath, type ProfileEntry } from './memory/profile.ts'

export { openTaskStore, defaultTasksPath, type Task, type TaskStatus, type TaskStore } from './store/tasks.ts'
export { watchDirectory, type AnalyzeOutcome, type WatchEvent, type WatchOptions } from './watch/index.ts'
export { DEFAULT_PATTERNS } from './watch/pattern.ts'

export { defineTool, type ToolSpec } from './tools/define.ts'
export type { AgentTool } from './tools/types.ts'
export { createDataTools } from './tools/data/index.ts'

export { createSession, SESSION_SYSTEM_PROMPT, type ChatSession, type SessionOptions } from './chat/session.ts'

export { DEFAULT_PLAYBOOK, loadPlaybook, parsePlaybook, initPlaybook, proposePlaybook, readProposal, reviewPlaybook } from './memory/playbook.ts'
export type { MemoryOptions, PlaybookSnapshot, PlaybookInfo, PlaybookChange, PlaybookProposal } from './memory/playbook.ts'
export { recordLearning, searchLearnings } from './memory/learnings.ts'
export type { Learning } from './memory/learnings.ts'
