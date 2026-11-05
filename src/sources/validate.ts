import type * as z from 'zod'

const MAX_ISSUES = 5

/** 原始文件不符合格式时，列出前几处问题的位置，方便用户定位 */
export function formatSchemaIssues(error: z.ZodError): string {
  const lines = error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '（文件顶层）'
    return `- ${path}：${issue.message}`
  })
  if (error.issues.length > MAX_ISSUES) lines.push(`- 另有 ${error.issues.length - MAX_ISSUES} 处问题`)
  return lines.join('\n')
}
