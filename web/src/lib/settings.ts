import type { ProviderInfo, SettingsView } from './types.ts'

/** 模型设置表单的纯逻辑，不依赖 DOM，Node 测试直接覆盖 */

export interface SettingsForm { provider: string; region: 'cn' | 'global'; base_url: string; model: string; api_key: string }

const normalize = (url: string) => url.trim().replace(/\/+$/, '')

export function initialForm(view: SettingsView): SettingsForm {
  const s = view.saved
  return { provider: s?.provider ?? '', region: s?.region ?? 'cn', base_url: s?.base_url ?? '', model: s?.model ?? '', api_key: '' }
}

export function defaultEndpoint(p: ProviderInfo | undefined, region: 'cn' | 'global'): string {
  if (!p?.base_url) return ''
  return typeof p.base_url === 'string' ? p.base_url : p.base_url[region]
}

/** 当前表单实际会请求的接口地址 */
export function formEndpoint(form: SettingsForm, providers: ProviderInfo[]): string {
  return normalize(form.base_url || defaultEndpoint(providers.find((p) => p.id === form.provider), form.region))
}

/** 已保存的 key 只在接口地址不变时沿用，和服务端规则一致 */
export function keepsSavedKey(form: SettingsForm, view: SettingsView): boolean {
  return !!view.saved?.has_key && !!view.saved.endpoint && formEndpoint(form, view.providers) === normalize(view.saved.endpoint)
}

export function keyPlaceholder(form: SettingsForm, view: SettingsView): string {
  const p = view.providers.find((x) => x.id === form.provider)
  if (keepsSavedKey(form, view)) return '已保存，留空保持不变'
  if (view.saved?.has_key) return '接口地址已变，需要重新填写'
  if (p?.key_env && !form.base_url) return `粘贴 API key（留空则读取环境变量 ${p.key_env}）`
  return p?.key === 'optional' ? '没有可以留空' : '粘贴 API key'
}

/** 发给服务端的内容：空 key 不发送，表示沿用 */
export function formBody(form: SettingsForm): Record<string, string> {
  const body: Record<string, string> = { provider: form.provider, region: form.region }
  for (const field of ['base_url', 'model', 'api_key'] as const) {
    const value = form[field].trim()
    if (value) body[field] = value
  }
  return body
}
