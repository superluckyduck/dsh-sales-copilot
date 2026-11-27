import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { startCapture } from './capture.js'
import { createAsr } from './asr.js'
import { mergeCaptionText, shouldMergeCaption } from './captions.js'
import { createLlm, languageName } from './llm.js'
import { createLocalMt } from './local-mt.js'
import { MT_MODELS, defaultMtModelId, findMtModel } from './mt-models.js'
import { normalizeGain, readCanonicalHeader, rms } from './wav.js'

const SOURCES = new Set(['both', 'speaker', 'mic'])
const MAX_ENTRIES = 600
/** Below this RMS the segment is room noise; sending it only risks hallucinations.
 *  Kept low on purpose: this machine's loopback can be quiet (a full-volume video
 *  measures well below the old 0.005), and `normalizeGain` lifts whatever does
 *  pass to a readable level before recognition. */
const SILENCE_RMS = 0.002
/**
 * Longest single take the capture helper is allowed to build. It is a safety net,
 * not a target: a take ends at the first real pause in the audio, and the cap only
 * applies to audio that never dips (music, continuous speech). A take that ended
 * because of this cap is merged back into the same caption.
 */
const TAKE_SECONDS = 8
const MT_MODEL_IDS = new Set(MT_MODELS.map((entry) => entry.id))
/** SenseVoice's stock output for sub-second noise (clicks, breaths). */
const FILLER_TEXTS = new Set(['the', 'you', 'ok', 'okay', 'hello', 'hi', 'thanks', 'thank you', 'bye', 'goodbye', '嗯', '啊', '呃', '好', '嗯嗯'])

const DEFAULTS = {
  source: 'both',
  sourceLanguage: 'auto',
  targetLanguage: 'zh',
  translate: true,
  translateEngine: 'cloud',
  // Cloud translation route; empty strings follow the profile's default model.
  cloudProvider: '',
  cloudModel: '',
  // Offline translation model, chosen from the shipped catalog.
  builtinModel: defaultMtModelId(),
  localBaseUrl: 'http://127.0.0.1:11434/v1',
  localModel: '',
  localApiKey: '',
  minSegmentSeconds: 1.2,
  keepAudio: false,
  // Desktop-lyrics box: transparency, position, size and lock. A null size
  // means "fit the current viewport", which the client resolves per screen.
  lyricFontSize: 22,
  lyricOpacity: 0.92,
  lyricX: null,
  lyricY: null,
  lyricW: null,
  lyricH: null,
  lyricLocked: false,
  lyricShowSource: true,
  lyricVisible: true,
  // Records pop-up geometry.
  recordsX: null,
  recordsY: null,
  recordsW: null,
  recordsH: null,
  providerId: undefined,
  provider: undefined,
  model: undefined,
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function stamp(ms = Date.now()) {
  const date = new Date(ms)
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Session id is unique to the millisecond: two meetings started within the same
 * second must not share a directory, or the second would silently overwrite the
 * first one's transcript.
 */
function sessionId(ms = Date.now()) {
  return `${stamp(ms)}-${String(ms % 1000).padStart(3, '0')}`
}

function clock(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds / 1000))
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

/** Wall-clock stamp (时:分:秒) for a point inside a session. */
function timeOfDay(startedAt, offsetMs) {
  const date = new Date(startedAt + Math.max(0, offsetMs))
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Owns the whole live-subtitle lifecycle: model readiness, the native capture
 * process, sequential recognition, batched translation and meeting minutes.
 * Both the Web UI and the agent tool drive this single object.
 */
export class MeetingController {
  constructor({ ctx, config, dataRoot, packageDir, sttDataRoot, log, nativeBin }) {
    this.ctx = ctx
    this.config = config
    this.dataRoot = dataRoot
    this.packageDir = packageDir ?? null
    this.log = log
    this.nativeBin = nativeBin ?? null
    this.settingsFile = join(dataRoot, 'settings.json')

    this.settings = { ...DEFAULTS }
    for (const key of Object.keys(DEFAULTS)) {
      if (config?.[key] !== undefined && config[key] !== null) this.settings[key] = config[key]
    }
    this.loadSettings()
    // Older versions stored the removed "一键离线" toggle. `loadSettings` only
    // keeps known keys, so rewrite the file once to stop it from resurrecting.
    if (this.settingsWereCleaned) this.saveSettings()

    this.status = 'idle'
    this.error = null
    this.rev = 0
    this.entries = []
    this.seq = 0
    this.cursorMs = 0
    this.session = null
    this.segments = 0
    this.capture = null
    this.queue = []
    this.pumping = false
    // Live drafts: the capture helper publishes the audio of the open take every
    // 1.5 s so the first words can be recognised long before the take ends.
    this.draft = null
    this.drafting = false
    this.draftEntry = null
    this.draftIndex = 0
    this.takeId = 0
    this.abort = null
    this.translationTimer = null
    this.translating = false
    this.translationDirty = false
    this.translationError = null
    this.warnings = []
    this.noAudioTimer = null
    this.minutes = { generating: false, text: '', path: null, generatedAt: null, error: null }
    this.minutesPromise = null
    this.disposed = false
    // The always-on-top overlay window (its own PowerShell/WPF process) reports
    // its availability through the state payload; attached after construction.
    this.overlayDescribe = null
    this.overlayOpen = null
    this.asrBootAsked = false

    this.asr = createAsr({ ctx, config: { providerId: config.providerId }, packageDir: this.packageDir, sttDataRoot, log })
    this.mt = createLocalMt({
      dataRoot, config, packageDir: this.packageDir, log,
      modelOf: () => this.settings.builtinModel,
    })
    this.llm = createLlm({ ctx, config, log, settings: () => this.settings, mt: this.mt })
  }

  // ---------------------------------------------------------------- settings

  loadSettings() {
    this.settingsWereCleaned = false
    try {
      if (existsSync(this.settingsFile)) {
        const stored = JSON.parse(readFileSync(this.settingsFile, 'utf8'))
        for (const key of Object.keys(DEFAULTS)) {
          if (stored[key] !== undefined && stored[key] !== null) this.settings[key] = stored[key]
        }
        this.settingsWereCleaned = 'offlineMode' in stored || 'offlinePrevEngine' in stored
      }
    } catch (error) {
      this.log(`settings: could not read ${this.settingsFile}: ${error.message}`)
    }
  }

  saveSettings() {
    try {
      mkdirSync(this.dataRoot, { recursive: true })
      writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2))
    } catch (error) {
      this.log(`settings: could not write ${this.settingsFile}: ${error.message}`)
    }
  }

  updateSettings(patch) {
    const next = { ...this.settings }
    if (typeof patch.source === 'string' && SOURCES.has(patch.source)) next.source = patch.source
    if (typeof patch.sourceLanguage === 'string' && patch.sourceLanguage !== '') next.sourceLanguage = patch.sourceLanguage
    if (typeof patch.targetLanguage === 'string' && patch.targetLanguage !== '') next.targetLanguage = patch.targetLanguage
    if (typeof patch.translate === 'boolean') next.translate = patch.translate
    if (patch.translateEngine === 'cloud' || patch.translateEngine === 'local' || patch.translateEngine === 'builtin') {
      next.translateEngine = patch.translateEngine
    }
    if (typeof patch.offlineMode === 'boolean') {
      // Accepted from older clients only; ignored. The engine dropdown is the
      // single place that picks where translation runs.
    }
    // Cloud route: an empty pair means "follow the profile's default model".
    if (typeof patch.cloudProvider === 'string') next.cloudProvider = patch.cloudProvider.trim()
    if (typeof patch.cloudModel === 'string') next.cloudModel = patch.cloudModel.trim()
    if (next.cloudProvider === '' || next.cloudModel === '') {
      next.cloudProvider = ''
      next.cloudModel = ''
    }
    if (typeof patch.builtinModel === 'string' && MT_MODEL_IDS.has(patch.builtinModel)) {
      next.builtinModel = patch.builtinModel
    }
    if (typeof patch.localBaseUrl === 'string') {
      const value = patch.localBaseUrl.trim().replace(/\/+$/, '')
      if (value === '' || /^https?:\/\/[^\s]+$/i.test(value)) next.localBaseUrl = value === '' ? 'http://127.0.0.1:11434/v1' : value
    }
    if (typeof patch.localModel === 'string') next.localModel = patch.localModel.trim()
    if (typeof patch.localApiKey === 'string') next.localApiKey = patch.localApiKey.trim()
    if (typeof patch.keepAudio === 'boolean') next.keepAudio = patch.keepAudio
    if (Number.isFinite(patch.lyricFontSize)) next.lyricFontSize = Math.min(34, Math.max(14, Math.round(patch.lyricFontSize)))
    if (Number.isFinite(patch.lyricOpacity)) next.lyricOpacity = Math.min(1, Math.max(0.3, Number(patch.lyricOpacity)))
    if (Number.isFinite(patch.lyricX)) next.lyricX = Math.round(patch.lyricX)
    if (Number.isFinite(patch.lyricY)) next.lyricY = Math.round(patch.lyricY)
    if (typeof patch.lyricLocked === 'boolean') next.lyricLocked = patch.lyricLocked
    if (typeof patch.lyricShowSource === 'boolean') next.lyricShowSource = patch.lyricShowSource
    if (typeof patch.lyricVisible === 'boolean') next.lyricVisible = patch.lyricVisible
    if (patch.lyricW === null) next.lyricW = null
    else if (Number.isFinite(patch.lyricW)) next.lyricW = Math.max(320, Math.round(patch.lyricW))
    if (patch.lyricH === null) next.lyricH = null
    else if (Number.isFinite(patch.lyricH)) next.lyricH = Math.max(140, Math.round(patch.lyricH))
    if (Number.isFinite(patch.recordsX)) next.recordsX = Math.round(patch.recordsX)
    if (Number.isFinite(patch.recordsY)) next.recordsY = Math.round(patch.recordsY)
    if (Number.isFinite(patch.recordsW)) next.recordsW = Math.max(300, Math.round(patch.recordsW))
    if (Number.isFinite(patch.recordsH)) next.recordsH = Math.max(220, Math.round(patch.recordsH))
    if (patch.lyricReset === true) {
      next.lyricX = null
      next.lyricY = null
      next.lyricW = null
      next.lyricH = null
    }
    // Eagerly (re)start the built-in model when a translation-relevant field
    // changes — including a no-op retry after a failure — but never on pure
    // geometry changes (dragging the lyric box must not trigger a download).
    const translationTouch = ['translateEngine', 'translate', 'targetLanguage',
      'sourceLanguage', 'localBaseUrl', 'localModel', 'localApiKey', 'builtinModel'].some((key) =>
      Object.prototype.hasOwnProperty.call(patch, key))
    if (next.builtinModel !== this.settings.builtinModel) {
      this.mt.setModel(next.builtinModel)
    }
    // Load the offline model when it is already on disk, but never start a
    // multi-hundred-megabyte download just because the engine dropdown changed:
    // the panel's download button is the explicit opt-in for that.
    if (next.translateEngine === 'builtin' && translationTouch && this.mt.isDownloaded(next.builtinModel)) {
      this.mt.prepare()
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings)
    if (!changed) return this.settings
    const sourceChanged = next.source !== this.settings.source
    this.settings = next
    this.saveSettings()
    this.bump()
    if (sourceChanged && this.status === 'running' && this.capture !== null) {
      void this.restartCapture()
    }
    return this.settings
  }

  // ------------------------------------------------------------------- state

  bump() {
    this.rev += 1
  }

  retranslatableLanguage() {
    return this.settings.sourceLanguage !== 'auto' && this.settings.sourceLanguage === this.settings.targetLanguage
  }

  /**
   * Whether a line already reads in the subtitle language, so a model call adds
   * nothing. Deliberately conservative: it is applied only when the source
   * language is "auto" (an explicit source language is trusted, and the
   * same-language case is handled earlier by `retranslatableLanguage`). We skip
   * only the one unambiguous case — Han text going into a Chinese subtitle —
   * because guessing further is what silently dropped real translations, e.g.
   * "Latin letters ⇒ already English" made Spanish/French/German → English show
   * the original, and zero-letter text (Cyrillic/Kana/Hangul) was treated as
   * already-any-language.
   */
  matchesTarget(text) {
    if (this.settings.sourceLanguage !== 'auto') return false
    const target = this.settings.targetLanguage
    if (target === 'zh' || target === 'yue') {
      const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
      const letters = (text.match(/[A-Za-z]/g) ?? []).length
      const visible = han + letters
      return visible > 0 && han / visible >= 0.35
    }
    return false
  }

  view(entry) {
    return {
      seq: entry.seq,
      startMs: entry.startMs,
      endMs: entry.endMs,
      at: entry.time ?? (this.session === null ? clock(entry.startMs) : timeOfDay(this.session.startedAt, entry.startMs)),
      text: entry.text,
      translation: entry.translation ?? entry.partialTranslation ?? null,
      live: entry.translation === null && entry.partialTranslation != null,
      translationFailed: entry.translationFailed === true,
      // True while the take is still open: the text is what has been recognised
      // so far and will be replaced by the finished take.
      draft: entry.draft === true,
      lang: entry.lang,
    }
  }

  state(since = 0) {
    const entries = this.entries
      .filter((entry) => entry.seq > since)
      .slice(-120)
      .map((entry) => this.view(entry))
    // The newest lines are repeated on every poll so a streamed translation
    // reaches a client that already has that sequence number.
    const recent = this.entries.slice(-8).map((entry) => this.view(entry))
    return {
      rev: this.rev,
      status: this.status,
      error: this.error,
      settings: {
        source: this.settings.source,
        sourceLanguage: this.settings.sourceLanguage,
        targetLanguage: this.settings.targetLanguage,
        translate: this.settings.translate,
        translateEngine: this.settings.translateEngine,
        cloudProvider: this.settings.cloudProvider,
        cloudModel: this.settings.cloudModel,
        builtinModel: this.settings.builtinModel,
        localBaseUrl: this.settings.localBaseUrl,
        localModel: this.settings.localModel,
        localApiKeySet: this.settings.localApiKey !== '',
        lyricFontSize: this.settings.lyricFontSize,
        lyricOpacity: this.settings.lyricOpacity,
        lyricX: this.settings.lyricX,
        lyricY: this.settings.lyricY,
        lyricW: this.settings.lyricW,
        lyricH: this.settings.lyricH,
        lyricLocked: this.settings.lyricLocked,
        lyricShowSource: this.settings.lyricShowSource,
        lyricVisible: this.settings.lyricVisible,
        recordsX: this.settings.recordsX,
        recordsY: this.settings.recordsY,
        recordsW: this.settings.recordsW,
        recordsH: this.settings.recordsH,
        keepAudio: this.settings.keepAudio,
      },
      engine: this.llm.describeEngine(),
      mt: this.mt.describe(),
      overlay: this.overlayDescribe === null ? { supported: false, open: false } : this.overlayDescribe(),
      asr: this.asr.describe(),
      session: this.session === null
        ? null
        : {
            id: this.session.id,
            startedAt: this.session.startedAt,
            elapsedMs: Date.now() - this.session.startedAt,
            segments: this.segments,
            entries: this.entries.length,
          },
      entries,
      recent,
      totalEntries: this.entries.length,
      translationError: this.translationError,
      warnings: this.warnings.slice(-5),
      setup: this.setupNotice(),
      minutes: {
        generating: this.minutes.generating,
        generatedAt: this.minutes.generatedAt,
        path: this.minutes.path,
        error: this.minutes.error,
        text: this.minutes.text,
      },
      targetLabel: languageName(this.settings.targetLanguage),
    }
  }

  // ------------------------------------------------------------- lifecycle

  prepare() {
    try {
      const id = this.asr.prepare()
      this.error = null
      this.bump()
      return { ok: true, providerId: id }
    } catch (error) {
      this.error = error.message
      return { ok: false, error: error.message }
    }
  }

  /**
   * macOS one-time setup probe, surfaced by the panel before the first start:
   * without the Command Line Tools the Swift helpers cannot be compiled, and
   * telling the user here beats an error when they press Start.
   */
  setupNotice() {
    if (process.platform !== 'darwin' || this.nativeBin === null) return null
    const state = this.nativeBin.describe('capture')
    if (state.supported === true) return null
    return state.error ?? 'macOS 需要 Xcode Command Line Tools 才能编译采集助手（`xcode-select --install`）。'
  }

  /** Trigger the system Command Line Tools install wizard (macOS only). */
  startCLTInstall() {
    if (process.platform !== 'darwin') return { ok: false, error: '仅 macOS 需要' }
    try {
      const child = spawn('/usr/bin/xcode-select', ['--install'], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      this.log('setup: launched the Command Line Tools install wizard')
      return { ok: true, note: '已弹出系统安装向导，按提示完成安装后重试。' }
    } catch (error) {
      return { ok: false, error: `无法启动安装向导：${error.message}` }
    }
  }

  /**
   * Fetch the recognition model as soon as the plugin is active instead of when
   * the first session starts: the model is required, and a 239 MB download
   * landing in the middle of a meeting is the worst possible moment for it.
   *
   * Runs at most once per activation, never blocks, and does not load the model
   * into memory when it is already on disk — the first session loads it in a
   * second, and a user who never starts a session does not pay for 230 MB of RAM.
   */
  prepareAsrInBackground() {
    if (this.asrBootAsked || this.disposed) return
    this.asrBootAsked = true
    let attempts = 0
    const tick = () => {
      if (this.disposed) return
      const status = this.asr.describe()
      // The speech service is a separate plugin: it may register after this one.
      if (status.available !== true) {
        attempts += 1
        if (attempts > 30) { this.log('asr: background download skipped, speech service unavailable'); return }
        const later = setTimeout(tick, 2000)
        later.unref?.()
        return
      }
      if (status.phase !== 'unprepared' && status.phase !== 'failed') {
        this.log(`asr: model ${status.phase}`)
        return
      }
      if (this.asr.modelPresent() === true) {
        this.log('asr: model already downloaded')
        return
      }
      try {
        this.asr.prepare()
        this.error = null
        this.log('asr: downloading recognition model in the background')
        this.bump()
      } catch (error) {
        this.log(`asr: background download failed to start: ${error.message}`)
      }
    }
    const first = setTimeout(tick, 1500)
    first.unref?.()
  }

  /** Install the built-in translation dependency on the user's explicit request. */
  async installMtDeps() {
    const result = await this.mt.installDeps()
    this.bump()
    return result
  }

  /** Cloud routes the model picker offers. */
  async listCloudModels() {
    const cloud = await this.llm.listCloudModels()
    return {
      ...cloud,
      pinned: { provider: this.settings.cloudProvider, model: this.settings.cloudModel },
      active: this.llm.describeEngine(),
    }
  }

  /** Offline catalog with per-model download state. */
  offlineModels() {
    const status = this.mt.describe()
    return { active: status.model, models: status.models }
  }

  /**
   * Download (and load) one offline model on request. The state payload already
   * reports progress, so this only has to kick the child off.
   */
  downloadOfflineModel(id) {
    const chosen = typeof id === 'string' && id !== '' ? id : this.settings.builtinModel
    // The panel button always means "start this download from a clean state".
    const result = this.mt.download(chosen, { restart: true })
    if (result.ok !== false) {
      // Remember the download so the panel highlights the same model afterwards.
      this.updateSettings({ builtinModel: chosen })
    } else {
      this.bump()
    }
    return { ...result, model: chosen }
  }

  /** Abort an in-flight offline model download. */
  cancelOfflineModel() {
    const result = this.mt.cancel()
    this.bump()
    return result
  }

  start() {
    if (this.disposed) throw new Error('插件已卸载')
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return {
        ok: false,
        error: `实时字幕目前支持 Windows 与 macOS，当前系统（${process.platform}）无法采集系统声音。`,
      }
    }
    if (this.status === 'running' || this.status === 'preparing' || this.status === 'starting') {
      return { ok: true, status: this.status, note: '已在运行' }
    }
    this.error = null
    this.status = 'preparing'
    this.abort = new AbortController()
    this.bump()
    void this.begin(this.abort).catch((error) => {
      if (this.abort?.signal.aborted) {
        this.log('start aborted by the user')
        if (this.status === 'preparing' || this.status === 'starting') {
          this.status = 'idle'
          this.bump()
        }
        return
      }
      this.log(`start failed: ${error.stack ?? error.message}`)
      this.error = error.message
      this.status = 'error'
      this.bump()
    })
    return { ok: true, status: this.status }
  }

  async begin(abort) {
    const signal = abort.signal
    await this.asr.ensureReady({ signal, onProgress: () => this.bump() })
    if (signal.aborted) return
    if (this.settings.translateEngine === 'builtin') {
      this.mt.prepare()
    }
    this.status = 'starting'
    this.bump()
    this.openSession()
    await this.startCapture(signal)
    // Load the recogniser in parallel with the first seconds of audio so the
    // first line does not wait for the model.
    void this.asr.warmup()
    this.status = 'running'
    this.bump()
    // A session starts by showing the overlay: that window is where the captions
    // are read, and having to switch it on after every start is a step nobody
    // needs. Hiding it again during the session still works.
    this.openOverlay()
    this.armNoAudioHint()
    this.log(`session ${this.session?.id} capturing ${this.settings.source}`)
  }

  /**
   * Start the always-on-top overlay. The window lives in the plugin entry (it is
   * its own OS process), so the controller only calls the callback it was given;
   * a host without such a window simply never sets it.
   */
  openOverlay() {
    const open = this.overlayOpen
    if (typeof open !== 'function') return { ok: false }
    this.updateSettings({ lyricVisible: true })
    try {
      return open() ?? { ok: true }
    } catch (error) {
      this.log(`overlay: could not open: ${error.message}`)
      return { ok: false, error: error.message }
    }
  }

  /**
   * A first-run safety net: if the capture is running but nothing audible has
   * been recognised after a while, the most common cause is a wrong audio
   * source, a muted system, or a missing microphone permission. A gentle
   * warning in the panel points there instead of leaving a silent, empty box.
   */
  armNoAudioHint() {
    if (this.noAudioTimer !== null) clearTimeout(this.noAudioTimer)
    this.noAudioTimer = setTimeout(() => {
      this.noAudioTimer = null
      if (this.status === 'running' && this.segments === 0 && !this.disposed) {
        this.warnings.push('还没检测到声音。请检查系统音量、麦克风权限，或换个「音频来源」。')
        if (this.warnings.length > 5) this.warnings.shift()
        this.bump()
      }
    }, 20000)
  }

  openSession() {
    const id = sessionId()
    const directory = join(this.dataRoot, 'sessions', id)
    mkdirSync(join(directory, 'segments'), { recursive: true })
    const transcriptFile = join(directory, 'transcript.jsonl')
    // A fresh session always starts from an empty transcript, even if an id
    // happened to collide with an older one.
    writeFileSync(transcriptFile, '')
    this.session = { id, directory, startedAt: Date.now(), transcriptFile }
    this.entries = []
    this.seq = 0
    this.cursorMs = 0
    this.segments = 0
    this.queue = []
    this.draft = null
    this.draftEntry = null
    this.draftIndex = 0
    this.takeId = 0
    this.translationError = null
    this.warnings = []
    this.minutes = { generating: false, text: '', path: null, generatedAt: null, error: null }
    writeFileSync(join(directory, 'meta.json'), JSON.stringify({
      id,
      startedAt: new Date().toISOString(),
      source: this.settings.source,
      sourceLanguage: this.settings.sourceLanguage,
      targetLanguage: this.settings.targetLanguage,
    }, null, 2))
    this.bump()
  }

  async startCapture(signal) {
    const directory = join(this.session.directory, 'segments')
    let nativeCapture
    if (process.platform === 'darwin') {
      if (this.nativeBin === null) {
        this.error = 'macOS 采集助手不可用'
        this.status = 'error'
        this.bump()
        return
      }
      const built = await this.nativeBin.ensure('capture')
      if (built.ok !== true) {
        this.error = built.error
        this.status = 'error'
        this.bump()
        return
      }
      nativeCapture = built.path
    }
    this.capture = startCapture({
      outDir: directory,
      nativeCapture,
      segmentSeconds: TAKE_SECONDS,
      minSegmentSeconds: this.settings.minSegmentSeconds,
      source: this.settings.source,
      log: this.log,
      onSegment: (segment) => {
        this.queue.push(segment)
        void this.pump()
      },
      onDraft: (draft) => {
        // Only the newest draft of the open take is worth recognising: an older
        // one would be replaced a second later anyway.
        this.draft = draft
        void this.pumpDrafts()
      },
      onStatus: (status) => {
        if (this.disposed) return
        if (status.phase === 'error') {
          this.error = status.error
          this.status = 'error'
          this.bump()
        } else if (status.phase === 'exited' && this.status !== 'stopping' && this.status !== 'idle') {
          this.error = status.error ?? '音频采集进程意外退出，请重新开始。'
          this.status = 'error'
          this.bump()
        }
      },
      onWarning: (message) => {
        this.warnings.push(message)
        if (this.warnings.length > 5) this.warnings.shift()
        this.bump()
      },
    })
    if (signal.aborted) await this.stopCapture()
  }

  async restartCapture() {
    if (this.disposed) return
    this.log('restarting capture for a new source')
    await this.stopCapture()
    if (this.session === null) return
    await this.startCapture(this.abort?.signal ?? new AbortController().signal)
  }

  async stopCapture() {
    const capture = this.capture
    this.capture = null
    if (capture !== null) {
      try {
        await capture.stop()
      } catch (error) {
        this.log(`stop capture failed: ${error.message}`)
      }
    }
  }

  async stop() {
    if (this.disposed) return { ok: false, error: '插件已卸载' }
    if (this.status === 'idle') return { ok: true, status: 'idle', note: '未在运行' }
    this.status = 'stopping'
    this.bump()
    await this.stopCapture()
    // Let the last queued segments finish while their cancellation signal is
    // still live; only then cancel preparation or in-flight recognition.
    const deadline = Date.now() + 8000
    while ((this.queue.length > 0 || this.pumping) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    if (this.translationTimer !== null) {
      clearTimeout(this.translationTimer)
      this.translationTimer = null
    }
    if (this.noAudioTimer !== null) {
      clearTimeout(this.noAudioTimer)
      this.noAudioTimer = null
    }
    await this.flushTranslations()
    if (this.abort !== null) this.abort.abort()
    this.status = 'idle'
    this.error = null
    this.bump()
    return { ok: true, status: 'idle' }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.abort !== null) this.abort.abort()
    if (this.translationTimer !== null) clearTimeout(this.translationTimer)
    this.translationTimer = null
    if (this.noAudioTimer !== null) clearTimeout(this.noAudioTimer)
    this.noAudioTimer = null
    await this.stopCapture()
    await this.mt.dispose()
  }

  // ------------------------------------------------------------ recognition

  async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const segment = this.queue.shift()
        try {
          await this.recognize(segment)
        } catch (error) {
          if (!this.disposed) this.log(`segment ${segment?.file ?? '?'}: ${error.message}`)
        }
      }
    } finally {
      this.pumping = false
    }
  }

  async recognize(segment) {
    try {
      await this.recognizeSegment(segment)
    } finally {
      // A one-hour meeting is roughly 1.2 GB of 16 kHz segments, so the audio is
      // dropped after the attempt unless the profile asks to keep it.
      if (this.settings.keepAudio !== true && segment?.file) {
        try { rmSync(segment.file, { force: true }) } catch (error) { this.log(`segment cleanup failed: ${error.message}`) }
      }
    }
  }

  /**
   * Recognise the audio of a take that is still open, so the overlay can show the
   * first words about two seconds after they were spoken instead of waiting for
   * the take to end at a pause. The draft text is replaced in place by the final
   * take text, so the line never appears twice.
   */
  async pumpDrafts() {
    if (this.drafting) return
    this.drafting = true
    try {
      while (this.draft !== null) {
        const draft = this.draft
        this.draft = null
        // A finished take is more important than a draft of the next one.
        if (this.pumping || this.queue.length > 0) continue
        try {
          await this.recognizeDraft(draft)
        } catch (error) {
          if (!this.disposed) this.log(`draft ${draft?.file ?? '?'}: ${error.message}`)
        }
      }
    } finally {
      this.drafting = false
    }
  }

  async recognizeDraft(draft) {
    if (this.session === null || draft === undefined) return
    if (Number.isFinite(draft.index) && draft.index <= this.takeId) return
    let buffer
    try {
      buffer = await readFile(draft.file)
    } catch {
      return
    } finally {
      try { rmSync(draft.file, { force: true }) } catch { }
    }
    if (buffer.length < 2 * 3200) return
    const header = readCanonicalHeader(buffer)
    if (header === null) return
    if (rms(buffer, header) < SILENCE_RMS) return
    const seconds = header.dataBytes / (header.sampleRate * 2)
    if (seconds < 0.8) return
    const signal = this.abort?.signal ?? new AbortController().signal
    const startedAt = Date.now()
    const result = await this.asr.transcribe(normalizeGain(buffer), this.settings.sourceLanguage, signal)
    const text = result.text.trim()
    if (text === '' || !/[\p{L}\p{N}]/u.test(text)) return
    this.log(`asr draft: ${seconds.toFixed(2)}s audio in ${Date.now() - startedAt}ms`)
    const endMs = this.cursorMs + seconds * 1000
    // Drop a draft line that never got its final take, and start the new one.
    if (this.draftEntry !== null && (this.draftIndex !== draft.index || !this.entries.includes(this.draftEntry))) {
      const at = this.entries.indexOf(this.draftEntry)
      if (at >= 0) this.entries.splice(at, 1)
      this.draftEntry = null
    }
    if (this.draftEntry === null) {
      this.draftIndex = draft.index ?? 0
      this.draftEntry = {
        seq: this.seq + 1,
        startMs: this.cursorMs,
        endMs,
        time: timeOfDay(this.session.startedAt, this.cursorMs),
        text,
        translation: null,
        lang: this.settings.sourceLanguage,
        translationFailed: false,
        awaitingMore: false,
        merges: 0,
        draft: true,
        createdAt: Date.now(),
      }
      this.entries.push(this.draftEntry)
      if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    } else {
      if (this.draftEntry.text === text) { this.draftEntry.endMs = endMs; this.bump(); return }
      this.draftEntry.text = text
      this.draftEntry.endMs = endMs
      // Keep the translation that is already on screen: it trails the text by one
      // model round trip, and blanking it on every slice would make the line
      // flicker instead of lag.
      this.carryTranslation(this.draftEntry)
    }
    this.bump()
    // Translation of a draft only makes sense when the model answers in about a
    // second (cloud): the subtitle then translates as it is being spoken. A local
    // model needs seconds per line, so translating text that changes 1.5 s later
    // would queue work that is stale on arrival and steal CPU from recognition.
    if (this.settings.translate && this.llm.engineKind() === 'cloud') this.scheduleTranslation(1200)
  }

  /**
   * Transcribe one captured take and fold it into the caption list.
   *
   * The capture helper closes a take at a real pause, and otherwise at the cap,
   * in the quietest stretch it can find. A cap cut whose gap was not deep enough
   * (music, noise, a cut inside a clause) means the next take continues the same
   * sentence: that continuation is merged into the previous caption instead of
   * becoming a new line, and translation waits until the sentence actually ends.
   */
  async recognizeSegment(segment) {
    if (this.session === null || segment === undefined) return
    const file = segment.file
    const reason = segment.reason === 'cut' ? 'cut' : 'pause'
    const buffer = await readFile(file)
    if (buffer.length < 2 * 3200) return
    const header = readCanonicalHeader(buffer)
    if (header === null) {
      this.log(`segment ${file}: unexpected WAV layout, skipping`)
      return
    }
    const level = rms(buffer, header)
    if (level < SILENCE_RMS) return

    const audio = normalizeGain(buffer)
    const seconds = header.dataBytes / (header.sampleRate * 2)
    const signal = this.abort?.signal ?? new AbortController().signal
    const startedAt = Date.now()
    const result = await this.asr.transcribe(audio, this.settings.sourceLanguage, signal)
    const text = result.text.trim()
    this.log(`asr: ${seconds.toFixed(2)}s audio in ${Date.now() - startedAt}ms (${reason})`)
    if (text === '') return
    // Recognisers sometimes return only punctuation for noise; those are not subtitles.
    if (!/[\p{L}\p{N}]/u.test(text)) return
    // A sub-second snippet recognised as one of the recogniser's stock filler
    // words is a hallucination from a click/breath, not speech ("The.", "Thank
    // you."). Real words in a real utterance are longer than a second or say
    // something else.
    if (seconds < 1.2 && FILLER_TEXTS.has(text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())) {
      this.log(`asr: dropped filler hallucination "${text}" (${seconds.toFixed(2)}s)`)
      return
    }

    const startMs = this.cursorMs
    const endMs = startMs + seconds * 1000
    this.cursorMs = endMs
    this.segments += 1
    if (this.noAudioTimer !== null) {
      clearTimeout(this.noAudioTimer)
      this.noAudioTimer = null
    }

    // A draft line that does not belong to this take is stale (its take was
    // dropped, e.g. as silence): it must not keep the caption list from moving on.
    if (this.draftEntry !== null && this.draftIndex !== (segment.index ?? this.draftIndex)) {
      const at = this.entries.indexOf(this.draftEntry)
      if (at >= 0) this.entries.splice(at, 1)
      this.draftEntry = null
      this.draftIndex = 0
    }
    const previous = this.entries[this.entries.length - 1]
    // The take this draft line belongs to just ended: the final text replaces the
    // live draft in place, so the overlay keeps one line instead of showing the
    // same words twice (once as draft, once as the take).
    const drafted = this.draftEntry
    if (drafted !== null && this.entries[this.entries.length - 1] === drafted) {
      drafted.text = text
      drafted.endMs = endMs
      drafted.draft = false
      drafted.awaitingMore = reason === 'cut'
      drafted.merges = 0
      drafted.createdAt = Date.now()
      this.carryTranslation(drafted)
      this.draftEntry = null
      this.draftIndex = 0
      this.seq = drafted.seq
      if (Number.isFinite(segment.index)) this.takeId = segment.index
      this.appendRecord({
        type: 'segment',
        seq: drafted.seq,
        at: new Date().toISOString(),
        time: drafted.time,
        startMs: drafted.startMs,
        seconds,
        text,
        reason,
      })
      this.bump()
      if (this.settings.translate) this.scheduleTranslation(0)
      return
    }
    if (shouldMergeCaption(previous, text)) {
      // Same sentence, next slice: grow the caption in place and keep its seq so
      // the panel/overlay replace the line instead of appending a fragment.
      previous.text = mergeCaptionText(previous.text, text)
      previous.endMs = endMs
      previous.awaitingMore = reason === 'cut'
      previous.merges = (previous.merges ?? 0) + 1
      this.carryTranslation(previous)
      this.appendRecord({
        type: 'merge',
        seq: previous.seq,
        at: new Date().toISOString(),
        time: previous.time,
        startMs: previous.startMs,
        seconds,
        text: previous.text,
      })
      this.bump()
      if (this.settings.translate) this.scheduleTranslation(200)
      return
    }

    // A pause closes a caption that was still waiting for its ending.
    if (previous !== undefined && previous.awaitingMore === true) {
      previous.awaitingMore = false
      if (this.settings.translate) this.scheduleTranslation(0)
    }

    this.seq += 1
    const time = timeOfDay(this.session.startedAt, startMs)
    const entry = {
      seq: this.seq,
      startMs,
      endMs,
      time,
      text,
      translation: null,
      lang: this.settings.sourceLanguage,
      translationFailed: false,
      // A cut that did not land in a real gap means this caption is probably not
      // a complete sentence (see shouldMergeCaption).
      awaitingMore: reason === 'cut',
      merges: 0,
      createdAt: Date.now(),
    }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    if (Number.isFinite(segment.index)) this.takeId = segment.index
    this.appendRecord({
      type: 'segment',
      seq: entry.seq,
      at: new Date().toISOString(),
      time,
      startMs,
      seconds,
      text,
      reason,
    })
    this.bump()
    if (this.settings.translate) this.scheduleTranslation()
  }

  /** Append one transcript record; the reader merges `segment` and `translation`. */
  appendRecord(record) {
    if (this.session === null) return
    try {
      appendFileSync(this.session.transcriptFile, `${JSON.stringify(record)}\n`)
    } catch (error) {
      this.log(`transcript append failed: ${error.message}`)
    }
  }

  // ------------------------------------------------------------ translation

  scheduleTranslation(delay = 0) {
    if (this.translating) {
      this.translationDirty = true
      return
    }
    if (this.translationTimer !== null) return
    this.translationTimer = setTimeout(() => {
      this.translationTimer = null
      void this.flushTranslations()
    }, delay)
  }

  /** Previous two lines, used only as context for terminology continuity. */
  contextFor(entry) {
    return this.entries
      .filter((other) => other.seq < entry.seq)
      .slice(-2)
      .map((other) => other.text)
      .join(' ')
  }

  /**
   * A caption cut mid-sentence keeps growing for the next few seconds, so
   * translating it now would translate half a sentence and then do it again.
   * Wait for the utterance to close — but never longer than a few seconds, or a
   * speaker who never pauses would get no translations at all.
   */
  captionReady(entry) {
    if (entry.awaitingMore !== true) return true
    // Measured from the caption's start, not its last growth: a speaker who never
    // pauses would otherwise postpone its translation forever. Kept short on
    // purpose — waiting for a continuation that may never come is latency the
    // reader feels, and a re-translation after a merge is cheap.
    return Date.now() - (entry.createdAt ?? 0) > 3500
  }

  /**
   * The text of a caption grew, so the translation on screen is now behind. Keep
   * it as the stand-in while the next call runs: blanking it would make every
   * caption blink while the model catches up.
   */
  carryTranslation(entry) {
    if (entry.translation !== null && entry.translation !== undefined) {
      entry.partialTranslation = entry.translation
    }
    entry.translation = null
    entry.translationFailed = false
  }

  async flushTranslations() {
    if (this.translating || !this.settings.translate) return
    const pending = this.entries.filter((entry) =>
      entry.translation === null && entry.translationFailed !== true && this.captionReady(entry))
    if (pending.length === 0) return
    if (this.retranslatableLanguage()) {
      for (const entry of pending) entry.translation = entry.text
      this.bump()
      return
    }
    this.translating = true
    this.translationDirty = false
    let attempted = []
    try {
      // Lines already in the subtitle language need no model call at all, which
      // is the common case for a Chinese meeting with Chinese subtitles.
      for (const entry of pending) {
        if (this.matchesTarget(entry.text)) entry.translation = entry.text
      }
      const untranslated = pending.filter((entry) => entry.translation === null)
      if (untranslated.length === 0) {
        this.translationError = null
        return
      }
      if (untranslated.length >= 2 && this.llm.engineKind() === 'cloud') {
        // Two or more lines in flight fit in one streamed call: each subtitle
        // lands as soon as its own marker completes, instead of one round trip
        // (and one model warm-up) per line.
        attempted = untranslated.slice(0, 6)
        const startedAt = Date.now()
        const request = {
          context: this.contextFor(attempted[0]),
          signal: this.abort?.signal,
          onLine: (seq, text) => {
            const entry = this.entries.find((item) => item.seq === seq)
            if (entry === undefined || entry.translation === text) return
            entry.translation = text
            entry.partialTranslation = null
            this.appendRecord({ type: 'translation', seq: entry.seq, time: entry.time, text })
            this.bump()
          },
        }
        const translated = typeof this.llm.translateStreaming === 'function'
          ? await this.llm.translateStreaming(
            attempted.map((entry) => ({ seq: entry.seq, text: entry.text })),
            this.settings.targetLanguage,
            request,
          )
          : await this.llm.translate(
            attempted.map((entry) => ({ seq: entry.seq, text: entry.text })),
            this.settings.targetLanguage,
            request,
          )
        this.log(`translate batch ${attempted.length}: ${Date.now() - startedAt}ms`)
        for (const entry of attempted) {
          if (entry.translation !== null) continue
          const value = translated.get(entry.seq)
          if (value === undefined) entry.translationFailed = true
          else {
            entry.translation = value
            entry.partialTranslation = null
            this.appendRecord({ type: 'translation', seq: entry.seq, time: entry.time, text: value })
          }
        }
      } else {
        // Normal path: stream this one line so the caption fills in live.
        const entry = untranslated[0]
        attempted = [entry]
        const startedAt = Date.now()
        const text = await this.llm.translateOne(entry.text, this.settings.targetLanguage, {
          context: this.contextFor(entry),
          signal: this.abort?.signal,
          onDelta: (partial) => {
            entry.partialTranslation = partial
            this.bump()
          },
        })
        this.log(`translate ${entry.seq}: ${Date.now() - startedAt}ms`)
        entry.translation = text !== '' ? text : null
        entry.partialTranslation = null
        if (entry.translation === null) entry.translationFailed = true
        else this.appendRecord({ type: 'translation', seq: entry.seq, time: entry.time, text: entry.translation })
      }
      this.translationError = null
    } catch (error) {
      if (this.abort?.signal.aborted !== true) this.log(`translation failed: ${error.message}`)
      this.translationError = error.message
      for (const entry of attempted) {
        // Keep whatever streamed through rather than dropping a readable line.
        if (entry.translation === null && entry.partialTranslation) {
          entry.translation = entry.partialTranslation
          entry.partialTranslation = null
        } else if (entry.translation === null) {
          entry.translationFailed = true
        }
      }
    } finally {
      this.translating = false
      this.bump()
    }
    if (this.translationDirty || this.entries.some((entry) => entry.translation === null && entry.translationFailed !== true)) {
      this.scheduleTranslation(0)
    }
  }

  // ---------------------------------------------------------------- minutes

  transcriptText() {
    return this.entries
      .map((entry) => `[${entry.time ?? clock(entry.startMs)}] ${entry.text}`)
      .join('\n')
  }

  /**
   * The whole job of "generate minutes" as one prompt: base instructions plus the
   * recorded transcript, ready to paste into a fresh session so the summary is
   * produced by a normal conversation instead of a hidden side call.
   */
  minutesPrompt({ title } = {}) {
    const transcript = this.transcriptText()
    const lines = this.entries.length
    const heading = typeof title === 'string' && title.trim() !== '' ? title.trim() : '本次会议'
    const clip = transcript.length > 120000 ? `${transcript.slice(0, 120000)}\n…（转写过长，已截断）` : transcript
    const first = this.entries[0]?.time ?? ''
    const last = this.entries[this.entries.length - 1]?.time ?? ''
    const prompt = [
      `请把下面这份实时字幕转写整理成会议纪要。会议标题：${heading}。`,
      '',
      '要求：',
      '- 只用转写里出现的信息，不要编造；无法确定的内容标注「待确认」。',
      '- 修正明显的识别错别字、去掉口头语和重复，但不要改变原意。',
      '- 输出 Markdown，结构固定为：## 会议概要 / ## 主要议题 / ## 关键结论 / ## 待办事项 / ## 风险与待确认。',
      '- 待办事项用表格：负责人 | 事项 | 截止时间；没有明确负责人或时间就写「待确认」。',
      '- 结尾附一行「转写范围」，写明时间码起止与条数。',
      '',
      `转写（共 ${lines} 条${first !== '' ? `，${first}–${last}` : ''}）：`,
      clip,
    ].join('\n')
    return { prompt, lines, chars: transcript.length, title: heading }
  }

  // -------------------------------------------------------------- records

  /** Session directories on disk, newest first, with a title line. */
  listSessions() {
    const root = join(this.dataRoot, 'sessions')
    if (!existsSync(root)) return []
    const sessions = []
    for (const name of readdirSync(root)) {
      const directory = join(root, name)
      let meta = null
      try {
        meta = JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8'))
      } catch {
        meta = { id: name }
      }
      const records = this.readRecords(name, { countOnly: true })
      sessions.push({
        id: name,
        startedAt: meta.startedAt ?? null,
        source: meta.source ?? 'both',
        sourceLanguage: meta.sourceLanguage ?? 'auto',
        targetLanguage: meta.targetLanguage ?? 'zh',
        entries: records.count,
        firstTime: records.firstTime ?? null,
        lastTime: records.lastTime ?? null,
        durationMs: records.durationMs ?? null,
        endedAt: records.durationMs != null && meta.startedAt
          ? new Date(new Date(meta.startedAt).getTime() + records.durationMs).toISOString()
          : null,
      })
    }
    sessions.sort((a, b) => String(b.id).localeCompare(String(a.id)))
    return sessions.slice(0, 60)
  }

  /**
   * Merge one session's `segment` and `translation` records into readable rows.
   * Older files without `type` are treated as segments.
   */
  readRecords(sessionId, { countOnly = false } = {}) {
    const file = join(this.dataRoot, 'sessions', sessionId, 'transcript.jsonl')
    if (!existsSync(file)) return countOnly ? { count: 0 } : { id: sessionId, entries: [] }
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      this.log(`records: cannot read ${file}: ${error.message}`)
      return countOnly ? { count: 0 } : { id: sessionId, entries: [], error: error.message }
    }
    const rows = []
    const bySeq = new Map()
    let firstAt = null
    let lastAt = null
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record.type === 'translation') {
        const row = bySeq.get(record.seq)
        if (row !== undefined) row.translation = record.text ?? null
        continue
      }
      // A continuation segment was folded into the caption it belongs to: the
      // transcript keeps one row and simply grows its text.
      if (record.type === 'merge') {
        const row = bySeq.get(record.seq)
        if (row !== undefined) {
          row.text = record.text ?? row.text
          if (typeof record.time === 'string') row.time = record.time
        }
        const mergedAt = typeof record.at === 'string' ? Date.parse(record.at) : NaN
        if (Number.isFinite(mergedAt) && (lastAt === null || mergedAt > lastAt)) lastAt = mergedAt
        continue
      }
      if (typeof record.text !== 'string') continue
      const time = typeof record.time === 'string'
        ? record.time
        : (typeof record.at === 'string' && record.at.length >= 19
            ? `${record.at.slice(11, 19)}`
            : '')
      const row = { seq: record.seq ?? rows.length + 1, time, text: record.text, translation: null }
      rows.push(row)
      bySeq.set(row.seq, row)
      // Session length is measured from the records themselves: the wall-clock
      // `at` stamps bracket the meeting even when it outlived a Host restart.
      const at = typeof record.at === 'string' ? Date.parse(record.at) : NaN
      if (Number.isFinite(at)) {
        if (firstAt === null || at < firstAt) firstAt = at
        if (lastAt === null || at > lastAt) lastAt = at
      }
    }
    if (countOnly) {
      return { count: rows.length, firstTime: rows[0]?.time ?? null, lastTime: rows.at(-1)?.time ?? null, durationMs: firstAt === null || lastAt === null ? null : Math.max(0, lastAt - firstAt) }
    }
    return { id: sessionId, entries: rows }
  }

  /**
   * Delete one recorded session. The live session is truncated rather than
   * removed (its directory is still being written to); past sessions lose their
   * whole directory — transcript, segments and meta.
   */
  deleteSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '缺少会话 id' }
    if (this.session !== null && sessionId === this.session.id) {
      this.clear()
      return { ok: true, note: '已清空当前会话的记录' }
    }
    const known = this.listSessions().some((entry) => entry.id === sessionId)
    if (!known) return { ok: false, error: '未找到这个会话' }
    try {
      rmSync(join(this.dataRoot, 'sessions', sessionId), { recursive: true, force: true })
      this.log(`records: deleted session ${sessionId}`)
      this.bump()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `删除失败：${error.message}` }
    }
  }

  /** Awaitable generation used by the agent tool. */
  async generateMinutes({ title } = {}) {
    if (this.minutesPromise !== null) return this.minutesPromise
    if (this.entries.length === 0) throw new Error('还没有可总结的转写内容。')
    const transcript = this.transcriptText()
    this.minutes = { ...this.minutes, generating: true, error: null }
    this.bump()
    this.minutesPromise = (async () => {
      try {
        const text = await this.llm.minutes(transcript, { title })
        const file = join(this.dataRoot, 'minutes', `${this.session?.id ?? stamp()}-minutes.md`)
        mkdirSync(join(this.dataRoot, 'minutes'), { recursive: true })
        const body = [
          `# 会议纪要 ${new Date().toLocaleString('zh-CN')}`,
          '',
          `- 音频来源：${this.settings.source === 'both' ? '系统声音 + 麦克风' : this.settings.source === 'speaker' ? '系统声音' : '麦克风'}`,
          `- 源语言：${this.settings.sourceLanguage}`,
          `- 目标语言：${languageName(this.settings.targetLanguage)}`,
          `- 转写条数：${this.entries.length}`,
          '',
          text,
          '',
          '---',
          '## 原始转写',
          '',
          '```text',
          transcript,
          '```',
          '',
        ].join('\n')
        writeFileSync(file, body)
        this.minutes = {
          generating: false,
          text,
          path: file,
          generatedAt: Date.now(),
          error: null,
        }
        this.log(`minutes written to ${file}`)
        return { text, path: file }
      } catch (error) {
        this.minutes = { ...this.minutes, generating: false, error: error.message }
        throw error
      } finally {
        this.minutesPromise = null
        this.bump()
      }
    })()
    return this.minutesPromise
  }

  /**
   * Clear the current session's transcript — the live list and the on-disk
   * record file, so the "记录" page stays consistent with the panel.
   * `seq` and `cursorMs` are deliberately kept monotonic: they are the session
   * clock and the merge key, so resetting either would make wall-clock times
   * jump backwards and would let a late translation overwrite a new segment.
   */
  clear() {
    this.entries = []
    this.segments = 0
    this.translationError = null
    this.warnings = []
    this.minutes = { generating: false, text: '', path: null, generatedAt: null, error: null }
    if (this.session !== null) {
      try {
        writeFileSync(this.session.transcriptFile, '')
      } catch (error) {
        this.log(`clear: could not truncate transcript: ${error.message}`)
      }
    }
    this.bump()
    return this.state()
  }
}
