import { makeDataset, makeItem } from './dataset.ts'

/** 固定的小回归集：评论、缺失回复链、含重复内容的弹幕。 */
export const playbookCases = [
  makeDataset([
    makeItem({ id: 'price-1', text: '这个售价比之前贵了不少', likes: 20 }),
    makeItem({ id: 'price-2', text: '价格高但是内容质量不错', likes: 5 }),
  ], { id: 'price-comments' }),
  makeDataset([
    makeItem({ id: 'root', text: '售后体验如何，这个价格值得吗', reply_count: 10 }),
    makeItem({ id: 'reply', kind: 'reply', parent_id: 'root', text: '售后处理很快，价格我能接受' }),
  ], { id: 'incomplete-replies' }),
  makeDataset([
    makeItem({ id: 'dm-1', kind: 'danmaku', text: '这个价格有点高', video_time_sec: 10 }),
    makeItem({ id: 'dm-2', kind: 'danmaku', text: '这个价格有点高', video_time_sec: 12 }),
    makeItem({ id: 'dm-3', kind: 'danmaku', text: '内容质量对得起价格', video_time_sec: 20 }),
  ], { id: 'danmaku-repeats' }),
]
