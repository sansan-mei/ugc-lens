import { readFile } from 'node:fs/promises'
import type { Dataset, FeedbackItem } from '../../src/dataset/types.ts'
import { applyMapping } from '../../src/ingest/apply.ts'
import { BILIBILI_MAPPING, BV_FIXTURE } from './fixtures.ts'

export function makeItem(partial: Partial<FeedbackItem> & Pick<FeedbackItem, 'id'>): FeedbackItem {
  return { platform: 'bilibili', kind: 'comment', content_id: 'BV1', text: '', ...partial }
}

export function makeDataset(items: FeedbackItem[], partial: Partial<Dataset> = {}): Dataset {
  return {
    id: 'test',
    platform: 'bilibili',
    file_path: '/data/test.json',
    contents: [{ id: 'BV1', platform: 'bilibili', title: '测试视频' }],
    items,
    imported_at: new Date(0).toISOString(),
    mapping: { fingerprint: 'test', from_cache: false },
    report: { contents: 1, items: items.length, collections: [], errors: [], warnings: [], unmapped: [] },
    ...partial,
  }
}

/** 用手写规则转换 BV_FIXTURE，不调用模型 */
export async function fixtureDataset(): Promise<Dataset> {
  const raw = JSON.parse(await readFile(BV_FIXTURE, 'utf8'))
  const { contents, items, report } = applyMapping(raw, BILIBILI_MAPPING, { file_path: BV_FIXTURE })
  return makeDataset(items, { id: 'fixture', file_path: BV_FIXTURE, contents, report })
}
