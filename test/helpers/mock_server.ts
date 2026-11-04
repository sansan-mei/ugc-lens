import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: unknown
}

export type Handler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>

/** 本地 HTTP 服务，模拟 OpenAI 兼容接口，走真实的 fetch 网络路径 */
export async function startMockServer(handler: Handler) {
  const requests: RecordedRequest[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    const recorded: RecordedRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    }
    requests.push(recorded)
    await handler(recorded, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

export function completion(content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return {
    model: 'mock-model',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  }
}
