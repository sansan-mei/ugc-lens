export type PathToken = string

const FLATTEN = '[]'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** "$.answers[].comments" → ["answers", "[]", "comments"]；"user.name" → ["user", "name"] */
export function tokenize(path: string): PathToken[] {
  const body = path.startsWith('$') ? path.slice(1) : path
  return body.replaceAll(FLATTEN, `.${FLATTEN}`).split('.').filter(Boolean)
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('$')
}

/** 从一组起点出发走完路径，返回所有到达的值。走不通的分支直接丢弃 */
export function resolveTokens(starts: readonly unknown[], tokens: readonly PathToken[]): unknown[] {
  let values: unknown[] = [...starts]
  for (const token of tokens) {
    values =
      token === FLATTEN
        ? values.flatMap((value) => (Array.isArray(value) ? value : []))
        : values.flatMap((value) => (isRecord(value) && Object.hasOwn(value, token) ? [value[token]] : []))
  }
  return values
}

/** 字段路径：$ 开头从文件顶层取，否则从当前元素取 */
export function getField(element: unknown, root: unknown, path: string): unknown {
  return resolveTokens([isAbsolute(path) ? root : element], tokenize(path))[0]
}

export function startsWithTokens(tokens: readonly PathToken[], prefix: readonly PathToken[]): boolean {
  return prefix.length <= tokens.length && prefix.every((token, index) => tokens[index] === token)
}

export function joinTokens(tokens: readonly PathToken[]): string {
  return `$${tokens.map((token) => (token === FLATTEN ? FLATTEN : `.${token}`)).join('')}`
}

export { FLATTEN, isRecord }
