// 安全的 Markdown 渲染：先转义全部文本，只生成白名单标签；[ID] 引用渲染为按钮，链接只允许 http(s)。
// 浏览器和 Node 测试共用，不依赖 DOM。

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

const CITE = /^[^\s[\]]{1,64}$/

function inline(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let m
    if ((m = /^`([^`]+)`/.exec(rest))) { out.push(`<code>${escapeHtml(m[1])}</code>`); i += m[0].length; continue }
    if ((m = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest))) {
      out.push(`<a href="${escapeHtml(m[2])}" target="_blank" rel="noopener noreferrer">${inline(m[1])}</a>`); i += m[0].length; continue
    }
    if ((m = /^\[([^\]\n]+)\](?!\()/.exec(rest))) {
      const ids = m[1].split(/\s*,\s*/)
      if (ids.every((id) => CITE.test(id)) && !/^web:\d+$/.test(m[1])) {
        out.push(ids.map((id) => `<button type="button" class="cite" data-id="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join(''))
        i += m[0].length
        continue
      }
    }
    if ((m = /^\*\*([^*]+)\*\*/.exec(rest))) { out.push(`<strong>${inline(m[1])}</strong>`); i += m[0].length; continue }
    if ((m = /^\*([^*\s][^*]*)\*/.exec(rest))) { out.push(`<em>${inline(m[1])}</em>`); i += m[0].length; continue }
    const next = rest.slice(1).search(/[`[*]/)
    const chunk = next < 0 ? rest : rest.slice(0, next + 1)
    out.push(escapeHtml(chunk))
    i += chunk.length
  }
  return out.join('')
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

export function renderMarkdown(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n')
  const html = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    let m
    if ((m = /^```/.exec(line))) {
      const body = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { html.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { html.push('<hr>'); i++; continue }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]))
      html.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      html.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`)
      continue
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line))) {
      const ordered = /\d/.test(m[2])
      const items = []
      while (i < lines.length && (m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]))) {
        const depth = Math.min(Math.floor(m[1].length / 2), 3)
        let text = m[3]
        i++
        while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i])) text += ` ${lines[i++].trim()}`
        items.push(`<li class="depth-${depth}">${inline(text)}</li>`)
      }
      html.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    const para = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*>|\s*\||\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++])
    html.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return html.join('\n')
}
