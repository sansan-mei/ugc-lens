import { area, clock, columns, donut, hBars } from './charts.js'
import { escapeHtml as h, renderMarkdown } from './markdown.js'

const $ = (selector, root = document) => root.querySelector(selector)
const fmt = (n) => Number(n ?? 0).toLocaleString('zh-CN')
const pct = (x) => x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`
const KIND = { comment: '评论', reply: '回复', danmaku: '弹幕', answer: '回答', record: '记录', transcript: '字幕' }

// 令牌只在启动网址的 # 片段里出现，读取后存入本标签页并从地址栏移除，截图和分享时不会带出。
const hashToken = new URLSearchParams(location.hash.slice(1)).get('token')
if (hashToken) {
  sessionStorage.setItem('ugc-lens-token', hashToken)
  history.replaceState(null, '', location.pathname)
}
const token = sessionStorage.getItem('ugc-lens-token') ?? ''

const state = { tab: 'overview', overview: null, items: { query: '', kinds: [], sort: 'likes', offset: 0, list: [], total: 0 }, reports: null, report: null, peak: 0 }

async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, { ...options, headers: { 'x-ugc-lens-token': token, 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `请求失败（${res.status}）`)
  return body
}

let toastTimer
function toast(message) {
  const el = $('#toast')
  el.textContent = message
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 4200)
}

function setTab(tab) {
  state.tab = tab
  for (const button of document.querySelectorAll('.tab')) {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
    if (button.dataset.tab !== 'reports' && button.dataset.tab !== 'chat') button.disabled = !state.overview
  }
  render()
}

function render() {
  const view = $('#view')
  if (state.tab === 'reports') return renderReports(view)
  if (state.tab === 'chat') return renderChat(view)
  if (!state.overview) return renderEmpty(view)
  if (state.tab === 'items') return renderItems(view)
  return renderOverview(view)
}

// ---------- 空状态与打开文件 ----------

function renderEmpty(view) {
  view.innerHTML = `<section class="empty-state">
    <h1>打开一份数据</h1>
    <p>评论、弹幕、问卷或工单文件都可以。media_crawl 导出的 B 站 <code>*_all.json</code>、TXT、Markdown、CSV/JSONL 中已识别过结构的文件无需模型即可打开。</p>
    <button type="button" class="btn btn-primary" data-action="pick">选择文件</button>
  </section>`
}

async function openPicker() {
  $('#picker').hidden = false
  $('#picker-scrim').hidden = false
  $('#picker-filter').value = ''
  $('#file-list').innerHTML = '<p class="loading">正在列出文件…</p>'
  try {
    const { cwd, files } = await api('files')
    $('#picker-cwd').textContent = `目录：${cwd}`
    state.files = files
    renderFiles()
    $('#picker-filter').focus()
  } catch (error) { $('#file-list').innerHTML = `<p class="empty">${h(error.message)}</p>` }
}

function renderFiles() {
  const filter = $('#picker-filter').value.trim().toLowerCase()
  const files = (state.files ?? []).filter((f) => !filter || f.path.toLowerCase().includes(filter))
  $('#file-list').innerHTML = files.length ? files.map((f) => `<button type="button" class="file" data-path="${h(f.path)}"><span>${h(f.path)}</span><small>${(f.size / 1024).toFixed(f.size > 102400 ? 0 : 1)} KB · ${h(f.mtime.slice(0, 10))}</small></button>`).join('') : '<p class="empty">没有找到支持的数据文件</p>'
}

function closePicker() { $('#picker').hidden = true; $('#picker-scrim').hidden = true }

async function openFile(path) {
  closePicker()
  $('#view').innerHTML = '<p class="loading">正在导入…</p>'
  try {
    state.overview = await api('open', { method: 'POST', body: JSON.stringify({ path }) })
    localStorage.setItem('ugc-lens-last-file', path)
    state.items = { query: '', kinds: [], sort: 'likes', offset: 0, list: [], total: 0 }
    state.peak = 0
    setTab('overview')
  } catch (error) {
    toast(error.message)
    render()
  }
}

// ---------- 概况 ----------

function renderOverview(view) {
  const o = state.overview
  const content = o.contents.length === 1 ? o.contents[0] : undefined
  const title = content?.title ?? (o.contents.length > 1 ? `${o.contents.length} 个内容` : o.file.split('/').pop())
  const date = content?.published_at?.slice(0, 10)
  const counts = Object.entries(o.stats.items).filter(([, n]) => n > 0).map(([kind, n]) => `<div class="count"><b>${fmt(n)}</b><span>${KIND[kind]}</span></div>`)
  if (content?.transcript_lines) counts.push(`<div class="count"><b>${fmt(content.transcript_lines)}</b><span>字幕段</span></div>`)
  const cards = []

  if (o.danmaku?.timeline.length) {
    cards.push(`<section class="card span-12"><h2>弹幕密度</h2><p class="sub">每 ${o.danmaku.bin_sec} 秒一段，共 ${fmt(o.danmaku.total)} 条，去重后 ${fmt(o.danmaku.unique)} 种。${o.danmaku.peaks.length ? '粉色区域是高峰，点击查看。' : '没有明显高于平时的时段。'}</p>
      <div id="area">${area(o.danmaku.timeline, o.danmaku.bin_sec, o.danmaku.peaks)}</div>${o.danmaku.peaks.length ? '<div class="peak-detail" id="peak-detail"></div>' : ''}</section>`)
  }
  if (o.daily.length) {
    cards.push(`<section class="card span-7"><h2>发布时间</h2><p class="sub">评论、回复按天统计，弹幕没有发布时间。</p>${columns(o.daily.map((d) => ({ label: d.day.slice(5), value: d.count })))}</section>`)
  }
  if (o.stats.locations.length) {
    cards.push(`<section class="card ${o.daily.length ? 'span-5' : 'span-6'}"><h2>IP 属地</h2><p class="sub">${fmt(o.stats.with_location)} 条带属地，占比按这些条目计算。</p>
      ${hBars(o.stats.locations.slice(0, 10).map((l) => ({ label: l.name, value: l.count, note: `${fmt(l.count)} · ${pct(l.count / o.stats.with_location)}` })), { labelWidth: 64, tone: 'violet' })}</section>`)
  }
  if (o.top.length) {
    cards.push(`<section class="card span-7"><h2>高赞内容</h2><p class="sub">按点赞排序，点击查看全文和回复。</p><div class="list">${o.top.map(itemRow).join('')}</div></section>`)
  }
  const terms = (list, kind) => list.length ? `<div class="terms">${list.map((t) => `<button type="button" class="term" data-query="${h(t.word)}" data-kind="${kind}">${h(t.word)}<small>${fmt(t.docs)}</small></button>`).join('')}</div>` : ''
  if (o.keywords.length || o.danmaku?.terms.length) {
    cards.push(`<section class="card span-5"><h2>关键词</h2><p class="sub">数字为包含该词的条数，点击检索原文。</p>
      ${o.keywords.length ? `<p class="small muted">评论与回复</p>${terms(o.keywords.slice(0, 24), '')}` : ''}
      ${o.danmaku?.terms.length ? `<p class="small muted">弹幕</p>${terms(o.danmaku.terms.slice(0, 16), 'danmaku')}` : ''}</section>`)
  }
  for (const label of o.labels) cards.push(labelCard(label))
  if (!o.labels.length) {
    cards.push(`<section class="card span-12"><h2>情感与主题</h2><div class="notice">还没有逐条标注结果。在 Claude Code、Codex 中使用 ugc-lens 技能，或运行 <code>ugc-lens host label-export &lt;文件&gt; sentiment</code> 完成标注后，这里会显示情感分布、主题占比和商业机会。</div></section>`)
  }

  view.innerHTML = `<section class="headline">
      <div><h1>${h(title)}</h1>
        <div class="meta">
          <span class="chip">${h(o.platform)}</span>
          ${content?.author ? `<span>${h(content.author)}</span>` : ''}${date ? `<span>${h(date)}</span>` : ''}
          ${content?.url ? `<a href="${h(content.url)}" target="_blank" rel="noopener noreferrer">原链接</a>` : ''}
          <span class="chip">${o.mapping === 'builtin' ? '内置规则读取' : o.mapping === 'cache' ? '缓存规则读取' : '模型识别结构'}</span>
        </div></div>
      <div class="counts">${counts.join('')}</div>
    </section>
    <div class="grid">${cards.join('')}</div>`
  if (o.danmaku?.peaks.length) showPeak(state.peak)
}

function showPeak(index) {
  const peak = state.overview.danmaku.peaks[index]
  const el = $('#peak-detail')
  if (!peak || !el) return
  state.peak = index
  el.innerHTML = `<h3>${clock(peak.start_sec)}–${clock(peak.end_sec)} · ${fmt(peak.count)} 条（平时每段约 ${peak.baseline.toFixed(1)} 条）</h3>
    <div class="list">${peak.groups.map((g) => `<button type="button" class="item" data-id="${h(g.id)}"><div class="item-meta"><span class="kind">×${fmt(g.count)}</span>${g.first_sec !== undefined ? `<span>${clock(g.first_sec)}</span>` : ''}</div><div class="item-text">${h(g.text)}</div></button>`).join('')}</div>
    ${peak.terms.length ? `<p class="small muted">这段特有的词：${peak.terms.map((t) => h(t.word)).join('、')}</p>` : ''}`
}

const SENTIMENT = [['positive', '正面'], ['neutral', '中性'], ['negative', '负面'], ['mixed', '混合'], ['uncertain', '无法判断']]
const SENTIMENT_COLOR = { positive: '#34c759', neutral: '#8e8e93', negative: '#ff3b30', mixed: '#ff9f0a', uncertain: '#c7c7cc' }

function labelCard(label) {
  const s = label.summary
  const scope = s.scope_note ? `<p class="small muted">${h(s.scope_note)}</p>` : ''
  const coverage = `覆盖率 ${pct(label.coverage)}`
  if (label.task === 'sentiment') {
    const stats = s.summary
    return `<section class="card span-6"><h2>情感分布</h2><p class="sub">评价对象：${h(s.target)} · 已评估 ${fmt(stats.evaluated)}/${fmt(stats.total)} 条 · ${coverage}</p>
      <div class="split">${donut(SENTIMENT.map(([key, name]) => ({ label: name, value: stats.counts[key], color: SENTIMENT_COLOR[key] })), { center: fmt(stats.evaluated) })}
      <ul class="legend">${SENTIMENT.map(([key, name]) => `<li><span class="dot ${key}"></span>${name}<b>${fmt(stats.counts[key])} · ${pct(stats.proportions[key])}</b></li>`).join('')}
      <li class="small muted">均值 ${stats.mean_score === null ? '—' : stats.mean_score.toFixed(2)}（-1 到 1）</li></ul></div>${scope}</section>`
  }
  if (label.task === 'topics') {
    return `<section class="card span-6"><h2>主题占比</h2><p class="sub">逐条多标签归类，比例分母为成功归类条数，可超过 100% · ${coverage}</p>
      ${hBars(s.topics.map((t) => ({ label: t.title, value: t.count, note: `${fmt(t.count)} · ${pct(t.share)}` })), { labelWidth: 120, tone: 'accent' })}
      <p class="small muted">未归类 ${fmt(s.unclassified)} 条，无法判断 ${fmt(s.uncertain)} 条。</p>${scope}</section>`
  }
  const items = (s.opportunities ?? []).slice(0, 8)
  return `<section class="card span-12"><h2>商业机会</h2><p class="sub">每条机会附原文证据；优先级为模型建议，需要验证 · ${coverage}</p>
    <div class="list">${items.map((op) => `<div class="item"><div class="item-meta"><span class="kind">${op.priority === 'high' ? '高' : op.priority === 'medium' ? '中' : '低'}优先</span><span>${h(op.effort)}</span></div>
      <div><strong>${h(op.title)}</strong>：${h(op.problem)}</div>
      <div class="small muted">“${h(op.quote)}” ${op.refs.map((id) => `<button type="button" class="cite" data-id="${h(id)}">${h(id)}</button>`).join('')} · 验证：${h(op.validation)}</div></div>`).join('') || '<p class="empty">没有发现有证据的机会</p>'}</div>${scope}</section>`
}

function itemRow(item) {
  const meta = [`<span class="kind">${KIND[item.kind] ?? item.kind}</span>`]
  if (item.likes !== undefined) meta.push(`<span>赞 ${fmt(item.likes)}</span>`)
  if (item.reply_count) meta.push(`<span>回复 ${fmt(item.reply_count)}</span>`)
  if (item.video_time_sec !== undefined) meta.push(`<span>${clock(item.video_time_sec)}</span>`)
  if (item.location) meta.push(`<span>${h(item.location)}</span>`)
  if (item.created_at) meta.push(`<span>${h(item.created_at.slice(0, 10))}</span>`)
  if (item.author) meta.push(`<span>${h(item.author)}</span>`)
  return `<button type="button" class="item" data-id="${h(item.id)}"><div class="item-meta">${meta.join('')}</div><div class="item-text">${h(item.text)}</div></button>`
}

// ---------- 原文 ----------

function renderItems(view) {
  const kinds = Object.entries(state.overview.stats.items).filter(([, n]) => n > 0).map(([k]) => k)
  const s = state.items
  view.innerHTML = `<section class="card">
    <form class="toolbar" id="search-form">
      <input type="search" class="input" id="query" placeholder="空格表示都要出现，| 表示任一出现，如：退款|退钱 客服" value="${h(s.query)}">
      <select class="input" id="sort" aria-label="排序">
        ${[['likes', '按点赞'], ['replies', '按回复数'], ['newest', '最新'], ['oldest', '最早'], ['video_time', '视频时间']].map(([v, n]) => `<option value="${v}" ${s.sort === v ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
      <button class="btn btn-primary" type="submit">检索</button>
    </form>
    <div class="pills" id="kind-pills">${kinds.map((k) => `<button type="button" class="pill" data-kind="${k}" aria-pressed="${s.kinds.includes(k)}">${KIND[k]}</button>`).join('')}</div>
    <p class="total" id="total"></p>
    <div class="list" id="results"><p class="loading">加载中…</p></div>
    <div class="toolbar"><button type="button" class="btn btn-ghost" id="more" hidden>加载更多</button></div>
  </section>`
  loadItems(true)
}

async function loadItems(reset) {
  const s = state.items
  if (reset) { s.offset = 0; s.list = [] }
  const params = new URLSearchParams({ query: s.query, sort: s.sort, offset: String(s.offset), limit: '40' })
  if (s.kinds.length) params.set('kinds', s.kinds.join(','))
  try {
    const page = await api(`datasets/${encodeURIComponent(state.overview.id)}/items?${params}`)
    s.total = page.total
    s.list.push(...page.items)
    s.offset = s.list.length
    $('#total').textContent = `共 ${fmt(page.total)} 条${s.query ? `匹配“${s.query}”` : ''}`
    $('#results').innerHTML = s.list.length ? s.list.map(itemRow).join('') : '<p class="empty">没有匹配的原文</p>'
    $('#more').hidden = s.list.length >= s.total
  } catch (error) { $('#results').innerHTML = `<p class="empty">${h(error.message)}</p>` }
}

// ---------- 报告 ----------

async function renderReports(view) {
  view.innerHTML = '<div class="reports"><nav class="card report-list" id="report-list"><p class="loading">读取报告列表…</p></nav><article class="card prose" id="report-body"><p class="muted">选择左侧的报告。完整流水线生成的报告在 .ugc-lens/reports/，Agent 写的报告只要保存在启动目录内也会列出。</p></article></div>'
  try {
    const { reports } = await api('reports')
    state.reports = reports
    $('#report-list').innerHTML = reports.length ? reports.map((r) => `<button type="button" class="report-link" data-report="${h(r.path)}" aria-current="${state.report === r.path}">${h(r.path.split('/').pop())}<small>${h(r.path)} · ${h(r.mtime.slice(0, 16).replace('T', ' '))}</small></button>`).join('') : '<p class="empty">启动目录内没有 Markdown 报告</p>'
    if (state.report) showReport(state.report)
  } catch (error) { $('#report-list').innerHTML = `<p class="empty">${h(error.message)}</p>` }
}

async function showReport(path) {
  state.report = path
  for (const link of document.querySelectorAll('.report-link')) link.setAttribute('aria-current', String(link.dataset.report === path))
  const body = $('#report-body')
  body.innerHTML = '<p class="loading">读取中…</p>'
  try {
    const { text } = await api(`report?path=${encodeURIComponent(path)}`)
    body.innerHTML = renderMarkdown(text)
    await markCitations(body)
  } catch (error) { body.innerHTML = `<p class="empty">${h(error.message)}</p>` }
}

/** 报告里方括号内容不一定是 ID（如表情），打开了数据时逐个核对，不存在的显示为普通文字 */
async function markCitations(root) {
  const buttons = [...root.querySelectorAll('.cite')]
  if (!buttons.length || !state.overview) return
  const ids = [...new Set(buttons.map((b) => b.dataset.id))]
  try {
    const { existing } = await api(`datasets/${encodeURIComponent(state.overview.id)}/check-ids`, { method: 'POST', body: JSON.stringify({ ids }) })
    const found = new Set(existing)
    for (const button of buttons) if (!found.has(button.dataset.id)) {
      button.classList.add('plain')
      button.textContent = `[${button.dataset.id}]`
      button.disabled = true
    }
  } catch { /* 核对失败时保留按钮，点击时再提示 */ }
}

// ---------- 对话 ----------

function renderChat(view) {
  view.innerHTML = `<section class="card empty-state"><h2>对话</h2><p class="muted">网页内对话将在下一版提供，需要配置 ugc-lens 的模型（运行 <code>ugc-lens init</code>）。</p>
    <div class="notice">现在可以：在终端运行 <code>ugc-lens</code> 进入持续对话；或在 Claude Code、Codex 中安装 ugc-lens 技能（<code>npx skills add sansan-mei/ugc-lens</code>），用 Agent 自己的模型提问，不需要配置 key。</div></section>`
}

// ---------- 原文详情 ----------

async function openItem(id) {
  if (!state.overview) return toast('先打开对应的数据文件，才能查看引用的原文')
  $('#drawer').hidden = false
  $('#scrim').hidden = false
  const body = $('#drawer-body')
  body.innerHTML = '<p class="loading">读取中…</p>'
  try {
    const { item, parent, replies } = await api(`datasets/${encodeURIComponent(state.overview.id)}/items/${encodeURIComponent(id)}`)
    const meta = [KIND[item.kind] ?? item.kind, item.author, item.location, item.created_at?.slice(0, 16).replace('T', ' '), item.likes !== undefined ? `赞 ${fmt(item.likes)}` : '', item.video_time_sec !== undefined ? `视频 ${clock(item.video_time_sec)}` : ''].filter(Boolean)
    body.innerHTML = `<div class="item-meta">${meta.map((m) => `<span>${h(m)}</span>`).join('')}</div>
      <p class="detail-text">${h(item.text)}</p>
      <p class="small muted">ID ${h(item.id)}</p>
      ${parent ? `<p class="detail-section">回复的是</p>${itemRow(parent)}` : ''}
      ${replies.length ? `<p class="detail-section">直接回复（${fmt(replies.length)}）</p><div class="list">${replies.map(itemRow).join('')}</div>` : ''}`
  } catch (error) { body.innerHTML = `<p class="empty">${h(error.message)}</p>` }
}

function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true }

// ---------- 事件 ----------

document.addEventListener('click', (event) => {
  const target = event.target.closest('button, a, rect')
  if (!target) return
  if (target.id === 'brand') { event.preventDefault(); return setTab('overview') }
  if (target.matches('.tab')) return setTab(target.dataset.tab)
  if (target.id === 'open-file' || target.dataset.action === 'pick') return openPicker()
  if (target.id === 'picker-close') return closePicker()
  if (target.matches('.file')) return openFile(target.dataset.path)
  if (target.id === 'drawer-close') return closeDrawer()
  if (target.matches('.peak-band')) return showPeak(Number(target.dataset.peak))
  if (target.matches('.term')) {
    const textKinds = Object.entries(state.overview.stats.items).filter(([kind, n]) => n > 0 && kind !== 'danmaku').map(([kind]) => kind)
    state.items = { ...state.items, query: target.dataset.query, kinds: target.dataset.kind ? [target.dataset.kind] : textKinds, offset: 0, list: [] }
    return setTab('items')
  }
  if (target.matches('.pill')) {
    const kind = target.dataset.kind
    const kinds = state.items.kinds.includes(kind) ? state.items.kinds.filter((k) => k !== kind) : [...state.items.kinds, kind]
    state.items.kinds = kinds
    target.setAttribute('aria-pressed', String(kinds.includes(kind)))
    return loadItems(true)
  }
  if (target.id === 'more') return loadItems(false)
  if (target.matches('.report-link')) return showReport(target.dataset.report)
  if (target.matches('.cite') && !target.disabled) return openItem(target.dataset.id)
  if (target.matches('.item[data-id]')) return openItem(target.dataset.id)
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeDrawer(); closePicker() }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('.peak-band')) { event.preventDefault(); showPeak(Number(event.target.dataset.peak)) }
})
document.addEventListener('submit', (event) => {
  if (event.target.id !== 'search-form') return
  event.preventDefault()
  state.items.query = $('#query').value.trim()
  state.items.sort = $('#sort').value
  loadItems(true)
})
$('#scrim').addEventListener('click', closeDrawer)
$('#picker-scrim').addEventListener('click', closePicker)
$('#picker-filter').addEventListener('input', renderFiles)

if (!token) {
  $('#view').innerHTML = '<section class="empty-state"><h1>缺少访问令牌</h1><p>请使用 ugc-lens ui 启动时打印的完整网址打开本页面。</p></section>'
} else {
  setTab('overview')
  const last = localStorage.getItem('ugc-lens-last-file')
  if (last) openFile(last)
}
