/**
 * Model calls for subtitles and meeting minutes.
 *
 * Translation can run on the profile's cloud model (the `llm` service) or on a
 * local OpenAI-compatible server the user points at. Meeting minutes always use
 * the cloud model, so the summary keeps its quality and length budget.
 */

const LANGUAGE_NAMES = {
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  yue: '粤语',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ru: 'Русский',
  pt: 'Português',
}

export function languageName(id) {
  return LANGUAGE_NAMES[id] ?? id
}

/**
 * Talk to an OpenAI-compatible `/chat/completions` endpoint with token
 * streaming, so a local model (Ollama, LM Studio, vLLM…) can drive subtitles
 * without sending text off the machine.
 */
async function streamLocal({ baseUrl, model, apiKey, system, prompt, maxTokens, temperature, signal, onDelta }) {
  if (model === '') throw new Error('本地模型还没填写模型名')
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
  const headers = { 'content-type': 'application/json' }
  if (apiKey !== '') headers.authorization = `Bearer ${apiKey}`

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: true,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
      signal,
    })
  } catch (error) {
    throw new Error(`连不上本地模型（${endpoint}），请确认服务已启动：${error.message}`)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`本地模型返回 ${response.status}：${detail.slice(0, 200)}`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    // A server that ignores stream:true answers with one JSON body.
    const payload = await response.json().catch(() => null)
    const text = payload?.choices?.[0]?.message?.content ?? ''
    if (text !== '') onDelta?.(text)
    return String(text)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '' || data === '[DONE]') continue
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }
      const delta = parsed?.choices?.[0]?.delta?.content ?? ''
      if (delta !== '') {
        full += delta
        onDelta?.(full)
      }
    }
  }
  return full
}

export function createLlm({ ctx, config, log, settings, mt }) {
  /** The cloud route the user pinned for subtitles, when both halves are set. */
  function pinnedRoute() {
    const current = settings?.() ?? {}
    if (typeof current.cloudProvider === 'string' && current.cloudProvider !== ''
      && typeof current.cloudModel === 'string' && current.cloudModel !== '') {
      return { provider: current.cloudProvider, model: current.cloudModel }
    }
    return null
  }

  function selection() {
    const pinned = pinnedRoute()
    if (pinned !== null) return pinned
    const owner = ctx.get('agentDefaultModel')
    if (owner !== undefined) {
      try {
        const current = owner.currentSelection()
        if (current?.provider && current?.model) return current
      } catch (error) {
        log(`llm: default selection unavailable: ${error.message}`)
      }
    }
    if (config.provider && config.model) return { provider: config.provider, model: config.model }
    throw new Error('没有可用的模型路由，请先在模型设置里选择默认模型。')
  }

  /** The engine the user picked for subtitle translation. */
  function engineFor() {
    const current = settings?.() ?? {}
    if (current.translateEngine === 'builtin') return { kind: 'builtin' }
    if (current.translateEngine === 'local') {
      return {
        kind: 'local',
        baseUrl: current.localBaseUrl || 'http://127.0.0.1:11434/v1',
        model: current.localModel || '',
        apiKey: current.localApiKey || '',
      }
    }
    return { kind: 'cloud', ...(pinnedRoute() ?? {}) }
  }

  /** Resolved translation route for status display. */
  function describeEngine() {
    const engine = engineFor()
    if (engine.kind === 'builtin') {
      const status = mt?.describe() ?? { state: 'idle', model: 'm2m100_418M' }
      const suffix = status.state === 'ready' ? '' : status.state === 'loading' ? '（准备中）' : '（未加载）'
      return { kind: 'builtin', label: `离线模型 · ${status.label ?? status.model}${suffix}`, model: status.model, state: status.state }
    }
    if (engine.kind === 'local') {
      return {
        kind: 'local',
        label: engine.model === '' ? '本地推理服务（未填写模型名）' : `本地推理服务 · ${engine.model}`,
        baseUrl: engine.baseUrl,
        model: engine.model,
      }
    }
    if (engine.model !== undefined) {
      return { kind: 'cloud', label: `云端大模型 · ${engine.model}`, model: engine.model, provider: engine.provider, pinned: true }
    }
    try {
      const route = selection()
      return { kind: 'cloud', label: `云端大模型 · ${route.model}（跟随默认）`, model: route.model, provider: route.provider, pinned: false }
    } catch (error) {
      return { kind: 'cloud', label: `云端大模型（${error.message}）`, model: null }
    }
  }

  /**
   * Every cloud route this profile can actually call, for the model picker.
   * Providers that fail to list are reported instead of aborting the whole list.
   */
  async function listCloudModels() {
    const llm = ctx.get('llm')
    if (llm === undefined) return { providers: [], error: '模型服务未加载' }
    let providers = []
    try {
      providers = llm.listProviders()
    } catch (error) {
      return { providers: [], error: String(error?.message ?? error) }
    }
    const rows = []
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id)
        rows.push({
          id: provider.id,
          name: provider.name ?? provider.id,
          models: (models ?? []).map((model) => ({ id: model.id, name: model.name ?? model.id })),
        })
      } catch (error) {
        log(`llm: listModels(${provider.id}) failed: ${error.message}`)
        rows.push({ id: provider.id, name: provider.name ?? provider.id, models: [], error: String(error?.message ?? error) })
      }
    }
    return { providers: rows, error: null }
  }

  /**
   * One non-streaming model call assembled from the text deltas.
   * @param {{system?: string, prompt: string, maxTokens?: number, temperature?: number, signal?: AbortSignal}} request
   */
  async function complete({ system, prompt, maxTokens = 1600, temperature = 0.2, signal }) {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('模型服务未加载')
    const route = selection()
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    let text = ''
    let failure = null
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages,
      temperature,
      maxTokens,
      signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        failure = chunk.reason.failure
      }
    }
    if (failure !== null && failure !== undefined) {
      throw new Error(failure.message || '模型调用失败')
    }
    return text.trim()
  }

  /**
   * Translate a batch of transcript lines, preserving the `[n]` markers.
   * @param {Array<{seq:number, text:string}>} entries
   * @param {string} targetLanguage
   * @param {{context?: string, signal?: AbortSignal}} options
   * @returns {Promise<Map<number, string>>}
   */
  async function translate(entries, targetLanguage, { context = '', signal } = {}) {
    if (entries.length === 0) return new Map()
    if (engineFor().kind !== 'cloud') {
      // Local engines answer one sentence at a time; the batch marker protocol
      // buys nothing there.
      const result = new Map()
      for (const entry of entries.slice(0, 8)) {
        try {
          const value = await translateOne(entry.text, targetLanguage, { context, signal })
          if (value !== '') result.set(entry.seq, value)
        } catch {
          // left missing on purpose: the caller shows the failure
        }
      }
      return result
    }
    const target = languageName(targetLanguage)
    const body = entries.map((entry) => `[${entry.seq}] ${entry.text}`).join('\n')
    const contextBlock = context ? `\n前文（仅供理解，不要翻译）：\n${context}\n` : ''
    const prompt = [
      `把下面每一行会议发言翻译成${target}。`,
      '要求：保留行首的 [数字] 标记；每行输出一条译文；不要合并或拆分条目；只输出译文，不要解释。',
      contextBlock,
      '待翻译：',
      body,
    ].join('\n')

    const output = await complete({
      system: `你是实时会议字幕翻译引擎，只输出译文，目标语言是${target}。`,
      prompt,
      maxTokens: Math.min(2000, 120 + entries.length * 90),
      temperature: 0.1,
      signal,
    })

    const result = new Map()
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*(?:[-*]\s*)?\[(\d+)\]\s*(.*)$/.exec(line)
      if (match === null) continue
      const seq = Number(match[1])
      const text = match[2].trim()
      if (text !== '') result.set(seq, text)
    }
    if (result.size === 0 && entries.length === 1) {
      const only = output.replace(/^\s*(?:[-*]\s*)?\[\d+\]\s*/, '').trim()
      if (only !== '') result.set(entries[0].seq, only)
    }
    // A batch reply can drop a marker; translate the missing lines one by one
    // so one unparsed line never leaves a subtitle permanently untranslated.
    const missing = entries.filter((entry) => !result.has(entry.seq)).slice(0, 3)
    for (const entry of missing) {
      try {
        const single = await complete({
          system: `你是实时会议字幕翻译引擎，只输出${target}译文。`,
          prompt: `把下面这句话翻译成${target}，只输出译文，不要编号、不要解释：\n${entry.text}`,
          maxTokens: 320,
          temperature: 0.1,
          signal,
        })
        const clean = single.replace(/^\s*(?:[-*]\s*)?\[\d+\]\s*/, '').trim()
        if (clean !== '') result.set(entry.seq, clean)
      } catch {
        // keep it missing: the caller marks it as failed and shows the reason
      }
    }
    return result
  }

  /**
   * Translate several lines in ONE streamed call and hand each line over as soon
   * as its `[n]` marker completes, so a backlog of subtitles no longer costs one
   * round trip per line. Cloud only: the local engines answer one at a time.
   *
   * @param {Array<{seq:number, text:string}>} entries
   * @param {string} targetLanguage
   * @param {{context?: string, signal?: AbortSignal, onLine?: (seq: number, text: string) => void}} options
   * @returns {Promise<Map<number, string>>}
   */
  async function translateStreaming(entries, targetLanguage, { context = '', signal, onLine } = {}) {
    if (entries.length === 0) return new Map()
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('模型服务未加载')
    const route = selection()
    const target = languageName(targetLanguage)
    const body = entries.map((entry) => `[${entry.seq}] ${entry.text}`).join('\n')
    const contextBlock = context ? `\n前文（仅供理解，不要翻译）：\n${context}\n` : ''
    const prompt = [
      `把下面每一行会议发言翻译成${target}。`,
      '要求：保留行首的 [数字] 标记；每行输出一条译文；不要合并或拆分条目；只输出译文，不要解释。',
      contextBlock,
      '待翻译：',
      body,
    ].join('\n')
    const wanted = new Set(entries.map((entry) => entry.seq))
    const result = new Map()
    const emit = (line) => {
      const match = /^\s*(?:[-*]\s*)?\[(\d+)\]\s*(.*)$/.exec(line)
      if (match === null) return
      const seq = Number(match[1])
      const text = match[2].trim()
      if (text === '' || result.has(seq) || !wanted.has(seq)) return
      result.set(seq, text)
      onLine?.(seq, text)
    }

    let raw = ''
    let consumed = 0
    let failure = null
    const drain = (final) => {
      let index
      while ((index = raw.indexOf('\n', consumed)) >= 0) {
        emit(raw.slice(consumed, index))
        consumed = index + 1
      }
      if (final && consumed < raw.length) {
        emit(raw.slice(consumed))
        consumed = raw.length
      }
    }

    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system: `你是实时会议字幕翻译引擎，只输出译文，目标语言是${target}。`,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: 0.1,
      maxTokens: Math.min(2000, 120 + entries.length * 90),
      signal,
    })) {
      if (chunk.type === 'text-delta') {
        raw += chunk.text
        drain(false)
      } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        failure = chunk.reason.failure
      }
    }
    drain(true)
    if (failure !== null && failure !== undefined && result.size === 0) {
      throw new Error(failure.message || '模型调用失败')
    }
    return result
  }

  /**
   * Stream one line's translation so the caption can update while tokens
   * arrive, instead of waiting for the complete sentence.
   * @param {string} text
   * @param {string} targetLanguage
   * @param {{context?: string, onDelta?: (partial: string) => void, signal?: AbortSignal}} options
   * @returns {Promise<string>}
   */
  async function translateOne(text, targetLanguage, { context = '', onDelta, signal } = {}) {
    const target = languageName(targetLanguage)
    const system = `你是实时会议字幕翻译引擎。只输出${target}译文，不加序号、不加引号、不解释。`
    const prompt = context
      ? `上文（仅供理解，不要翻译）：${context}\n\n把下面这句话翻译成${target}：\n${text}`
      : `把下面这句话翻译成${target}：\n${text}`

    const engine = engineFor()
    if (engine.kind === 'builtin') {
      if (mt === undefined) throw new Error('内置翻译模型不可用')
      const translated = await mt.translate(text, {
        sourceLanguage: settings?.()?.sourceLanguage,
        targetLanguage,
      })
      const clean = cleanTranslation(translated)
      if (clean !== '') onDelta?.(clean)
      return clean
    }
    if (engine.kind === 'local') {
      const raw = await streamLocal({
        baseUrl: engine.baseUrl,
        model: engine.model,
        apiKey: engine.apiKey,
        system,
        prompt,
        maxTokens: 320,
        temperature: 0.1,
        signal,
        onDelta: (accumulated) => {
          const visible = cleanTranslation(accumulated)
          if (visible !== '') onDelta?.(visible)
        },
      })
      return cleanTranslation(raw)
    }

    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('模型服务未加载')
    const route = selection()
    let raw = ''
    let failure = null
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: 0.1,
      maxTokens: 320,
      signal,
    })) {
      if (chunk.type === 'text-delta') {
        raw += chunk.text
        const visible = cleanTranslation(raw)
        if (visible !== '') onDelta?.(visible)
      } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        failure = chunk.reason.failure
      }
    }
    if (failure !== null && failure !== undefined) throw new Error(failure.message || '模型调用失败')
    return cleanTranslation(raw)
  }

  const MINUTES_SYSTEM = [
    '你是会议纪要助手。你拿到的是会议中的语音转写片段，可能包含识别错误、口语重复和无关寒暄。',
    '请输出结构化的中文 Markdown 会议纪要，不要编造转写里没有的事实；无法确定的信息标注“待确认”。',
    '结构固定为：## 会议概要 / ## 主要议题 / ## 关键结论 / ## 待办事项 / ## 风险与待确认。',
    '待办事项用表格（负责人 | 事项 | 截止时间），没有明确负责人或时间就写“待确认”。',
  ].join('\n')

  /** Summarise one transcript chunk (map step). */
  async function summarizeChunk(text, index, total, signal) {
    return complete({
      system: MINUTES_SYSTEM,
      prompt: `这是会议转写的第 ${index}/${total} 部分，请提炼事实要点（时间、人物、数字、决定、待办）。\n\n${text}`,
      maxTokens: 900,
      temperature: 0.2,
      signal,
    })
  }

  /**
   * Reduce a transcript to a structured minutes document.
   * @param {string} transcript
   * @param {{signal?: AbortSignal, title?: string}} options
   */
  async function minutes(transcript, { signal, title } = {}) {
    const text = transcript.trim()
    if (text === '') throw new Error('还没有可总结的转写内容。')
    const chunkSize = 9000
    let material = text
    if (text.length > chunkSize) {
      const chunks = []
      for (let offset = 0; offset < text.length; offset += chunkSize) {
        chunks.push(text.slice(offset, offset + chunkSize))
      }
      const parts = []
      for (let index = 0; index < chunks.length; index += 1) {
        parts.push(await summarizeChunk(chunks[index], index + 1, chunks.length, signal))
      }
      material = parts.join('\n\n')
    }
    const heading = title ? `会议标题（用户提供）：${title}\n` : ''
    return complete({
      system: MINUTES_SYSTEM,
      prompt: `${heading}根据以下会议材料写出完整纪要：\n\n${material}`,
      maxTokens: 2200,
      temperature: 0.3,
      signal,
    })
  }

  return {
    complete, translate, translateOne, translateStreaming, minutes, selection, describeEngine,
    listCloudModels, engineKind: () => engineFor().kind,
  }

}

/** Strip numbering, lead-ins and wrapping quotes a model may add. */
export function cleanTranslation(value) {
  let text = String(value ?? '')
  text = text.replace(/^\s*(?:[-*]\s*)?\[\d+\]\s*/, '')
  text = text.replace(/^\s*(?:译文|翻译|translation)\s*[:：]\s*/i, '')
  const quoted = /^["“「']([\s\S]*)["”」']$/.exec(text.trim())
  if (quoted !== null) text = quoted[1]
  return text.trim()
}
