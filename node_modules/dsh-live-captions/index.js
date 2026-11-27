import { appendFileSync, existsSync, mkdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerApi } from './lib/api.js'
import { MeetingController } from './lib/controller.js'
import { createNativeBin } from './lib/native-bin.js'
import { createOverlayManager } from './lib/overlay-window.js'

const LOG_LIMIT = 2 * 1024 * 1024

function homeRoot() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function resolveDataRoot(config) {
  if (typeof config?.dataRoot === 'string' && config.dataRoot !== '') return config.dataRoot
  return join(homeRoot(), 'live-captions')
}

/**
 * The plugin used to be called "meeting captions" and wrote its transcripts,
 * records, settings and model cache under `~/.dsh/meeting-captions`. Adopt that
 * directory on the first run after the rename instead of starting empty; a
 * rename inside the same home directory is cheap even for the model cache.
 * Failure is not fatal: a fresh root is used and the old one stays untouched.
 */
function adoptLegacyDataRoot(dataRoot, log) {
  try {
    const legacy = join(homeRoot(), 'meeting-captions')
    if (dataRoot === legacy || !existsSync(legacy) || existsSync(dataRoot)) return
    mkdirSync(dirname(dataRoot), { recursive: true })
    renameSync(legacy, dataRoot)
    log(`adopted earlier data root ${legacy} as ${dataRoot}`)
  } catch (error) {
    log(`could not adopt the earlier data root: ${error.message}`)
  }
}

/**
 * Where the shipped SenseVoice provider keeps its models. This must match the
 * `dataRoot` of the `live-captions-sensevoice` row in cordis.patch.yml
 * (`dshHomePath('speech-to-text', 'sensevoice')`). A source checkout seeds the
 * files from `models/` there; a published install lets the provider download
 * them once into the same cache.
 */
function resolveSttDataRoot() {
  return join(homeRoot(), 'speech-to-text', 'sensevoice')
}

function createLogger(dataRoot) {
  const directory = join(dataRoot, 'logs')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'live-captions.log')
  let writable = true
  try {
    if (statSync(file).size > LOG_LIMIT) appendFileSync(file, '')
  } catch {
    // file does not exist yet
  }
  return (message) => {
    const line = `${new Date().toISOString()} ${message}`
    if (writable) {
      try {
        appendFileSync(file, `${line}\n`)
      } catch {
        writable = false
      }
    }
    console.log(`[live-captions] ${message}`)
  }
}

const TOOL_NAME = 'live_captions'

/** JSON-schema for the single agent-facing tool. */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'stop', 'status', 'prepare', 'install_mt_deps', 'minutes', 'settings', 'records', 'models'],
      description: 'start/stop 控制实时字幕；status 读取状态；prepare 准备识别模型（首次使用会下载约 230 MB，通常无需手动触发）；install_mt_deps 下载内置离线翻译的依赖；minutes 生成会议纪要；settings 修改来源、语言、是否保留音频或浮层参数；records 查看历史字幕记录（按时分秒）；models 列出可用的云端大模型与离线模型。',
    },
    session: {
      type: 'string',
      description: 'records 动作要查看的会话 id（省略则取最新一次）。',
    },
    source: {
      type: 'string',
      enum: ['both', 'speaker', 'mic'],
      description: '音频来源：both=系统声音+麦克风，speaker=仅系统声音（扬声器），mic=仅麦克风。',
    },
    sourceLanguage: {
      type: 'string',
      description: '源语言提示：auto/zh/en/yue/ja/ko；auto 表示自动判断。',
    },
    targetLanguage: {
      type: 'string',
      description: '字幕目标语言，例如 zh、en、ja、ko。',
    },
    translate: {
      type: 'boolean',
      description: '是否把字幕翻译成目标语言。',
    },
    translateEngine: {
      type: 'string',
      enum: ['cloud', 'builtin', 'local'],
      description: '翻译引擎：cloud=云端大模型；builtin=离线多语种模型；local=本机 OpenAI 兼容服务（Ollama/LM Studio 等）。会议纪要始终用云端大模型。',
    },
    cloudProvider: {
      type: 'string',
      description: '云端翻译的模型提供方 id（见 action=models）；留空表示跟随 dsh 默认模型。',
    },
    cloudModel: {
      type: 'string',
      description: '云端翻译的模型 id（见 action=models）；留空表示跟随 dsh 默认模型。',
    },
    builtinModel: {
      type: 'string',
      description: '离线翻译模型 id：Xenova/m2m100_418M（多语种，600 MB）、Xenova/nllb-200-distilled-600M（中文更好，640 MB，CC-BY-NC）、Xenova/opus-mt-en-zh（英译中，90 MB）。',
    },
    localBaseUrl: {
      type: 'string',
      description: '本地模型的 OpenAI 兼容地址，例如 http://127.0.0.1:11434/v1（Ollama）。',
    },
    localModel: {
      type: 'string',
      description: '本地模型名，例如 qwen2.5:7b（Ollama）或你加载的模型 id。',
    },
    keepAudio: {
      type: 'boolean',
      description: '是否保留采集到的音频：开启后每段 WAV 留在该会话的 segments 目录（约 1.2 GB/小时），关闭时识别完立即删除。',
    },
    lyricFontSize: {
      type: 'number',
      description: '桌面歌词框字号（14–34，默认 22）。',
    },
    lyricOpacity: {
      type: 'number',
      description: '桌面歌词框透明度（0.3–1，默认 0.92）。',
    },
    lyricX: {
      type: 'number',
      description: '歌词框左边距像素（省略/重置时回到默认位置）。',
    },
    lyricY: {
      type: 'number',
      description: '歌词框上边距像素。',
    },
    lyricLocked: {
      type: 'boolean',
      description: '锁定歌词框：锁定后点击穿透，不会挡住界面。',
    },
    lyricVisible: {
      type: 'boolean',
      description: '是否显示桌面字幕浮层；关闭后字幕照常记录，只是不浮在屏幕上。',
    },
    lyricReset: {
      type: 'boolean',
      description: '重置歌词框位置与大小。',
    },
    lyricW: {
      type: 'number',
      description: '歌词框宽度像素（320 起；省略或传 null 表示按屏幕尺寸自动适配）。',
    },
    lyricH: {
      type: 'number',
      description: '歌词框高度像素（140 起；省略或传 null 表示按屏幕尺寸自动适配）。',
    },
    recordsX: {
      type: 'number',
      description: '记录弹窗左边距像素。',
    },
    recordsY: {
      type: 'number',
      description: '记录弹窗上边距像素。',
    },
    recordsW: {
      type: 'number',
      description: '记录弹窗宽度像素（默认 420）。',
    },
    recordsH: {
      type: 'number',
      description: '记录弹窗高度像素（默认 460）。',
    },
    title: {
      type: 'string',
      description: '生成会议纪要时可选的会议标题。',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

function summarize(state) {
  const lines = []
  const statusText = {
    idle: '未运行',
    preparing: '正在准备识别模型',
    starting: '正在启动采集',
    running: '正在采集',
    stopping: '正在停止',
    error: '出错',
  }[state.status] ?? state.status
  lines.push(`状态：${statusText}${state.error ? `（${state.error}）` : ''}`)
  lines.push(`识别：${state.asr.providerName ?? '未知'} / ${state.asr.phase}${state.asr.message ? `（${state.asr.message}）` : ''}`)
  lines.push(`来源：${state.settings.source}；源语言：${state.settings.sourceLanguage}；目标语言：${state.targetLabel}`)
  lines.push(`翻译：${state.engine?.label ?? '未知'}（会议纪要固定用云端大模型）`)
  if (state.mt && state.mt.state !== 'ready' && state.settings.translateEngine === 'builtin') {
    const progress = state.mt.progress ?? {}
    const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : null
    lines.push(`内置翻译模型：${state.mt.state}${percent === null ? '' : ` ${percent}%`}${state.mt.error ? `（${state.mt.error}）` : ''}`)
  }
  if (state.session !== null) {
    lines.push(`本次：${state.session.segments} 段 / ${state.totalEntries} 条字幕`)
  }
  if (state.entries.length > 0) {
    const recent = state.entries.slice(-6)
    lines.push('最近字幕：')
    for (const entry of recent) {
      lines.push(`- [${entry.at}] ${entry.text}${entry.translation ? ` → ${entry.translation}` : ''}`)
    }
  }
  if (state.minutes.error) lines.push(`纪要错误：${state.minutes.error}`)
  if (state.minutes.path) lines.push(`纪要文件：${state.minutes.path}`)
  return lines.join('\n')
}

export function apply(ctx, config) {
  const dataRoot = resolveDataRoot(config)
  const boot = []
  adoptLegacyDataRoot(dataRoot, (message) => boot.push(message))
  mkdirSync(dataRoot, { recursive: true })
  const log = createLogger(dataRoot)
  log(`plugin activated, dataRoot=${dataRoot}`)
  for (const message of boot) log(message)

  // The built-in translation dependency is installed on demand into this
  // package's own node_modules, so it must know where it lives (realpath so a
  // linked/pnpm install still resolves to the real directory).
  let packageDir = null
  try {
    packageDir = realpathSync(dirname(fileURLToPath(import.meta.url)))
  } catch (error) {
    log(`packageDir resolution failed: ${error.message}`)
  }

  // On macOS the capture and overlay helpers are Swift programs built once
  // from `native/` into the data root; other platforms use the PowerShell
  // helpers and this manager reports `supported: false`.
  const nativeBin = createNativeBin({ packageDir, cacheRoot: dataRoot, log })
  nativeBin.ensure?.('capture')?.then?.((result) => {
    if (result.ok === true) log(`native-bin: capture helper ready (${result.path})`)
    else if (nativeBin.supported) log(`native-bin: capture helper unavailable: ${result.error}`)
  })?.catch?.(() => {})
  nativeBin.ensure?.('overlay')?.then?.((result) => {
    if (result.ok === true) log(`native-bin: overlay helper ready (${result.path})`)
    else if (nativeBin.supported) log(`native-bin: overlay helper unavailable: ${result.error}`)
  })?.catch?.(() => {})

  const controller = new MeetingController({
    ctx,
    config: config ?? {},
    dataRoot,
    packageDir,
    sttDataRoot: resolveSttDataRoot(),
    log,
    nativeBin,
  })

  // The always-on-top overlay window is its own OS process (WPF via PowerShell
  // on Windows, an AppKit panel on macOS), so its availability and open state
  // flow into every state payload and the panel knows whether it can offer the
  // true "stays above everything" overlay.
  // Pre-build the overlay helper so a session start can open it synchronously.
  let nativeOverlayPath = null
  if (nativeBin.supported) {
    nativeBin.ensure('overlay').then((result) => {
      if (result.ok === true) {
        nativeOverlayPath = result.path
        log(`native-bin: overlay helper ready (${result.path})`)
      } else {
        log(`native-bin: overlay helper unavailable: ${result.error}`)
      }
    }).catch((error) => log(`native-bin: overlay helper build error: ${error.message}`))
  }

  const overlay = createOverlayManager({
    ctx,
    log,
    // The overlay process exiting IS "the user closed the overlay" (its close
    // button terminates it, and so does a crash). Persist lyricVisible: false
    // in that case so the web client never falls back to the in-page caption
    // box — "closed" must mean closed, not "switch to a different overlay".
    onState: () => {
      const described = overlay.describe()
      // A failure means the window could not run (spawn error / crash): keep
      // the in-page fallback alive. Only a clean exit — the close button —
      // counts as "the user closed the overlay".
      if (described.open !== true && !described.failure
        && controller.status === 'running'
        && controller.settings?.lyricVisible !== false) {
        controller.updateSettings({ lyricVisible: false })
      }
      controller.bump()
    },
    getNativeOverlay: () => nativeOverlayPath,
  })
  controller.overlayDescribe = () => overlay.describe()
  // Starting a session shows the overlay; the panel's switch can still hide it.
  controller.overlayOpen = () => overlay.open(controller.settings)

  // The recognition model is required, so its download starts as soon as the
  // plugin is active rather than on the first session.
  controller.prepareAsrInBackground()
  log(`overlay: always-on-top window ${overlay.describe().supported ? 'available' : 'unavailable (will fall back to PiP / in-app)'}`)

  ctx.effect(() => () => {
    log('plugin unloading')
    overlay.dispose()
    void controller.dispose()
  }, 'live-captions: controller')

  // Both the API and the agent tool depend on services that may not exist yet
  // during a cold boot; `ctx.inject` registers them as soon as each appears.
  ctx.inject(['webServer'], (scoped) => {
    const dispose = registerApi({ ctx: scoped, controller, overlay, log })
    scoped.effect(() => dispose, 'live-captions: api')
  })

  ctx.inject(['tools'], (scoped) => {
    const tools = scoped.tools
    const dispose = tools.register({
      name: TOOL_NAME,
      description: '控制本机实时多语言字幕：采集系统声音/麦克风、识别语音、翻译字幕、生成会议纪要。不传 action 之外的参数时沿用已保存的设置。',
      parameters: TOOL_PARAMETERS,
      timeoutMs: 180000,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            minutes: { type: 'string' },
            path: { type: 'string' },
          },
          required: ['ok', 'summary'],
        },
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: String(value?.summary ?? '') }]
          if (value?.minutes) blocks.push({ type: 'text', text: String(value.minutes) })
          if (value?.path) blocks.push({ type: 'text', text: `纪要文件：${value.path}` })
          return blocks
        },
      },
      execute: async (args) => {
        const input = args ?? {}
        const action = input.action
        if (action === 'settings') {
          controller.updateSettings({
            source: input.source,
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            translate: input.translate,
            translateEngine: input.translateEngine,
            cloudProvider: input.cloudProvider,
            cloudModel: input.cloudModel,
            builtinModel: input.builtinModel,
            localBaseUrl: input.localBaseUrl,
            localModel: input.localModel,
            keepAudio: input.keepAudio,
            lyricFontSize: input.lyricFontSize,
            lyricOpacity: input.lyricOpacity,
            lyricX: input.lyricX,
            lyricY: input.lyricY,
            lyricW: input.lyricW,
            lyricH: input.lyricH,
            lyricLocked: input.lyricLocked,
            lyricVisible: input.lyricVisible,
            lyricReset: input.lyricReset,
            recordsX: input.recordsX,
            recordsY: input.recordsY,
            recordsW: input.recordsW,
            recordsH: input.recordsH,
          })
          const state = controller.state(0)
          return { ok: true, summary: summarize(state) }
        }
        if (action === 'status') {
          const state = controller.state(0)
          return { ok: true, summary: summarize(state) }
        }
        if (action === 'prepare') {
          const result = controller.prepare()
          return { ok: result.ok !== false, summary: result.ok === false ? `准备失败：${result.error}` : `已开始准备识别模型（${result.providerId}），可从面板查看进度。` }
        }
        if (action === 'install_mt_deps') {
          const result = await controller.installMtDeps()
          return { ok: result.ok !== false, summary: result.ok === false ? `依赖下载失败：${result.error}` : (result.note ?? '内置翻译依赖已就绪。') }
        }
        if (action === 'models') {
          const cloud = await controller.listCloudModels()
          const offline = controller.offlineModels()
          const lines = ['云端可选：']
          if (cloud.error) lines.push(`- 读取失败：${cloud.error}`)
          else if ((cloud.providers ?? []).length === 0) lines.push('- 没有已注册的模型提供方')
          else {
            for (const provider of cloud.providers) {
              lines.push(`- ${provider.name}：${(provider.models ?? []).map((model) => model.id).join('、') || '（无模型）'}`)
            }
          }
          lines.push('', '离线可选：')
          for (const model of offline.models) {
            lines.push(`- ${model.id}（${model.label}，约 ${model.sizeMb} MB，${model.license}）${model.downloaded ? ' 已下载' : ''}${model.id === offline.active ? ' ← 当前' : ''}`)
          }
          lines.push('', `当前翻译引擎：${cloud.active?.label ?? '-'}`)
          return { ok: true, summary: lines.join('\n') }
        }
        if (action === 'start') {
          if (input.source || input.targetLanguage || input.sourceLanguage || input.translate !== undefined
            || input.translateEngine || input.localBaseUrl || input.localModel) {
            controller.updateSettings({
              source: input.source,
              sourceLanguage: input.sourceLanguage,
              targetLanguage: input.targetLanguage,
              translate: input.translate,
              translateEngine: input.translateEngine,
              localBaseUrl: input.localBaseUrl,
              localModel: input.localModel,
            })
          }
          const result = controller.start()
          return {
            ok: result.ok !== false,
            summary: result.ok === false
              ? `启动失败：${result.error}`
              : `已开始：${result.note ?? '正在准备识别模型，准备好后自动开始采集。'}\n\n${summarize(controller.state(0))}`,
          }
        }
        if (action === 'stop') {
          const result = await controller.stop()
          return { ok: result.ok !== false, summary: `已停止。\n\n${summarize(controller.state(0))}` }
        }
        if (action === 'records') {
          const sessions = controller.listSessions()
          const sessionId = typeof input.session === 'string' && input.session !== '' ? input.session : sessions[0]?.id
          if (sessionId === undefined) {
            return { ok: true, summary: '还没有任何字幕记录。' }
          }
          const records = controller.readRecords(sessionId).entries ?? []
          const head = records.slice(0, 30).map((row) => `[${row.time || '--:--:--'}] ${row.text}${row.translation && row.translation !== row.text ? `\n           ${row.translation}` : ''}`)
          const lines = [
            `会话 ${sessionId}：共 ${records.length} 条记录`,
            `历史会话：${sessions.map((entry) => `${entry.id}(${entry.entries})`).slice(0, 8).join('、') || '无'}`,
            records.length > 30 ? `（仅显示前 30 条，完整内容见记录页面）` : '',
            ...head,
          ].filter(Boolean)
          return { ok: true, summary: lines.join('\n'), path: `~/.dsh/live-captions/sessions/${sessionId}/transcript.jsonl` }
        }
        if (action === 'minutes') {
          const result = await controller.generateMinutes({ title: input.title })
          return {
            ok: true,
            summary: `已生成会议纪要并保存到 ${result.path}`,
            minutes: result.text,
            path: result.path,
          }
        }
        return { ok: false, summary: `未知操作：${String(action)}` }
      },
    }, {})
    scoped.effect(() => dispose, 'live-captions: tool')
  })
}
