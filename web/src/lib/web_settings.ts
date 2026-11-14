import type { WebSettingsView } from './types.ts'

/** 联网设置表单的纯逻辑，不依赖 DOM，Node 测试直接覆盖 */

export interface WebForm { enabled: boolean; provider: string; base_url: string; api_key: string }

const normalize = (url: string) => url.trim().replace(/\/+$/, '')

export function initialWebForm(view: WebSettingsView): WebForm {
  return { enabled: view.enabled, provider: view.saved?.provider ?? 'searxng', base_url: view.saved?.base_url ?? '', api_key: '' }
}

/** 当前表单实际会请求的接口地址 */
export function webFormEndpoint(form: WebForm, view: WebSettingsView): string {
  return normalize(form.base_url || view.providers.find((p) => p.id === form.provider)?.base_url || '')
}

/** 已保存的 key 只在接口地址不变时沿用，与服务端规则一致 */
export function webKeyPlaceholder(form: WebForm, view: WebSettingsView): string {
  const p = view.providers.find((x) => x.id === form.provider)
  const endpoint = webFormEndpoint(form, view)
  if (view.saved?.has_key && endpoint && view.saved.endpoint && endpoint === normalize(view.saved.endpoint)) return '已保存，留空保持不变'
  if (view.saved?.has_key) return '接口地址已变，需要重新填写'
  if (p?.key_env && !form.base_url) return `粘贴 API key（留空则读取环境变量 ${p.key_env}）`
  return '粘贴 API key'
}

/** 发给服务端的内容：空 key、空地址不发送 */
export function webFormBody(form: WebForm): Record<string, string | boolean> {
  const body: Record<string, string | boolean> = { enabled: form.enabled, provider: form.provider }
  for (const field of ['base_url', 'api_key'] as const) {
    const value = form[field].trim()
    if (value) body[field] = value
  }
  return body
}
