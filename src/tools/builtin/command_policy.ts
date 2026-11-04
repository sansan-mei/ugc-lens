/**
 * 判断命令是否属于只读白名单，属于的可以不经确认直接执行。
 * 规则偏保守：看不懂的写法一律判为“需要确认”，宁可多问一次。
 */

const READ_ONLY_COMMANDS = new Set([
  'basename', 'cat', 'cut', 'date', 'df', 'dirname', 'du', 'echo', 'file', 'find', 'git', 'grep',
  'head', 'ls', 'pwd', 'realpath', 'rg', 'sort', 'stat', 'tail', 'tree', 'uname', 'uniq', 'wc',
  'which', 'whoami',
])

const READ_ONLY_GIT = new Set(['blame', 'diff', 'log', 'ls-files', 'rev-parse', 'show', 'status'])

/** 这些参数会让本来只读的命令写文件或执行其他程序 */
const UNSAFE_FLAGS: Record<string, string[]> = {
  date: ['-s', '--set'],
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0', '-fprintf'],
  git: ['--output', '--ext-diff'],
  rg: ['--pre'],
  sort: ['-o', '--output'],
  tree: ['-o'],
}

/** 出现这些字符就可能有重定向、命令拼接、变量展开或子命令 */
const SHELL_SPECIAL = /[;&<>`$(){}\\\n\r]/

/** 按空白切分，支持单双引号；引号不配对时返回 undefined */
export function splitWords(segment: string): string[] | undefined {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let inWord = false
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      inWord = true
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current)
      current = ''
      inWord = false
    } else {
      current += char
      inWord = true
    }
  }
  if (quote) return undefined
  if (inWord) words.push(current)
  return words
}

function isReadOnlySegment(words: string[]): boolean {
  const [name, ...rest] = words
  if (!name || !READ_ONLY_COMMANDS.has(name)) return false
  if (name === 'git' && !READ_ONLY_GIT.has(rest[0] ?? '')) return false
  const unsafe = UNSAFE_FLAGS[name] ?? []
  return !rest.some((word) => unsafe.some((flag) => word === flag || word.startsWith(`${flag}=`)))
}

export function isReadOnlyCommand(command: string): boolean {
  if (command.trim() === '' || SHELL_SPECIAL.test(command)) return false
  const segments = command.split('|')
  return segments.every((segment) => {
    const words = splitWords(segment)
    return words !== undefined && words.length > 0 && isReadOnlySegment(words)
  })
}
