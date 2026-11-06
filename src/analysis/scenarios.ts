import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import type { PlaybookSnapshot } from '../memory/playbook.ts'

export interface Scenario {
  id: string
  title: string
  /** 未指定关注点时使用的分析方向 */
  directions: string[]
  /** 追加到共同规则的场景规则 */
  rules: string[]
  hash: string
}

const DIR = new URL('../../playbook/scenarios/', import.meta.url)

function items(text: string, heading: string): string[] {
  const block = text.match(new RegExp(`^## ${heading}\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))?.[1] ?? ''
  return block.split(/\r?\n/).map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1]).filter((line): line is string => Boolean(line))
}

function parse(id: string, text: string): Scenario {
  const title = text.match(/^# (.+?)\s*$/m)?.[1]
  const directions = items(text, '分析方向')
  const rules = items(text, '规则')
  if (!title || !directions.length || !rules.length) throw new Error(`场景手册 ${id} 需要标题、“## 分析方向”和“## 规则”列表`)
  return { id, title, directions, rules, hash: createHash('sha256').update(text).digest('hex').slice(0, 12) }
}

/** 随包提供的场景 ID，按文件名排序 */
export function scenarioIds(): string[] {
  return readdirSync(DIR).filter((name) => /^[a-z][a-z0-9_-]*\.md$/.test(name)).map((name) => name.slice(0, -3)).sort()
}

export function loadScenario(id: string): Scenario {
  const ids = scenarioIds()
  // 只接受已有的文件名，避免通过 ../ 读取其他文件
  if (!ids.includes(id)) throw new Error(`未知的分析场景 "${id}"，可选：${ids.join(', ')}`)
  return parse(id, readFileSync(new URL(`${id}.md`, DIR), 'utf8'))
}

export function listScenarios(): Scenario[] {
  return scenarioIds().map(loadScenario)
}

/**
 * 把场景规则追加到共同规则，返回新的快照。版本与指纹沿用原手册，
 * 报告另行记录场景与场景手册指纹。
 */
export function applyScenario(playbook: PlaybookSnapshot, scenario: Scenario): PlaybookSnapshot {
  const common = `${playbook.sections.common}\n\n本次分析场景：${scenario.title}\n${scenario.rules.map((rule) => `- ${rule}`).join('\n')}`
  return Object.freeze({ ...playbook, sections: Object.freeze({ ...playbook.sections, common }) })
}
