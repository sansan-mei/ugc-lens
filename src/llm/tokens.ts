const WIDE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/gu

/**
 * 粗略估计 token 数：汉字、假名、谚文、全角符号约 0.9 个，其他字符约 0.4 个（按 DeepSeek 实测的评论数据校准）。
 * 各家分词不同，只用于事先提示，实际用量以接口返回为准。
 */
export function approxTokens(text: string): number {
  const wide = text.match(WIDE)?.length ?? 0
  return Math.ceil(wide * 0.9 + (text.length - wide) * 0.4)
}
