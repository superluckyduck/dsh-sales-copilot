/**
 * 免费翻译的 OpenAI 兼容外壳。
 *
 * 目的：让 dsh-live-captions 的「本地推理服务」翻译引擎直接吃 Google / Microsoft
 * 的免费通道，字幕翻译不再走云端大模型（零 token 花费）。
 *
 * live-captions 对 local 引擎的调用契约（见 dsh-live-captions/lib/llm.js:31-101、
 * 391-425）：
 *   POST {baseUrl}/chat/completions
 *   {model, stream:true, temperature:0.1, max_tokens:320,
 *    messages:[{role:'system',content:'你是实时会议字幕翻译引擎。只输出简体中文译文，不加序号...'},
 *              {role:'user',content:'把下面这句话翻译成简体中文：\n<原文>'}]}
 *   → SSE data:{choices:[{delta:{content}}]} … data:[DONE]
 * 批量（[n] 标记）与纪要提示词只走云端模型，local 引擎只发单句，所以这里只处理单句 +
 * 防御性处理批量格式。
 */

import http from 'node:http'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { translate, providerLabel } from './providers.mjs'
import { parsePrompt } from './prompt.mjs'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '127.0.0.1'
const MODEL = process.env.MODEL_NAME ?? 'free-google-microsoft'
const LOG_FILE = process.env.LOG_FILE ?? join(dirname(fileURLToPath(import.meta.url)), 'server.log')
const ORDER = (process.env.PROVIDER_ORDER ?? 'google,microsoft')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter((name) => name === 'google' || name === 'microsoft')

/**
 * 面板里的「模型名」还能当开关用：
 *   google-translate        → 只走谷歌
 *   microsoft-translator    → 只走微软（Bing）
 *   free-google-microsoft   → 按 PROVIDER_ORDER 顺序回退
 */
function orderFor(modelName) {
  const name = String(modelName ?? '').toLowerCase()
  const wantsGoogle = /google|谷歌/.test(name)
  const wantsMicrosoft = /microsoft|bing|微软/.test(name)
  if (wantsGoogle && !wantsMicrosoft) return ['google']
  if (wantsMicrosoft && !wantsGoogle) return ['microsoft']
  return ORDER
}

function log(...args) {
  const line = `[translate-free ${new Date().toISOString()}] ${args.join(' ')}\n`
  process.stderr.write(line)
  try {
    appendFileSync(LOG_FILE, line)
  } catch {
    // 日志写不进去不能拖累翻译
  }
}

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

function sseChunk(res, content, finish = null) {
  const payload = {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** 假流式：把译文切成几段吐，字幕能更早出字 */
async function streamText(res, text) {
  sseHeaders(res)
  const size = text.length > 24 ? Math.ceil(text.length / 3) : text.length
  for (let index = 0; index < text.length; index += size) {
    sseChunk(res, text.slice(index, index + size))
  }
  sseChunk(res, null, 'stop')
  res.write('data: [DONE]\n\n')
  res.end()
}

async function handleChat(body, res) {
  const request = JSON.parse(body)
  const messages = Array.isArray(request.messages) ? request.messages : []
  const parsed = parsePrompt(messages)

  if (parsed.kind === 'batch') {
    const results = []
    for (const line of parsed.lines.slice(0, 8)) {
      try {
        const one = await translate(line.text, parsed.target, { order: orderFor(request.model) })
        results.push(`[${line.seq}] ${one.text}`)
        log(`batch [${line.seq}] ${one.provider} ${one.ms}ms`)
      } catch (error) {
        log(`batch [${line.seq}] FAILED ${error.message}`)
      }
    }
    const text = results.join('\n')
    if (request.stream === true) return streamText(res, text)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      }),
    )
    return
  }

  if (parsed.text === '') {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { message: 'empty source text' } }))
    return
  }

  const started = Date.now()
  let result
  try {
    result = await translate(parsed.text, parsed.target, { order: orderFor(request.model) })
  } catch (error) {
    log(`single FAILED ${error.message}`)
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { message: error.message } }))
    return
  }
  log(
    `single ${providerLabel(result.provider)} ${result.ms}ms → ${parsed.target} ` +
      `"${parsed.text.slice(0, 28)}" ⇒ "${result.text.slice(0, 28)}"`,
  )

  if (request.stream === true) return streamText(res, result.text)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(
    JSON.stringify({
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [
        { index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      latency_ms: Date.now() - started,
    }),
  )
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`)

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        ok: true,
        model: MODEL,
        order: orderFor(MODEL),
        providers: ORDER.map((name) => providerLabel(name)),
      }),
    )
    return
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: MODEL, object: 'model', created: 0, owned_by: 'translate-free' },
          { id: 'google-translate', object: 'model', created: 0, owned_by: 'translate-free' },
          { id: 'microsoft-translator', object: 'model', created: 0, owned_by: 'translate-free' },
        ],
      }),
    )
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      handleChat(body, res).catch((error) => {
        log(`handler error ${error.message}`)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: error.message } }))
      })
    })
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }))
})

server.listen(PORT, HOST, () => {
  log(`listening http://${HOST}:${PORT}  model=${MODEL}  order=${ORDER.join(' → ')}`)
})
