/**
 * Xiaomi MiMo TTS provider — natural neural voices delivered as base64 WAV.
 *
 * API: POST https://api.xiaomimimo.com/v1/chat/completions
 *   { model:'mimo-v2.5-tts',
 *     messages:[{role:'assistant', content:'<text to speak>'}],
 *     audio:{ voice:'冰糖'|'Mia', format:'wav' } }
 *   -> choices[0].message.audio.data = base64 WAV
 *
 * The API key is read from ~/.dsh/sales-copilot/tts-config.json (untracked),
 * or from env MIMO_API_KEY / XIAOMI_API_KEY — never from tracked source.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_PATH = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sales-copilot', 'tts-config.json')
const DEFAULT_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions'
const VOICES = { zh: '冰糖', en: 'Mia' }

function loadConfig() {
  let file = {}
  try {
    if (existsSync(CONFIG_PATH())) file = JSON.parse(readFileSync(CONFIG_PATH(), 'utf8'))
  } catch { /* ignore */ }
  const key = process.env.MIMO_API_KEY || process.env.XIAOMI_API_KEY || file.apiKey || ''
  if (key === '') return null
  return {
    key,
    endpoint: file.endpoint || DEFAULT_ENDPOINT,
    model: file.model || 'mimo-v2.5-tts',
    voices: { ...VOICES, ...(file.voices ?? {}) },
  }
}

export function createXiaomiTts({ log, platform = process.platform }) {
  const muted = ['off', '0', 'false'].includes((process.env.XIAOMI_TTS ?? '').toLowerCase())
    || (process.env.DSH_SALES_COPILOT_TTS ?? '').toLowerCase() === 'off'
  const supported = platform === 'win32' && !muted
  let lastError = null
  let lastVoice = null
  let lastMs = null
  let speaking = false

  function state() {
    const config = loadConfig()
    return {
      supported: supported && config !== null,
      engine: 'xiaomi',
      configured: config !== null,
      speaking,
      voice: lastVoice,
      lastMs,
      error: lastError,
    }
  }

  function stop() { speaking = false; return true }

  async function speak({ text, lang = 'en', timeoutMs }) {
    const config = loadConfig()
    if (!supported || config === null) throw new Error('小米 TTS 未配置或未启用')
    const line = String(text ?? '').trim()
    if (line === '') throw new Error('没有可朗读的文本')
    speaking = true
    lastError = null
    const started = Date.now()
    try {
      const voice = config.voices[lang === 'zh' ? 'zh' : 'en']
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': config.key },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'assistant', content: line }],
          audio: { voice, format: 'wav' },
        }),
        signal: AbortSignal.timeout(Math.max(Number(timeoutMs) || 30000, 15000)),
      })
      const payload = await response.json()
      if (!response.ok || payload?.error) {
        throw new Error(payload?.error?.message ?? `小米 TTS 返回 HTTP ${response.status}`)
      }
      const data = payload?.choices?.[0]?.message?.audio?.data
      if (typeof data !== 'string' || data === '') throw new Error('小米 TTS 没有返回音频')
      const wav = Buffer.from(data, 'base64')
      lastVoice = voice
      lastMs = Date.now() - started
      log(`xiaomi-tts: synthesised ${line.length} chars in ${lastMs} ms with ${voice} (${wav.length} bytes)`)
      return { voice, ms: lastMs, wav }
    } catch (error) {
      lastError = error.message
      throw error
    } finally {
      speaking = false
    }
  }

  return { supported, voices: async () => [VOICES.zh, VOICES.en], speak, stop, state }
}
