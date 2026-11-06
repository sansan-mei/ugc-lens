import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { applyMapping, formatReport } from '../../src/ingest/apply.ts'
import type { Mapping } from '../../src/ingest/mapping.ts'
import { mappingSchema } from '../../src/ingest/mapping.ts'
import { describeShape } from '../../src/ingest/shape.ts'
import { AV_FIXTURE, BILIBILI_MAPPING, BV_FIXTURE } from '../helpers/fixtures.ts'

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const mapping = (input: unknown): Mapping => mappingSchema.parse(input)

test('B 站样本：条目数量与原始文件一致，回复指向所在评论，弹幕 ID 由程序生成', async () => {
  const raw = await readJson(BV_FIXTURE)
  const { contents, items, report } = applyMapping(raw, BILIBILI_MAPPING, { file_path: BV_FIXTURE })
  assert.deepEqual(report.errors, [])

  const count = (kind: string) => items.filter((item) => item.kind === kind).length
  assert.equal(count('comment'), raw.video_comments.length)
  assert.equal(count('reply'), raw.video_comments.reduce((sum: number, c: { replyList: unknown[] }) => sum + c.replyList.length, 0))
  assert.equal(count('danmaku'), raw.video_danmus.length)
  assert.equal(new Set(items.map((item) => item.id)).size, items.length)

  const byId = new Map(items.map((item) => [item.id, item]))
  for (const item of items) {
    assert.equal(item.content_id, 'BV1xx411c7mD')
    if (item.kind === 'reply') assert.equal(byId.get(item.parent_id!)?.kind, 'comment')
    else assert.equal(item.parent_id, undefined)
  }
  assert.deepEqual(
    items.filter((item) => item.kind === 'danmaku').map((item) => item.id),
    raw.video_danmus.map((_: unknown, i: number) => `danmaku-${i + 1}`),
  )
  assert.equal(items.find((item) => item.kind === 'danmaku')?.video_time_sec, 81)

  const [content] = contents
  assert.equal(contents.length, 1)
  assert.equal(content?.url, 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(content?.published_at, new Date(raw.video_info.pubdate * 1000).toISOString())
  assert.equal(content?.transcript?.length, raw.video_zimu.length)
  assert.equal(content?.stats?.views, raw.video_info.view)
  assert.ok(content?.summary)

  assert.deepEqual(
    report.collections.map((c) => [c.path, c.kind, c.imported]),
    [
      ['$.video_comments', 'comment', count('comment')],
      ['$.video_comments[].replyList', 'reply', count('reply')],
      ['$.video_danmus', 'danmaku', count('danmaku')],
    ],
  )
})

test('同一份规则用在结构相同、路径没有 BV 号的文件上会报错，不会猜 ID', async () => {
  const { report } = applyMapping(await readJson(AV_FIXTURE), BILIBILI_MAPPING, { file_path: AV_FIXTURE })
  assert.ok(report.errors.some((line) => line.includes('id_from_path')))
})

test('试转换报告：路径不存在、text 取不到、字段全部取不到都算错误', () => {
  const data = { list: [{ body: '好', n: 1 }, { body: '差', n: 2 }] }
  const check = (input: unknown, pattern: RegExp) => {
    const { report } = applyMapping(data, mapping(input), { file_path: '/x.json' })
    assert.ok(report.errors.some((line) => pattern.test(line)), `${JSON.stringify(report.errors)} 应匹配 ${pattern}`)
  }
  check({ platform: 'x', collections: [{ kind: 'comment', path: '$.nope', fields: { text: 'body' } }] }, /不是数组/)
  check({ platform: 'x', collections: [{ kind: 'comment', path: '$.list[]', fields: { text: 'body' } }] }, /去掉末尾的 \[\]/)
  check({ platform: 'x', collections: [{ kind: 'comment', path: '$.list', fields: { text: 'content' } }] }, /一条都没有导入/)
  check({ platform: 'x', collections: [{ kind: 'comment', path: '$.list', fields: { text: 'body', likes: 'like' } }] }, /字段 likes 路径在所有元素上都不存在/)
  check({ platform: 'x', collections: [{ kind: 'comment', path: '$.list', fields: { text: 'body', id: '$.const' } }] }, /字段 id/)
})

test('试转换报告：路径存在但值为空只警告（如 AI 总结为空字符串）', async () => {
  const avMapping = { ...BILIBILI_MAPPING, content: { ...BILIBILI_MAPPING.content, id_from_path: '-(\\d+)/bilibili_all\\.json$' } }
  const { contents, report } = applyMapping(await readJson(AV_FIXTURE), mapping(avMapping), { file_path: AV_FIXTURE })
  assert.deepEqual(report.errors, [])
  assert.ok(report.warnings.some((line) => line.includes('summary 的值都为空')))
  assert.equal(contents[0]?.id, '100000002')
  assert.equal(contents[0]?.summary, undefined)
})

test('lenient：缓存规则用在新文件上时，可选字段缺失只警告，text 和 id 缺失仍是错误', () => {
  const data = { list: [{ body: '好', n: 1 }] }
  const rule = (fields: Record<string, string>) =>
    mapping({ platform: 'x', collections: [{ kind: 'comment', path: '$.list', fields: { text: 'body', ...fields } }] })
  const lenient = applyMapping(data, rule({ likes: 'like' }), { file_path: '/x.json', lenient: true })
  assert.deepEqual(lenient.report.errors, [])
  assert.ok(lenient.report.warnings.some((line) => line.includes('likes 在这个文件里不存在')))
  assert.ok(applyMapping(data, rule({ id: 'rpid' }), { file_path: '/x.json', lenient: true }).report.errors.length > 0)
})

test('试转换报告：ID 重复是错误，命中率不足 100% 是警告', () => {
  const data = { list: [{ id: 1, t: 'a', like: 3 }, { id: 1, t: 'b' }] }
  const { report } = applyMapping(
    data,
    mapping({ platform: 'x', collections: [{ kind: 'comment', path: '$.list', fields: { id: 'id', text: 't', likes: 'like' } }] }),
    { file_path: '/x.json' },
  )
  assert.ok(report.errors.some((line) => line.includes('ID 重复')))
  assert.ok(report.warnings.some((line) => line.includes('likes 命中率 50%')))
})

test('扁平文件：parent_id 为 0 是一级评论，否则是回复；content_id 生成只有 ID 的内容', () => {
  const data = [
    { comment_id: '1', parent_comment_id: '0', video_id: 'v1', content: '一级', create_time: '1733853888' },
    { comment_id: '2', parent_comment_id: '1', video_id: 'v1', content: '回复', create_time: '1733853999' },
    { comment_id: '3', parent_comment_id: '0', video_id: 'v2', content: '另一个视频', create_time: '1733854000' },
    { comment_id: '4', parent_comment_id: '99', video_id: 'v2', content: '上一级不在文件里' },
  ]
  const { contents, items, report } = applyMapping(
    data,
    mapping({
      platform: 'bilibili',
      collections: [
        {
          kind: 'comment',
          path: '$',
          fields: { id: 'comment_id', text: 'content', parent_id: 'parent_comment_id', content_id: 'video_id', created_at: 'create_time' },
        },
      ],
    }),
    { file_path: '/x.json' },
  )
  assert.deepEqual(report.errors, [])
  assert.deepEqual(items.map((item) => [item.id, item.kind, item.parent_id, item.content_id]), [
    ['1', 'comment', undefined, 'v1'],
    ['2', 'reply', '1', 'v1'],
    ['3', 'comment', undefined, 'v2'],
    ['4', 'reply', '99', 'v2'],
  ])
  assert.deepEqual(contents.map((content) => content.id), ['v1', 'v2'])
  assert.ok(report.warnings.some((line) => line.includes('1 条回复的上一级不在文件里')))
})

test('内容是数组时，写在内容数组下面的集合属于所在内容；知乎式三层嵌套', () => {
  const data = {
    question: { id: 'q1', title: '问题' },
    answers: [
      { id: 'a1', content: '回答一', comments: [{ id: 'c1', content: '评论', childList: [{ id: 'r1', content: '回复' }] }] },
      { id: 'a2', content: '回答二', comments: [] },
    ],
  }
  const { contents, items, report } = applyMapping(
    data,
    mapping({
      platform: 'zhihu',
      content: { path: '$.question', fields: { id: 'id', title: 'title' } },
      collections: [
        {
          kind: 'answer',
          path: '$.answers',
          fields: { id: 'id', text: 'content' },
          children: [{ kind: 'comment', path: 'comments', children: [{ kind: 'reply', path: 'childList' }] }],
        },
      ],
    }),
    { file_path: '/x.json' },
  )
  assert.deepEqual(report.errors, [])
  assert.equal(contents.length, 1)
  assert.deepEqual(items.map((item) => [item.id, item.kind, item.parent_id, item.content_id]), [
    ['a1', 'answer', undefined, 'q1'],
    ['c1', 'comment', 'a1', 'q1'],
    ['r1', 'reply', 'c1', 'q1'],
    ['a2', 'answer', undefined, 'q1'],
  ])

  const notes = { notes: [{ id: 'n1', comments: [{ t: 'x' }] }, { id: 'n2', comments: [{ t: 'y' }, { t: 'z' }] }] }
  const result = applyMapping(
    notes,
    mapping({
      platform: 'xhs',
      content: { path: '$.notes', fields: { id: 'id' } },
      collections: [{ kind: 'comment', path: '$.notes[].comments', fields: { text: 't' } }],
    }),
    { file_path: '/x.json' },
  )
  assert.deepEqual(result.report.errors, [])
  assert.deepEqual(result.items.map((item) => item.content_id), ['n1', 'n2', 'n2'])
})

test('多个内容但互动内容无法对应时，规则不通过', () => {
  const data = { notes: [{ id: 'n1' }, { id: 'n2' }], comments: [{ t: 'x' }] }
  const { report } = applyMapping(
    data,
    mapping({
      platform: 'xhs',
      content: { path: '$.notes', fields: { id: 'id' } },
      collections: [{ kind: 'comment', path: '$.comments', fields: { text: 't' } }],
    }),
    { file_path: '/x.json' },
  )
  assert.ok(report.errors.some((line) => line.includes('无法确定属于哪一个')))
})

test('没有 content 规则时生成一个内容；没被使用的大数组给出警告', () => {
  const data = { comments: [{ t: 'a' }], danmaku: Array.from({ length: 6 }, (_, i) => ({ t: String(i) })) }
  const { contents, items, report } = applyMapping(
    data,
    mapping({ platform: 'unknown', collections: [{ kind: 'comment', path: '$.comments', fields: { text: 't' } }] }),
    { file_path: '/x.json', arrays: describeShape(data).arrays },
  )
  assert.deepEqual(contents.map((content) => content.id), ['content-1'])
  assert.equal(items[0]?.content_id, 'content-1')
  assert.ok(report.warnings.some((line) => line.includes('$.danmaku')))
  assert.match(formatReport(report), /集合 \$\.comments（comment）：元素 1，导入 1，跳过 0/)
})

test('下一级沿用上一级的规则时，这一级没有的字段只警告；写了 fields 就完全按它来', () => {
  const data = { list: [{ t: 'a', n: 2, replies: [{ t: 'b' }] }] }
  const rule = (children: unknown) =>
    mapping({ platform: 'x', collections: [{ kind: 'comment', path: '$.list', fields: { text: 't', reply_count: 'n' }, children }] })

  const inherited = applyMapping(data, rule([{ path: 'replies' }]), { file_path: '/x.json' })
  assert.deepEqual(inherited.report.errors, [])
  assert.ok(inherited.report.warnings.some((line) => line.includes('沿用上一级的字段 reply_count')))

  const explicit = applyMapping(data, rule([{ path: 'replies', fields: { text: 't' } }]), { file_path: '/x.json' })
  assert.deepEqual(explicit.report.errors, [])
  assert.deepEqual(explicit.report.collections[1]?.field_hits, { text: 1 })
})

test('ID、正文、所属内容都相同的重复条目去掉并警告', () => {
  const data = [
    { id: '1', t: '同一条', v: 'a' },
    { id: '1', t: '同一条', v: 'a' },
    { id: '2', t: '另一条', v: 'a' },
  ]
  const { items, report } = applyMapping(
    data,
    mapping({ platform: 'x', collections: [{ kind: 'comment', path: '$', fields: { id: 'id', text: 't', content_id: 'v' } }] }),
    { file_path: '/x.json' },
  )
  assert.deepEqual(report.errors, [])
  assert.deepEqual(items.map((item) => item.id), ['1', '2'])
  assert.ok(report.warnings.some((line) => line.includes('去掉了 1 条重复')))
})

test('内容对象和内容字段所在对象里的数组不算遗漏', () => {
  const data = {
    info: { title: 'T', images: Array.from({ length: 6 }, () => ({ url: 'u' })) },
    ai: { summary: 's', outline: Array.from({ length: 6 }, () => ({ part: 'p' })) },
    comments: [{ t: 'a' }],
  }
  const { report } = applyMapping(
    data,
    mapping({
      platform: 'x',
      content: { path: '$.info', id_from_path: '(x)', fields: { title: 'title', summary: '$.ai.summary' } },
      collections: [{ kind: 'comment', path: '$.comments', fields: { text: 't' } }],
    }),
    { file_path: '/x.json', arrays: describeShape(data).arrays },
  )
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.unmapped, [])
})

test('没被使用的数组只提醒元素是对象的', () => {
  const data = { comments: [{ t: 'a' }], urls: ['1', '2', '3', '4', '5', '6'] }
  const { report } = applyMapping(
    data,
    mapping({ platform: 'x', collections: [{ kind: 'comment', path: '$.comments', fields: { text: 't' } }] }),
    { file_path: '/x.json', arrays: describeShape(data).arrays },
  )
  assert.deepEqual(report.warnings, [])
})

test('取不到 text 的元素跳过并计数', () => {
  const data = { list: [{ t: 'a' }, { t: 'b' }, { t: '' }] }
  const { items, report } = applyMapping(
    data,
    mapping({ platform: 'x', collections: [{ kind: 'comment', path: '$.list', fields: { text: 't' } }] }),
    { file_path: '/x.json' },
  )
  assert.equal(items.length, 2)
  assert.equal(report.collections[0]?.skipped, 1)
  assert.ok(report.warnings.some((line) => line.includes('text 命中率 67%')))
})

test('重复父评论仍访问后一次新增回复，重复回复不重复导入', () => {
  const data = { list: [
    { id: 'p', text: '共同父评论', replies: [{ id: 'a', text: '第一个回复' }] },
    { id: 'p', text: '共同父评论', replies: [{ id: 'a', text: '第一个回复' }, { id: 'b', text: '另一个反对回复' }] },
  ] }
  const result = applyMapping(data, mapping({ platform: 'x', collections: [{ path: '$.list', kind: 'comment', fields: { id: 'id', text: 'text' }, children: [{ path: 'replies', kind: 'reply' }] }] }), { file_path: '/x.json' })
  assert.deepEqual(result.items.map((i) => i.id).sort(), ['a', 'b', 'p'])
  assert.ok(result.items.filter((i) => i.kind === 'reply').every((i) => i.parent_id === 'p'))
  assert.deepEqual(result.report.errors, [])
})

test('字幕字段映射错误不能报告命中率百分百或成功导入', () => {
  const result = applyMapping({ id: 'v', captions: [{ start: 0, end: 2, text: '正文' }], list: [{ text: '评论正文' }] }, mapping({ platform: 'x', content: { path: '$', fields: { id: 'id' }, transcript: { path: 'captions', start: 'missing', end: 'end', text: 'text' } }, collections: [{ path: '$.list', kind: 'comment', fields: { text: 'text' } }] }), { file_path: '/x.json' })
  assert.equal(result.report.content?.field_hits.transcript, 0)
  assert.ok(result.report.errors.some((e) => /字幕/.test(e)))
})


test('扁平子回复中的显式直接父 ID 优先于容器父评论，并继承内容归属', () => {
  const rule = mapping({ platform: 'x', collections: [{ path: '$.list', kind: 'comment', fields: { id: 'id', text: 'text', content_id: 'video' }, children: [{ path: 'replies', kind: 'reply', fields: { id: 'id', text: 'text', parent_id: 'target' } }] }] })
  const result = applyMapping({ list: [{ id: 'p', video: 'v', text: '建议很好', replies: [{ id: 'r1', text: '我反对', target: 'p' }, { id: 'r2', text: '我同意你', target: 'r1' }] }] }, rule, { file_path: '/x.json' })
  assert.equal(result.items.find((i) => i.id === 'r2')?.parent_id, 'r1')
  assert.ok(result.items.every((i) => i.content_id === 'v'))
})
