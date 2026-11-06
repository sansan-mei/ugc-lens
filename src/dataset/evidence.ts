import type { Dataset, FeedbackItem } from './types.ts'
import { getFeedback } from './query.ts'

export type Evidence = Omit<FeedbackItem, 'kind'> & { kind: FeedbackItem['kind'] | 'transcript' }

export function transcriptId(contentId: string, index: number): string {
  return `${contentId}:transcript:${index + 1}`
}

export function transcriptEvidence(dataset: Dataset): Evidence[] {
  return dataset.contents.flatMap((content) => (content.transcript ?? []).map((line, i) => ({
    id: transcriptId(content.id, i), platform: content.platform, kind: 'transcript' as const,
    content_id: content.id, text: line.text, video_time_sec: line.start_sec,
  })))
}

export function getEvidence(dataset: Dataset, id: string): Evidence | undefined {
  return getFeedback(dataset, id) ?? transcriptEvidence(dataset).find((line) => line.id === id)
}
