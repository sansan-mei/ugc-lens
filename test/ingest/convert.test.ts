import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClock, toCount, toId, toIso, toLocation, toText, toVideoSeconds } from '../../src/ingest/convert.ts'

test('toCount：数字、数字字符串、千分位、万、w、k、加号', () => {
  const cases: Array<[unknown, number | undefined]> = [
    [12, 12],
    ['12', 12],
    ['1,234', 1234],
    ['1.2万', 12000],
    ['3w', 30000],
    ['2.5k', 2500],
    ['10+', 10],
    ['', undefined],
    ['很多', undefined],
    [-1, undefined],
    [null, undefined],
  ]
  for (const [input, expected] of cases) assert.equal(toCount(input), expected, JSON.stringify(input))
})

test('toIso：秒和毫秒按大小区分，数字字符串和日期字符串都能识别', () => {
  const iso = '2024-10-22T10:55:33.000Z'
  assert.equal(toIso(1729594533), iso)
  assert.equal(toIso(1729594533000), iso)
  assert.equal(toIso('1729594533'), iso)
  assert.equal(toIso('1729594533000'), iso)
  assert.equal(toIso(iso), iso)
  for (const bad of [0, -5, '', '昨天', null, {}]) assert.equal(toIso(bad), undefined, JSON.stringify(bad))
})

test('parseClock / toVideoSeconds：时:分:秒、分:秒、秒数', () => {
  assert.equal(parseClock('01:02:03'), 3723)
  assert.equal(parseClock('02:03'), 123)
  for (const bad of ['', '12', '1:2:3:4', 'a:01', '01:-1']) assert.equal(parseClock(bad), undefined, bad)
  assert.equal(toVideoSeconds('00:01:21'), 81)
  assert.equal(toVideoSeconds(81.5), 81.5)
  assert.equal(toVideoSeconds('81.5'), 81.5)
  assert.equal(toVideoSeconds(-1), undefined)
})

test('toText / toId：原文不去空白，空字符串视为没有，数字转成字符串', () => {
  assert.equal(toText('  好 '), '  好 ')
  assert.equal(toText('   '), undefined)
  assert.equal(toText(42), '42')
  assert.equal(toText({}), undefined)
  assert.equal(toId(' 7 '), '7')
  assert.equal(toId(278829812416), '278829812416')
})

test('toLocation：去掉平台加的“IP属地：”前缀', () => {
  assert.equal(toLocation('IP属地：广东'), '广东')
  assert.equal(toLocation('IP 属地: 中国台湾 '), '中国台湾')
  assert.equal(toLocation('浙江'), '浙江')
  assert.equal(toLocation('IP属地：'), undefined)
  assert.equal(toLocation(null), undefined)
})
