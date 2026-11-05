import { fileURLToPath } from 'node:url'

const fixture = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url))

/** 从真实数据截取，用户名、mid、rpid、弹幕发送者、封面已替换。路径同时含 BV 号和 av 号 */
export const BV_FIXTURE = fixture('media_crawl/bilibili/super_collect/BV1xx411c7mD/示例视频-100000001/bilibili_all.json')

/** 路径只有 av 号，没有弹幕，AI 总结为空 */
export const AV_FIXTURE = fixture('media_crawl/bilibili/示例视频-100000002/bilibili_all.json')
