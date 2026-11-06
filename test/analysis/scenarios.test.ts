import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { applyScenario, listScenarios, loadScenario } from '../../src/analysis/scenarios.ts'
import { DEFAULT_PLAYBOOK, playbookRules } from '../../src/memory/playbook.ts'

describe('场景手册', () => {
  test('随包提供危机与口碑、竞品对比，每个都有方向、规则和指纹', () => {
    const ids = listScenarios().map((s) => s.id)
    assert.ok(ids.includes('reputation') && ids.includes('competitor'))
    for (const id of ids) {
      const scenario = loadScenario(id)
      assert.ok(scenario.title.length > 0)
      assert.ok(scenario.directions.length >= 3)
      assert.ok(scenario.rules.length >= 3)
      assert.match(scenario.hash, /^[0-9a-f]{12}$/)
    }
    assert.equal(loadScenario('reputation').title, '危机与口碑')
  })

  test('未知场景报错并列出可选项', () => {
    assert.throws(() => loadScenario('finance'), /reputation.*competitor|competitor.*reputation/)
    assert.throws(() => loadScenario('../default'), /未知/)
  })

  test('应用场景把规则追加到共同规则，返回新快照且不改原手册', () => {
    const scenario = loadScenario('competitor')
    const applied = applyScenario(DEFAULT_PLAYBOOK, scenario)
    assert.notEqual(applied, DEFAULT_PLAYBOOK)
    assert.equal(applied.version, DEFAULT_PLAYBOOK.version)
    assert.equal(applied.hash, DEFAULT_PLAYBOOK.hash)
    for (const stage of ['summarize', 'merge', 'ask'] as const) {
      const rules = playbookRules(applied, stage)
      assert.ok(rules.includes(scenario.rules[0]!), stage)
      assert.ok(rules.includes('竞品对比'))
    }
    assert.ok(!playbookRules(DEFAULT_PLAYBOOK, 'summarize').includes(scenario.rules[0]!))
    assert.ok(Object.isFrozen(applied))
  })
})
