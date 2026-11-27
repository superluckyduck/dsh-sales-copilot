/**
 * Adapter over the Host `speechToText` service. The service is optional: the
 * bundle inserts the shipped SenseVoice provider rows, but another profile may
 * run without them, so every call reports an explicit reason instead of
 * throwing an opaque error.
 */

import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const READY_PHASES = new Set(['ready', 'standby'])

/** Bundled recognition files (relative to the package `models/` directory). */
const MODEL_FILES = [
  'sensevoice-onnx/model.int8.onnx',
  'sensevoice-onnx/tokens.txt',
  'silero/silero_vad.onnx',
]
/** The main graph is 239 MB; anything much smaller is a partial download. */
const MODEL_BYTES = 200 * 1024 * 1024

export function createAsr({ ctx, config, packageDir, sttDataRoot, log }) {
  const providerId = config.providerId

  /**
   * Copy the recognition files into the SenseVoice provider's cache when they
   * are present beside the plugin (a source checkout, or an install that still
   * ships `models/`). The published package does not carry them: `statSync`
   * then throws, the seeding is skipped, and the provider downloads its own
   * copy once — the same cache either way.
   */
  function seedModels() {
    if (packageDir === null || sttDataRoot === null || sttDataRoot === undefined) return
    for (const relative of MODEL_FILES) {
      const source = join(packageDir, 'models', relative)
      const destination = join(sttDataRoot, 'models', relative)
      try {
        const sourceSize = statSync(source).size
        let destinationSize = -1
        try {
          destinationSize = statSync(destination).size
        } catch {
          // destination missing: copy below
        }
        if (destinationSize === sourceSize) continue
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(source, destination)
        log(`asr: seeded ${relative}`)
      } catch (error) {
        log(`asr: could not seed ${relative}: ${error.message}`)
      }
    }
  }

  const service = () => {
    const value = ctx.get('speechToText')
    return value ?? undefined
  }

  function snapshot() {
    const stt = service()
    if (stt === undefined) return null
    try {
      return stt.snapshot()
    } catch (error) {
      log(`asr: snapshot failed: ${error.message}`)
      return null
    }
  }

  function selectedProvider(state) {
    if (state === null) return undefined
    const wanted = providerId ?? state.selection?.providerId
    const providers = state.providers ?? []
    return providers.find((provider) => provider.id === wanted) ?? providers[0]
  }

  /** UI-facing readiness, safe to call at any time. */
  function describe() {
    const stt = service()
    if (stt === undefined) {
      return {
        available: false,
        providerId: null,
        phase: 'unavailable',
        message: '语音识别服务未加载，请重新安装插件或重启 Harness。',
        providers: [],
      }
    }
    const state = snapshot()
    if (state === null) {
      return { available: false, providerId: null, phase: 'unavailable', message: '无法读取语音识别状态。', providers: [] }
    }
    const provider = selectedProvider(state)
    if (provider === undefined) {
      return { available: false, providerId: null, phase: 'unavailable', message: '没有可用的本地识别模型。', providers: [] }
    }
    const preparation = provider.preparation ?? { phase: 'unprepared' }
    const message = (() => {
      if (preparation.phase === 'failed') return preparation.message ?? '模型准备失败'
      if (preparation.phase === 'downloading') {
        const done = preparation.completedBytes ?? 0
        const total = preparation.totalBytes
        const percent = total ? Math.round((done / total) * 100) : null
        return `正在下载识别模型 ${percent === null ? '' : `${percent}%`}`.trim()
      }
      if (preparation.phase === 'checking') return '正在检查识别模型'
      if (preparation.phase === 'loading') return '正在加载识别模型'
      if (preparation.phase === 'waking') return '正在唤醒识别引擎'
      if (preparation.phase === 'cancelling') return '正在取消模型准备'
      return undefined
    })()
    return {
      available: true,
      providerId: provider.id,
      providerName: provider.name,
      phase: preparation.phase,
      progress: {
        completedBytes: preparation.completedBytes ?? 0,
        totalBytes: preparation.totalBytes ?? null,
      },
      message,
      languages: provider.languages ?? [],
      downloadSources: provider.downloadSources ?? [],
      providers: (state.providers ?? []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        phase: entry.preparation?.phase ?? 'unprepared',
      })),
    }
  }

  /**
   * Whether the recognition weights are already on disk. The provider keeps them
   * under its own data root, which is the same layout `seedModels` writes, so a
   * stat is enough to tell "needs a download" from "just needs loading".
   */
  function modelPresent() {
    if (sttDataRoot === null || sttDataRoot === undefined) return false
    try {
      return statSync(join(sttDataRoot, 'models', 'sensevoice-onnx', 'model.int8.onnx')).size >= MODEL_BYTES
    } catch {
      return false
    }
  }

  /** Start or join model preparation; does not wait. */
  function prepare() {
    const stt = service()
    if (stt === undefined) throw new Error('语音识别服务未加载')
    seedModels()
    const provider = selectedProvider(snapshot())
    if (provider === undefined) throw new Error('没有可用的本地识别模型')
    const phase = provider.preparation?.phase
    if (READY_PHASES.has(phase) || phase === 'downloading' || phase === 'loading' || phase === 'waking' || phase === 'checking') {
      return provider.id
    }
    log(`asr: preparing ${provider.id}`)
    stt.prepare(provider.id)
    return provider.id
  }

  /**
   * Wait until the recogniser can accept audio, preparing it first when needed.
   * @param {{signal?: AbortSignal, onProgress?: (state: object) => void, timeoutMs?: number}} options
   */
  async function ensureReady({ signal, onProgress, timeoutMs = 30 * 60 * 1000 } = {}) {
    const stt = service()
    if (stt === undefined) throw new Error('语音识别服务未加载')
    seedModels()
    let state = snapshot()
    let provider = selectedProvider(state)
    if (provider === undefined) throw new Error('没有可用的本地识别模型')
    if (READY_PHASES.has(provider.preparation?.phase)) return provider.id
    // Re-attempt even after a previous failure: the provider re-checks the
    // (now seeded) files before downloading, so a transient failure recovers.
    stt.prepare(provider.id)
    const startedAt = Date.now()
    let lastPhase = null
    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw new Error('已取消')
      await new Promise((resolve) => setTimeout(resolve, 700))
      state = snapshot()
      provider = selectedProvider(state)
      if (provider === undefined) throw new Error('识别模型在准备过程中消失了')
      const phase = provider.preparation?.phase
      if (phase !== lastPhase) {
        log(`asr: preparation phase ${phase}`)
        lastPhase = phase
      }
      onProgress?.(describe())
      if (READY_PHASES.has(phase)) return provider.id
      if (phase === 'failed') throw new Error(provider.preparation?.message ?? '模型准备失败')
      if (phase === 'cancelled') throw new Error('模型准备已取消')
    }
    throw new Error('等待识别模型超时')
  }

  /**
   * Transcribe one canonical 16 kHz mono PCM16 WAV.
   * @param {Buffer} audio
   * @param {string} language
   * @param {AbortSignal} signal
   */
  async function transcribe(audio, language, signal) {
    const stt = service()
    if (stt === undefined) throw new Error('语音识别服务未加载')
    const provider = selectedProvider(snapshot())
    if (provider === undefined) throw new Error('没有可用的本地识别模型')
    const hint = language && provider.languages?.includes(language) ? language : 'auto'
    const spec = stt.resolve({ audio, providerId: provider.id, language: hint })
    const transcript = await stt.transcribe(spec, signal)
    return {
      text: String(transcript.text ?? '').trim(),
      seconds: transcript.audioSeconds,
      inferenceSeconds: transcript.inferenceSeconds,
    }
  }

  /**
   * Load the recogniser before the first real utterance. The provider keeps its
   * worker in standby after activation, and the first recording would otherwise
   * pay the model-load latency.
   */
  async function warmup() {
    try {
      const sampleRate = 16000
      const frames = Math.floor(sampleRate * 0.4)
      const buffer = Buffer.alloc(44 + frames * 2)
      buffer.write('RIFF', 0, 'ascii')
      buffer.writeUInt32LE(36 + frames * 2, 4)
      buffer.write('WAVE', 8, 'ascii')
      buffer.write('fmt ', 12, 'ascii')
      buffer.writeUInt32LE(16, 16)
      buffer.writeUInt16LE(1, 20)
      buffer.writeUInt16LE(1, 22)
      buffer.writeUInt32LE(sampleRate, 24)
      buffer.writeUInt32LE(sampleRate * 2, 28)
      buffer.writeUInt16LE(2, 32)
      buffer.writeUInt16LE(16, 34)
      buffer.write('data', 36, 'ascii')
      buffer.writeUInt32LE(frames * 2, 40)
      const startedAt = Date.now()
      await transcribe(buffer, 'auto', new AbortController().signal)
      log(`asr: warmup ${Date.now() - startedAt}ms`)
    } catch (error) {
      log(`asr: warmup skipped (${error.message})`)
    }
  }

  return { describe, prepare, ensureReady, transcribe, warmup, modelPresent, providerId: () => selectedProvider(snapshot())?.id ?? null }
}
