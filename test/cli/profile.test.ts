import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runProfile } from '../../src/cli/profile.ts'
import { loadProfile, visibleProfile } from '../../src/memory/profile.ts'
import { toolSandbox } from '../helpers/tool_context.ts'

test('profile CLI 无需模型即可启停、修正、确认、删除和清空', async (t) => {
  const sandbox = toolSandbox()
  const memory = { cwd: sandbox.dir, homeDir: sandbox.dir }
  t.mock.method(console, 'log', () => {})
  try {
    await runProfile(['--enable'], memory)
    await runProfile(['--set', 'skills', '--text', '擅长编程'], memory)
    const entry = visibleProfile(memory).entries[0]!
    assert.equal(entry.status, 'confirmed')
    await runProfile(['--confirm', entry.id], memory)
    await runProfile(['--delete', entry.id], memory)
    assert.equal(loadProfile(memory).entries.length, 0)
    await runProfile(['--disable'], memory)
    assert.equal(loadProfile(memory).enabled, false)
    await runProfile(['--clear'], memory)
    await assert.rejects(runProfile(['--enable', '--disable'], memory), /一次选择/)
    await assert.rejects(runProfile(['--learn', 'history.txt'], memory), /enable/)
  } finally { sandbox.cleanup() }
})
