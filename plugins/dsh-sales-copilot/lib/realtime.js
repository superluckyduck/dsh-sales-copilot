/**
 * Real-time assist bridge.
 *
 * Rather than reimplementing audio capture, this rides on the already-installed
 * `dsh-live-captions` plugin: its HTTP API exposes `GET /state?since=<seq>`
 * which returns incrementally recognised lines together with their machine
 * translation. Every finished line is matched against the local FAQ index and
 * turned into a three-line answer card (客户原话 / 中文要点 / 照读英文).
 *
 * Nothing here needs a model; the LLM path is opt-in (`aiAssist`) and only
 * fills in when the FAQ library misses or the user asks for a polished answer.
 */

const TICK_MS = 1000
const MAX_ITEMS = 40
const MATCH_THRESHOLD = 0.34

export function createRealtime({ store, llm, log, getOrigin }) {
  let timer = null
  let since = 0
  let items = []
  let captionState = 'idle'
  let lastError = null
  let aiAssist = false
  let aiInFlight = 0
  let lastPollAt = null
  let polls = 0
  let lastAiError = null
  let prevState = 'idle'
  let sessionId = ''
  let callEnded = null
  let startedByUs = false

  function endCall(reason) {
    if (items.length === 0 || callEnded !== null) return
    callEnded = { sessionId, entries: items.length, at: new Date().toISOString(), reason }
  }

  function running() {
    return timer !== null
  }

  function originOk() {
    const origin = typeof getOrigin === 'function' ? getOrigin() : null
    if (typeof origin !== 'string' || origin === '') return null
    return origin.replace(/\/$/, '')
  }

  function buildCard(entry) {
    const heard = String(entry.text ?? '').trim()
    const matches = store.search(heard, 3)
    const top = matches[0] ?? null
    const usable = top !== null && top.confidence >= MATCH_THRESHOLD
    return {
      seq: Number(entry.seq) || 0,
      at: typeof entry.at === 'string' ? entry.at : '',
      heard,
      translation: typeof entry.translation === 'string' ? entry.translation : '',
      matched: usable,
      faq: usable
        ? {
            id: top.id,
            question: top.question,
            zh: top.answer,
            en: top.answerEn || top.answer,
            confidence: top.confidence,
            verdict: top.verdict,
          }
        : null,
      alternatives: matches.slice(1, 3).map((item) => ({ id: item.id, question: item.question, confidence: item.confidence })),
      ai: null,
      aiState: 'off',
    }
  }

  async function aiAnswer(card) {
    if (!llm.available()) {
      card.aiState = 'unavailable'
      return
    }
    aiInFlight += 1
    card.aiState = 'pending'
    try {
      const raw = await llm.ask({
        system:
          '你是一名 B2B SaaS 销售助手，产品是智仓 WMS（仓储管理系统）。回答要口语、简短、可直接照着念。只输出 JSON。',
        prompt: [
          '客户刚说了这句话：',
          `"${card.heard}"`,
          card.translation ? `机器翻译参考：${card.translation}` : '',
          card.faq ? `我们的高频问答库里有类似答案：${card.faq.zh}` : '',
          '',
          '请输出 JSON：{"zh":"中文要点，不超过 30 字","en":"可以直接照着说的英文，不超过 25 个单词，自然口语"}',
          '不要输出 JSON 以外的任何文字。',
        ]
          .filter(Boolean)
          .join('\n'),
        maxTokens: 220,
        temperature: 0.3,
        timeoutMs: 25000,
      })
      const parsed = llm.parseJson(raw)
      card.ai = {
        zh: typeof parsed.zh === 'string' ? parsed.zh.trim() : '',
        en: typeof parsed.en === 'string' ? parsed.en.trim() : '',
      }
      card.aiState = card.ai.zh === '' && card.ai.en === '' ? 'empty' : 'done'
      lastAiError = null
    } catch (error) {
      card.aiState = 'error'
      lastAiError = error?.message ?? String(error)
      log(`realtime: ai answer failed: ${lastAiError}`)
    } finally {
      aiInFlight -= 1
    }
  }

  function ingest(entry) {
    if (entry === null || typeof entry !== 'object') return
    const seq = Number(entry.seq)
    if (!Number.isFinite(seq) || seq <= since) return
    if (entry.draft === true) return
    if (typeof entry.text !== 'string' || entry.text.trim() === '') return
    since = seq
    const card = buildCard(entry)
    items.push(card)
    if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS)
    if (aiAssist) void aiAnswer(card)
  }

  async function tick() {
    const origin = originOk()
    if (origin === null) {
      lastError = '宿主 Web 服务地址不可用'
      return
    }
    const response = await fetch(`${origin}/live-captions/api/state?since=${since}`, {
      headers: { accept: 'application/json' },
    })
    if (response.status === 404) {
      lastError = '没有安装 dsh-live-captions，实时辅助取不到字幕'
      stop()
      return
    }
    if (!response.ok) throw new Error(`live-captions 返回 ${response.status}`)
    const payload = await response.json()
    const snapshot = payload?.state ?? {}
    const nextState = String(snapshot.status ?? 'unknown')
    if (typeof snapshot.session?.id === 'string' && snapshot.session.id !== '') sessionId = snapshot.session.id
    const wasListening = prevState === 'running' || prevState === 'listening' || prevState === 'recording'
    if (wasListening && (nextState === 'idle' || nextState === 'stopped' || nextState === 'error')) endCall('captions-stopped')
    prevState = nextState
    captionState = nextState
    for (const entry of snapshot.entries ?? []) ingest(entry)
    lastPollAt = new Date().toISOString()
    polls += 1
    lastError = null
  }

  /** Make sure dsh-live-captions is actually listening before we poll it. */
  async function ensureCaptions() {
    const origin = originOk()
    if (origin === null) return
    try {
      const statusResponse = await fetch(`${origin}/live-captions/api/state`, { headers: { accept: 'application/json' } })
      if (statusResponse.status === 404) {
        lastError = '没有安装 dsh-live-captions，实时辅助取不到字幕'
        return
      }
      if (!statusResponse.ok) throw new Error(`live-captions 返回 ${statusResponse.status}`)
      const payload = await statusResponse.json()
      const status = String(payload?.state?.status ?? 'idle')
      if (status === 'running' || status === 'listening' || status === 'recording') return
      const startResponse = await fetch(`${origin}/live-captions/api/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      })
      if (!startResponse.ok) throw new Error(`启动字幕失败（HTTP ${startResponse.status}）`)
      startedByUs = true
      log('realtime: asked dsh-live-captions to start')
    } catch (error) {
      lastError = `启动实时字幕失败：${error?.message ?? error}`
      log(`realtime: ensureCaptions failed: ${lastError}`)
    }
  }

  function schedule() {
    timer = setInterval(() => {
      void tick().catch((error) => {
        lastError = error?.message ?? String(error)
        log(`realtime: poll failed: ${lastError}`)
      })
    }, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function start() {
    if (running()) return { ok: true, already: true }
    aiInFlight = 0
    void ensureCaptions()
    schedule()
    void tick().catch((error) => {
      lastError = error?.message ?? String(error)
    })
    log('realtime: started')
    return { ok: true }
  }

  /**
   * Stop polling. If we were the ones who started dsh-live-captions, stop the
   * capture too — otherwise the microphone/speaker capture keeps running and
   * "语音回答" can never get the mic back.
   */
  async function stop() {
    endCall('user-stopped')
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    let captionsStopped = false
    const origin = originOk()
    if (startedByUs && origin !== null) {
      try {
        const response = await fetch(`${origin}/live-captions/api/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
        })
        captionsStopped = response.ok
      } catch (error) {
        log(`realtime: stopping dsh-live-captions failed: ${error?.message ?? error}`)
      }
      startedByUs = false
    }
    log('realtime: stopped')
    return { ok: true, captionsStopped }
  }

  /** The user looked at the "call finished" prompt — stop asking. */
  function ack() {
    callEnded = null
    return { ok: true }
  }

  function setAi(enabled) {
    aiAssist = enabled === true
    return { ok: true, aiAssist }
  }

  function reset() {
    items = []
    since = 0
    lastError = null
    captionState = 'idle'
    prevState = 'idle'
    sessionId = ''
    callEnded = null
    return { ok: true }
  }

  function snapshot() {
    return {
      running: running(),
      captions: captionState,
      aiAssist,
      aiBusy: aiInFlight > 0,
      since,
      polls,
      lastPollAt,
      lastError,
      lastAiError,
      threshold: MATCH_THRESHOLD,
      items: items.slice(-30),
      callEnded,
      model: typeof llm.describe === 'function' ? llm.describe() : null,
    }
  }

  return { start, stop, setAi, reset, ack, snapshot, running }
}
