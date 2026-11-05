import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runPlaybook } from '../../src/cli/playbook.ts'
import { loadPlaybook, proposePlaybook, readProposal } from '../../src/memory/playbook.ts'

test('playbook CLI：无需模型配置即可初始化、查看、应用和拒绝；拒绝冲突参数', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ugc-playbook-cli-'))
  const memory = { cwd, homeDir: cwd }
  const original = console.log
  const output: string[] = []
  console.log = (...args: unknown[]) => { output.push(args.join(' ')) }
  try {
    await runPlaybook(['--init'], memory)
    const proposal = proposePlaybook(memory, { operation: 'add', section: 'ask', text: '- 先说样本限制。' })
    await runPlaybook([], memory)
    assert.match(output.join('\n'), new RegExp(proposal.id))
    assert.match(output.join('\n'), /先说样本限制/)
    await assert.rejects(runPlaybook(['--init', '--apply', proposal.id], memory), /一次只能/)
    await runPlaybook(['--apply', proposal.id], memory)
    assert.match(loadPlaybook(memory).sections.ask, /先说样本限制/)
    const pending = proposePlaybook(memory, { operation: 'add', section: 'ask', text: '- 待拒绝内容。' })
    await runPlaybook(['--reject', pending.id], memory)
    assert.equal(readProposal(memory), undefined)
    assert.doesNotMatch(loadPlaybook(memory).text, /待拒绝内容/)
  } finally { console.log = original; rmSync(cwd, { recursive: true, force: true }) }
})
