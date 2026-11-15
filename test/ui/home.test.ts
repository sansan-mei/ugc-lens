import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DATA_EXT, FORMAT_GROUPS, headerFileAction } from '../../web/src/lib/home.ts'

test('顶栏文件入口：首页空状态不重复主按钮，打开数据后显示当前文件', () => {
  // 首页（概况/原文且没有数据）已经有大按钮，顶栏不再放“打开数据”
  assert.equal(headerFileAction('overview', false), 'none')
  assert.equal(headerFileAction('items', false), 'none')
  // 其他页面没有数据时，仍然给一个打开文件的入口
  assert.equal(headerFileAction('chat', false), 'open')
  assert.equal(headerFileAction('reports', false), 'open')
  // 有数据时一律显示当前文件，点击切换
  for (const tab of ['overview', 'items', 'reports', 'chat']) assert.equal(headerFileAction(tab, true), 'current')
})

test('首页格式说明覆盖文件选择框接受的全部扩展名', () => {
  const listed = FORMAT_GROUPS.flatMap((g) => g.exts)
  const accepted = DATA_EXT.split(',')
  assert.deepEqual([...listed].sort(), [...accepted].sort())
})

test('标签页：没有数据时不显示检索页，打开数据后显示全部', async () => {
  const { visibleTabs } = await import('../../web/src/lib/home.ts')
  assert.ok(!visibleTabs(false).includes('items'))
  assert.ok(visibleTabs(false).includes('overview'))
  assert.ok(visibleTabs(true).includes('items'))
  // 没有数据时隐藏的只有检索页，报告和对话仍可用
  assert.deepEqual(visibleTabs(true).filter((t) => !visibleTabs(false).includes(t)), ['items'])
})
