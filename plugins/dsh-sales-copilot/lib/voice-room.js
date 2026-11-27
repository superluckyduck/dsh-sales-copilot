/**
 * Hands-free voice roleplay room.
 *
 * The one-shot `/meeting/voice-turn` hijacked dsh-live-captions, waited up to
 * 20s inside a single HTTP request, captured one line and always filed it as
 * the salesperson. This module replaces that with a real *conversation*:
 *
 *   - one background loop streams finalized mic lines from live-captions,
 *   - each user line is filed as sales or customer according to the meeting
 *     mode (the missing half of "我扮客户": there the AI is the salesperson),
 *   - the AI replies with the matching in-character turn (customer or seller),
 *   - the reply is spoken aloud with the existing Windows SAPI TTS engine,
 *   - the UI polls /voice-room/state and shows live transcripts + status.
 *
 * Only dsh-live-captions touches audio capture/ASR; we temporarily switch its
 * source to mic, start it, and restore the previous source/language on stop.
 */

const POLL_MS = 700
const MIN_LINE_LENGTH = 2

/** Detect the language of a recognised line: Latin script → en, CJK → zh. */
function detectLanguage(text) {
  const value = String(text ?? '')
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length
  const latin = (value.match(/[a-zA-Z]/g) ?? []).length
  if (cjk === 0 && latin >= 2) return 'en'
  if (latin === 0 && cjk >= 1) return 'zh'
  // Mixed line: whichever script dominates.
  return latin > cjk * 2 ? 'en' : 'zh'
}

export function createVoiceRoom({ store, meetingRunner, llm, tts, log, captionsGet, captionsPost, speakText }) {
  /** @type {{ meetingId: string, mode: string, speaker: string, language: string, since: number, deadline: number, seen: Set<number>, previous: object, busy: boolean, lastError: string|null, lastHeard: string, lastReply: string, turns: number, startedAt: string } | null} */
  let session = null
  let timer = null

  function state() {
    if (session === null) {
      return { running: false, supported: true, meetingId: '', heard: '', reply: '', error: null, turns: 0, busy: false, tts: typeof tts?.state === 'function' ? tts.state() : null }
    }
    return {
      running: true,
      supported: true,
      meetingId: session.meetingId,
      speaker: session.speaker,
      mode: session.mode,
      heard: session.lastHeard,
      reply: session.lastReply,
      replyLanguage: session.replyLanguage,
      language: session.pinnedLanguage,
      error: session.lastError,
      busy: session.busy,
      turns: session.turns,
      since: session.since,
      startedAt: session.startedAt,
      tts: typeof tts?.state === 'function' ? tts.state() : null,
    }
  }

  async function captureStatus() {
    const snapshot = (await captionsGet('/state?since=0')).state
    return String(snapshot?.status ?? 'idle')
  }

  async function start({ meeting, durationMs = 600000, language = 'auto' } = {}) {
    if (session !== null) return { ok: true, already: true, state: state() }
    if (meeting === null || typeof meeting?.id !== 'string') return { ok: false, error: '对练不存在' }

    let status = 'idle'
    try {
      status = await captureStatus()
    } catch (failure) {
      return { ok: false, error: `取不到字幕状态：${failure?.message ?? failure}` }
    }
    if (status !== 'idle') {
      return { ok: false, error: '实时字幕正在运行；语音对练需要独占麦克风，请先停止「实时」辅助再试' }
    }

    const snapshot = (await captionsGet('/state?since=0')).state
    const previous = {
      source: snapshot?.settings?.source ?? 'speaker',
      sourceLanguage: snapshot?.settings?.sourceLanguage ?? 'auto',
      translate: snapshot?.settings?.translate ?? true,
    }
    // A pinned language makes SenseVoice far more accurate on short lines;
    // in auto mode we let ASR detect it and detect the reply language per line.
    const pinnedLanguage = language === 'en' || language === 'zh' ? language : 'auto'
    const asrLanguage = pinnedLanguage === 'auto' ? 'auto' : pinnedLanguage
    const mode = meeting.mode
    const speaker = mode === 'user-customer' ? 'customer' : 'sales'
    session = {
      meetingId: meeting.id,
      mode,
      speaker,
      pinnedLanguage,
      language: asrLanguage,
      since: 0,
      deadline: Date.now() + Math.min(Math.max(Number(durationMs) || 600000, 60000), 3600000),
      seen: new Set(),
      previous,
      busy: false,
      lastError: null,
      lastHeard: '',
      lastReply: '',
      replyLanguage: '',
      turns: 0,
      startedAt: new Date().toISOString(),
    }

    try {
      // Mic-only, pinned language, and NO machine translation: the local
      // translate bridge was failing on every line, and the raw ASR text is
      // what the roleplay needs anyway.
      await captionsPost({
        action: 'settings',
        settings: { source: 'mic', sourceLanguage: asrLanguage, translate: false },
      })
      await captionsPost({ action: 'start' })
    } catch (failure) {
      const error = `开启麦克风失败：${failure?.message ?? failure}`
      log(`voice-room: ${error}`)
      session.lastError = error
      await stop({ silent: true })
      return { ok: false, error }
    }

    // Start the "since" marker at the current seq so a stale caption line from
    // before this session is never treated as the user's first utterance.
    try {
      const fresh = (await captionsGet('/state?since=0')).state
      const entries = Array.isArray(fresh?.entries) ? fresh.entries : []
      session.since = entries.reduce((max, entry) => Math.max(max, Number(entry?.seq) || 0), 0)
    } catch {
      // Non-fatal: the loop's dedup Set still prevents repeats.
    }

    schedule()
    log(`voice-room: started meeting=${meeting.id} mode=${mode} user=${speaker}`)
    return { ok: true, state: state() }
  }

  function schedule() {
    if (timer !== null) clearInterval(timer)
    timer = setInterval(() => {
      void tick().catch((error) => {
        if (session !== null) session.lastError = error?.message ?? String(error)
      })
    }, POLL_MS)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  async function tick() {
    const current = session
    if (current === null) return
    if (Date.now() > current.deadline) {
      log('voice-room: session timed out')
      await stop()
      return
    }
    if (current.busy) return

    let snapshot
    try {
      snapshot = (await captionsGet(`/state?since=${current.since}`)).state
    } catch (failure) {
      current.lastError = `字幕读取失败：${failure?.message ?? failure}`
      return
    }
    const status = String(snapshot?.status ?? 'idle')
    if (status === 'idle' || status === 'stopped' || status === 'error') {
      current.lastError = status === 'error' ? '语音识别出错，字幕已停止' : null
      await stop()
      return
    }

    const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
    const final = entries.find((entry) => {
      const seq = Number(entry?.seq)
      return entry?.draft !== true
        && Number.isFinite(seq)
        && seq > current.since
        && !current.seen.has(seq)
        && String(entry?.text ?? '').trim().length >= MIN_LINE_LENGTH
    })
    if (final === undefined) return

    const seq = Number(final.seq)
    current.since = seq
    current.seen.add(seq)
    const text = String(final.text).trim()
    current.lastHeard = text
    current.busy = true
    current.lastError = null
    try {
      await handleLine(current, text)
    } catch (failure) {
      current.lastError = failure?.message ?? String(failure)
      log(`voice-room: turn failed: ${current.lastError}`)
    } finally {
      current.busy = false
    }
  }

  async function handleLine(current, text) {
    const meeting = store.getMeeting(current.meetingId)
    if (meeting === null) {
      await stop()
      return
    }
    // File the user's utterance under the role they are actually playing.
    const added = store.addMessage(meeting.id, {
      speaker: current.speaker,
      text,
      name: current.speaker === 'customer' ? '我（语音·客户）' : '我（语音·销售）',
    })
    let fresh = added.meeting
    current.turns += 1

    // Reply in the language the user actually spoke. In auto mode this is
    // detected from each line; a pinned zh/en setting still wins.
    const spokenLang = detectLanguage(text)
    const replyLang = current.pinnedLanguage === 'auto' ? spokenLang : current.pinnedLanguage
    current.replyLanguage = replyLang

    // The AI plays the opposite side: salesperson when the user plays customer,
    // customer when the user plays sales.
    const turn = current.mode === 'user-customer'
      ? await meetingRunner.salesTurn({ meeting: fresh, language: replyLang })
      : await meetingRunner.customerTurn({ meeting: fresh, language: replyLang })
    const replySpeaker = current.mode === 'user-customer' ? 'sales' : 'customer'
    const result = store.addMessage(fresh.id, {
      speaker: replySpeaker,
      text: turn.text,
      name: replySpeaker === 'sales' ? 'AI 销售' : turn.role?.name ?? '客户',
    })
    fresh = result.meeting
    current.lastReply = turn.text
    if (typeof speakText === 'function') {
      // Speak the reply in the language it was actually written in.
      const english = replyLang === 'en' || (replySpeaker === 'customer' && turn.role?.language === 'en')
      const voiceLang = english ? 'en' : 'zh'
      void speakText(turn.text, voiceLang).catch((failure) => {
        current.lastError = `朗读失败：${failure?.message ?? failure}`
      })
    }
    log(`voice-room: turn ${current.turns} heard="${text.slice(0, 40)}" replied="${turn.text.slice(0, 40)}"`)
  }

  async function stop({ silent = false } = {}) {
    const current = session
    if (current === null) return { ok: true, state: state() }
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    session = null
    try {
      await captionsPost({ action: 'stop' })
    } catch (failure) {
      if (!silent) log(`voice-room: stop capture failed: ${failure?.message ?? failure}`)
    }
    try {
      await captionsPost({ action: 'settings', settings: current.previous })
    } catch (failure) {
      log(`voice-room: restoring settings failed: ${failure?.message ?? failure}`)
    }
    log(`voice-room: stopped after ${current.turns} turns`)
    return { ok: true, state: state() }
  }

  return { start, stop, state }
}
