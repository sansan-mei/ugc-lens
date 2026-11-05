/** 去掉平台加在正文前面的“回复 @某人 :”，这部分不是用户说的内容 */
const REPLY_PREFIX = /^\s*回复\s*@[^:：\s]*\s*[:：]\s*/

/**
 * 用于统计和比较的文本：全角转半角、去掉回复前缀和链接、英文转小写、空白压缩。
 * 只在分析时使用，不替换原文。
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(REPLY_PREFIX, '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 判断两条内容是否“说的是同一句话”：在 normalizeText 基础上去掉标点和空格，
 * 并把连续超过 3 个的相同字压成 3 个，“哈哈哈哈哈”和“哈哈哈”算同一句。
 */
export function dedupeKey(text: string): string {
  return normalizeText(text)
    .replace(/[\p{P}\p{S}\s]+/gu, '')
    .replace(/(.)\1{3,}/gu, '$1$1$1')
}

/** 去掉平台表情，如 B 站的 [笑哭]、[doge]，它们会被当成高频词 */
export function stripEmoji(text: string): string {
  return text.replace(/\[[^\[\]\s]{1,10}\]/g, ' ')
}

/** 可复现的伪随机数（mulberry32），抽样用；同一个种子每次得到相同的样本 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
