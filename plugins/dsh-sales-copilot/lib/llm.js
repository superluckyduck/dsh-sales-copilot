/**
 * Thin wrapper over the host's `llm` service. DSH already knows which provider
 * and model the user picked, so this never hardcodes a vendor: it asks
 * `agentDefaultModel.currentSelection()` for the active route and streams
 * through `llm.stream()`.
 */

export function createLlm(ctx, log) {
  function selection() {
    try {
      const owner = ctx.get('agentDefaultModel')
      const picked = typeof owner?.currentSelection === 'function' ? owner.currentSelection() : null
      if (picked && typeof picked.provider === 'string' && typeof picked.model === 'string') return picked
      return null
    } catch (error) {
      log(`llm: cannot resolve the active model: ${error?.message ?? error}`)
      return null
    }
  }

  function available() {
    try {
      return ctx.get('llm') !== undefined && selection() !== null
    } catch {
      return false
    }
  }

  function describe() {
    const picked = selection()
    if (picked === null) return { available: false, provider: null, model: null }
    return { available: true, provider: picked.provider, model: picked.model }
  }

  /**
   * One-shot completion. Returns the concatenated text; throws with a readable
   * message on error so HTTP callers can surface it in the panel.
   */
  async function ask({ system, prompt, maxTokens = 800, temperature = 0.4, timeoutMs = 45000, signal } = {}) {
    const picked = selection()
    if (picked === null) throw new Error('DSH 里还没有选好模型，先在对话里选一个再试')
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('宿主没有提供 llm 服务')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const abort = () => controller.abort()
    if (signal) signal.addEventListener('abort', abort, { once: true })

    let text = ''
    try {
      const stream = llm.stream({
        provider: picked.provider,
        model: picked.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature,
        maxTokens,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
        } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason.failure?.message ?? '模型返回错误')
        }
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('模型调用超时或已取消')
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }

    const trimmed = text.trim()
    if (trimmed === '') throw new Error('模型返回了空内容')
    return trimmed
  }

  /** Parse a JSON object/array out of a model reply that may be fenced or chatty. */
  function parseJson(text) {
    const cleaned = String(text ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/```(?:json)?/gi, '')
      .trim()
    const objStart = cleaned.indexOf('{')
    const arrStart = cleaned.indexOf('[')
    const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart)
    const start = useArray ? arrStart : objStart
    const end = useArray ? cleaned.lastIndexOf(']') : cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
    return JSON.parse(cleaned.slice(start, end + 1))
  }

  return { available, selection, describe, ask, parseJson }
}
