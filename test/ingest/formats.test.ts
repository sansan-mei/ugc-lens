import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ImportError } from '../../src/ingest/errors.ts'
import { parseInput, parseJsonLines, parseTable, readInput } from '../../src/ingest/formats.ts'

const errorCode = (code: string) => (error: unknown) => error instanceof ImportError && error.code === code

test('JSONL：忽略空行、接受 CRLF、保留嵌套对象，字符串生成稳定来源 ID', () => {
  const input = parseJsonLines('\r\n{"id":"01","body":{"text":"很好"}}\r\n\r\n{"id":"02","body":{"text":"太贵"}}\r\n')
  assert.deepEqual(input.data, [{ id: '01', body: { text: '很好' } }, { id: '02', body: { text: '太贵' } }])
  const strings = parseJsonLines('\n"第一条"\n\n"第二条\\n含换行"')
  assert.ok(strings.builtin)
  assert.deepEqual(strings.data, [{ source_id: 'line_2', text: '第一条' }, { source_id: 'line_4', text: '第二条\n含换行' }])
  assert.throws(() => parseJsonLines('{"ok":1}\n\ninvalid'), /第 3 行/)
  for (const text of ['[]', 'null', '1', '{}\n"text"']) assert.throws(() => parseJsonLines(text), errorCode('not_jsonl'))
})

test('CSV：表头与内部列键对应，保留前导零、逗号、转义引号、换行及空单元格', () => {
  const result = parseTable('用户.ID,开放题回答,日期\r\n001,"价格贵,但内容很好",2026-11-05\r\n002,"他说""不错""\r\n还会再来",\r\n', 'csv')
  assert.deepEqual(result.data, {
    columns: { column_1: '用户.ID', column_2: '开放题回答', column_3: '日期' },
    rows: [
      { source_id: 'line_2', column_1: '001', column_2: '价格贵,但内容很好', column_3: '2026-11-05' },
      { source_id: 'line_3', column_1: '002', column_2: '他说"不错"\r\n还会再来', column_3: '' },
    ],
  })
  assert.equal(result.builtin, undefined)
})

test('CSV 分号和 TSV：引号内分隔符不是列边界；公式只是原文', () => {
  const csv = parseTable('回答;编号\n"包含,逗号;分号";0001\n=SUM(A1:A2);0002', 'csv')
  const rows = (csv.data as { rows: Record<string, string>[] }).rows
  assert.equal(rows[0]?.column_1, '包含,逗号;分号')
  assert.equal(rows[1]?.column_1, '=SUM(A1:A2)')
  const tsv = parseTable('姓名\t评价\n甲\t"好\t但是贵"', 'tsv')
  assert.equal((tsv.data as { rows: Record<string, string>[] }).rows[0]?.column_2, '好\t但是贵')
})

test('CSV 拒绝空或重复表头、错列、非法引号；损坏记录给出物理行号', () => {
  for (const csv of ['a,a\n1,2', 'a,\n1,2', 'a,b\n1', 'a,b\n1,2,3', 'a,b\n"未闭合,2', 'a,b\n中"间,2', 'a,b\n"结束"x,2']) assert.throws(() => parseTable(csv, 'csv'), errorCode('not_csv'), csv)
  assert.throws(() => parseTable('a,b\n"多\n行",2\n错列', 'csv'), /第 4 行/)
})

test('TXT/LOG 按非空行，Markdown 按段落；不执行或改写正文', () => {
  const input = parseInput('第一条\r\n\r\n 第二条 \r\n', 'txt')
  assert.deepEqual(input.data, [{ source_id: 'line_1', text: '第一条' }, { source_id: 'line_3', text: ' 第二条 ' }])
  const md = parseInput('# 标题\n说明\n\n第一段\n第二行\n\n', 'markdown')
  assert.deepEqual(md.data, [{ source_id: 'line_1', text: '# 标题\n说明' }, { source_id: 'line_4', text: '第一段\n第二行' }])
  assert.ok(parseInput('rm -rf example', 'log').builtin)
  assert.ok(parseInput('["一条", "二条"]', 'json').builtin)
  for (const format of ['json', 'jsonl', 'csv', 'txt', 'markdown'] as const) assert.throws(() => parseInput(' \n\t', format), errorCode('empty_data'))
  assert.throws(() => parseInput('[]', 'json'), errorCode('empty_data'))
  assert.throws(() => parseInput('a,b', 'csv'), errorCode('empty_data'))
})

test('读取：后缀大小写、BOM、UTF-16 LE/BE、非法 UTF-8、二进制和取消', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ugc-formats-'))
  try {
    const csv = join(dir, 'table.CSV')
    await writeFile(csv, '\ufeff编号,回答\n001,价格高')
    assert.equal((await readInput(csv)).format, 'csv')
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文\n第二行', 'utf16le')])
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('中文\n第二行', 'utf16le').swap16()])
    for (const [name, bytes] of [['le.txt', le], ['be.txt', be]] as const) {
      const path = join(dir, name)
      await writeFile(path, bytes)
      assert.equal(((await readInput(path)).data as { text: string }[])[0]?.text, '中文')
    }
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('abc\0def')]) {
      await writeFile(join(dir, 'bad.txt'), bytes)
      await assert.rejects(readInput(join(dir, 'bad.txt')), errorCode('invalid_encoding'))
    }
    await writeFile(join(dir, 'custom.data'), '[{"text":"保留旧接口"}]')
    assert.equal((await readInput(join(dir, 'custom.data'))).format, 'json')
    await writeFile(join(dir, 'data.xml'), '<text>不支持 XML</text>')
    await assert.rejects(readInput(join(dir, 'data.xml')), errorCode('unsupported_format'))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(readInput(csv, controller.signal), { name: 'AbortError' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('CSV 忽略只有空白的物理行，但不丢弃显式空字段记录', () => {
  const parsed = parseTable(' \n编号,回答\n\t \n001,很好\n,\n', 'csv')
  assert.deepEqual((parsed.data as { rows: Record<string, string>[] }).rows, [
    { source_id: 'line_4', column_1: '001', column_2: '很好' },
    { source_id: 'line_5', column_1: '', column_2: '' },
  ])
})

test('读取前检查 100 MB 限制，不读取超限的稀疏文件', async () => {
  const { truncate } = await import('node:fs/promises')
  const { MAX_FILE_BYTES } = await import('../../src/ingest/errors.ts')
  const dir = await mkdtemp(join(tmpdir(), 'ugc-size-'))
  try {
    const path = join(dir, 'large.txt')
    await writeFile(path, '')
    await truncate(path, MAX_FILE_BYTES + 1)
    await assert.rejects(readInput(path), errorCode('too_large'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
