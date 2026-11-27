// Testable core of the minutes auto-send flow (module scope so the offline
// interaction test can drive it without a real browser).
//
// Wire-first design, mirroring how the DSH shell itself chats:
//   1. `sessions.create({ workspaceId })` — one RPC; the Host creates the
//      new Session (and its Agent) immediately, no UI involvement.
//   2. `session.prompt([{type:'text',text}], 'queue')` through a retained
//      reference — this is the exact channel the chat composer uses
//      (Remote `session/prompt`); the Host accepts the prompt and starts
//      the turn even though no conversation view exists yet.
//   3. `workspace.openSession(newId)` — reveal the running session.
// No polling for slow windows, no composer draft, nothing to clear.
// Returns what happened instead of throwing.
async function runMinutesAutoSend(workspace, sessions, prompt) {
  // The workspace that owns the currently open session (fall back to the
  // most recently active one) so the new session lands in the right place.
  let workspaceId
  try {
    const items = workspace.workspaces.list.getSnapshot().items ?? []
    const current = workspace.mainReference?.sessionId
    workspaceId = (current !== undefined
      ? items.find((item) => (item.sessionIds ?? []).includes(current))
      : undefined)?.workspaceId
    if (workspaceId === undefined && items.length > 0) workspaceId = items[items.length - 1].workspaceId
  } catch { /* workspace lookup is best-effort; Host default applies */ }

  let newId
  try {
    newId = await sessions.create(workspaceId === undefined ? {} : { workspaceId })
  } catch (error) {
    return { ok: false, reason: 'create-failed', error: String(error?.message ?? error) }
  }

  const reference = sessions.retain(newId, { source: 'live-captions-minutes' })
  try {
    await reference.ready
    const result = await reference.binding.session.prompt(
      [{ type: 'text', text: prompt }], 'queue')
    if (result !== undefined && result.ok === false) {
      return { ok: false, reason: 'prompt-rejected', error: `${result.error?.code ?? ''}: ${result.error?.message ?? ''}` }
    }
  } catch (error) {
    return { ok: false, reason: 'prompt-failed', error: String(error?.message ?? error) }
  } finally {
    try { reference.release() } catch { /* already released */ }
  }

  try { workspace.openSession(newId) } catch { /* navigation is cosmetic; the prompt is already sent */ }
  return { ok: true, sessionId: newId }
}

if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  globalThis.__DSH_LIVE_CAPTIONS_TEST__ = { runMinutesAutoSend }
}

window.__ModuleLoader__.load({
  id: 'dsh-live-captions',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const NS = 'live-captions'
    const API = '/live-captions/api'

    const DICT = {
      en: {
        'title': 'Live captions',
        'subtitle': 'Speaker + microphone to subtitles and minutes',
        'start': 'Start',
        'stop': 'Stop',
        'prepare': 'Download model',
        'downloadModel': 'Download model (≈230 MB)',
        'firstRunHint': 'The recognition model is not bundled: it downloads in the background as soon as the plugin is active (about 230 MB, from hf-mirror in mainland China) and is cached on this machine. Audio is recognised locally and never uploaded.',
        'preparing': 'Preparing model',
        'downloadTitle': 'Downloading the speech recognition model',
        'downloadHint': 'About 230 MB, one time only. After that the audio is recognised on this machine — nothing is uploaded.',
        'minutes': 'Minutes',
        'minutesHint': 'Opens a new session and sends the minutes request automatically',
        'minutesAutoSendFailed': 'Auto-send failed; the prompt is filled in the composer — press Enter to send.',
        'minutesManualSend': 'The minutes prompt is ready in a new session — press Enter to send.',
        'minutesNoSession': 'Could not open a session directly; the prompt is on your clipboard.',
        'generating': 'Writing minutes…',
        'copy': 'Copy',
        'copied': 'Copied',
        'close': 'Close',
        'open': 'Open live captions',
        'source': 'Audio source',
        'source.both': 'System audio + mic',
        'source.speaker': 'System audio',
        'source.mic': 'Microphone',
        'spoken': 'Source language',
        'target': 'Target language',
        'tagSource': 'Source',
        'tagTarget': 'Translation',
        'records': 'Records',
        'liveWindow': 'Live transcript',
        'transcriptDetached': 'Shown in its own window — press ⧉ to bring it back.',
        'moreSettings': 'More options',
        'recordsTitle': 'Caption records',
        'recordsEmpty': 'No records yet.',
        'recordsPick': 'Session',
        'copyAll': 'Copy all',
        'deleteRecord': 'Delete session',
        'deleteCurrent': 'Delete this session (current)',
        'confirmDelete': 'Confirm delete?',
        'fontSize': 'Size',
        'opacity': 'Opacity',
        'lock': 'Lock',
        'unlock': 'Unlock',
        'resetPos': 'Reset position',
        'lockedHint': 'Locked: click-through, unlock from the panel.',
        'overlay': 'Desktop overlay',
        'overlayIdle': 'Overlay ready — captions appear once capture starts.',
        'pipUnavailable': 'This window cannot float above other apps; the overlay stays inside the app.',
        'pipHint': 'Shown in its own always-on-top window; flip the switch to close it.',
        'overlayOsHint': 'In a system always-on-top window — it stays visible even when this app is minimised.',
        'collapse': 'Collapse',
        'expand': 'Expand',
        'overlayOff': 'Hidden — captions keep recording; turn it back on here.',
        'hideOverlay': 'Hide overlay',
        'dragHint': 'Drag to move',
        'resize': 'Resize',
        'backToLive': 'Back to live',
        'lang.auto': 'Auto detect',
        'lang.zh': 'Chinese',
        'lang.en': 'English',
        'lang.yue': 'Cantonese',
        'lang.ja': 'Japanese',
        'lang.ko': 'Korean',
        'lang.es': 'Spanish',
        'lang.fr': 'French',
        'lang.de': 'German',
        'lang.ru': 'Russian',
        'lang.pt': 'Portuguese',
        'translate': 'Translate',
        'translateOff': 'Translation is off: subtitles stay in the spoken language.',
        'engine': 'Translation engine',
        'engine.cloud': 'Cloud LLM',
        'engine.builtin': 'Offline model',
        'engine.local': 'Local server',
        'cloudModel': 'Model',
        'followDefault': 'Follow the dsh default',
        'modelsLoading': 'Loading the model list…',
        'modelsFailed': 'Could not load the model list',
        'offlineModel': 'Offline model',
        'downloaded': 'downloaded',
        'download': 'Download',
        'loading': 'Loading',
        'loaded': 'Loaded',
        'cancel': 'Cancel',
        'depsMissing': 'The built-in runtime (@huggingface/transformers) is not installed.',
        'mtPreparing': 'Preparing the built-in translation model',
        'mtFailed': 'Built-in model unavailable',
        'retry': 'Retry',
        'downloadDeps': 'Download dependency',
        'localUrl': 'Endpoint',
        'localModel': 'Model',
        'localHint': 'Ollama: http://127.0.0.1:11434/v1 · LM Studio: http://127.0.0.1:1234/v1',
        'engineLocalNote': 'You start this server yourself (Ollama/LM Studio/vLLM); the plugin ships no model weights. Subtitles only — minutes still use the cloud model.',
        'keepAudio': 'Keep audio',
        'keepAudioHint': 'Every segment stays as a WAV in this session\'s segments folder (about 1.2 GB per hour). Off, the audio is deleted as soon as it has been recognised.',
        'listening': 'Listening…',
        'noCaptions': 'Captions appear here as people speak.',
        'transcript': 'Transcript',
        'emptyTranscript': 'Nothing recognised yet.',
        'status.idle': 'Idle',
        'status.preparing': 'Preparing model',
        'status.starting': 'Starting capture',
        'status.running': 'Capturing',
        'status.stopping': 'Stopping',
        'status.error': 'Error',
        'minutesEmpty': 'Generate a summary when the meeting ends.',
        'minutesPath': 'File',
        'segments': 'segments',
        'lines': 'lines',
        'translationFailed': 'Translation failed',
      },
      zh: {
        'title': '实时字幕',
        'subtitle': '系统声音与麦克风实时转写、翻译并生成纪要',
        'start': '开始',
        'stop': '停止',
        'prepare': '下载识别模型',
        'downloadModel': '下载识别模型（约 230 MB）',
        'firstRunHint': '识别模型不在安装包里：插件启用后会在后台自动下载约 230 MB（国内走 hf-mirror），之后本机缓存、不再联网；语音在本机识别，音频不会上传。',
        'preparing': '正在准备模型',
        'downloadTitle': '正在下载语音识别模型',
        'downloadHint': '约 230 MB，只需要下载这一次；之后语音在这台机器上识别，不联网也不上传。',
        'minutes': '生成纪要',
        'minutesHint': '自动新建会话并发送纪要请求',
        'minutesAutoSendFailed': '自动发送失败，内容已填入输入框，请按回车发送。',
        'minutesManualSend': '已在新会话准备好纪要内容，请按回车发送。',
        'minutesNoSession': '无法直接打开新会话，提示词已复制到剪贴板。',
        'generating': '正在生成纪要…',
        'copy': '复制',
        'copied': '已复制',
        'close': '关闭',
        'open': '打开实时字幕',
        'source': '音频来源',
        'source.both': '系统声音 + 麦克风',
        'source.speaker': '系统声音',
        'source.mic': '麦克风',
        'spoken': '源语言',
        'target': '目标语言',
        'tagSource': '原文',
        'tagTarget': '译文',
        'records': '记录',
        'liveWindow': '实时转写',
        'transcriptDetached': '已在独立窗口显示；点 ⧉ 收回面板。',
        'moreSettings': '更多设置',
        'recordsTitle': '字幕记录',
        'recordsEmpty': '还没有记录。',
        'recordsPick': '会话',
        'copyAll': '复制全部',
        'deleteRecord': '删除此会话',
        'deleteCurrent': '删除此会话（当前）',
        'confirmDelete': '确认删除？',
        'fontSize': '字号',
        'opacity': '透明度',
        'lock': '锁定',
        'unlock': '解锁',
        'resetPos': '重置位置',
        'lockedHint': '已锁定：可点击穿透，在面板里解锁。',
        'overlay': '字幕桌面浮层',
        'overlayIdle': '浮层已就绪，开始采集后显示字幕。',
        'pipUnavailable': '当前窗口无法浮在其他应用之上，浮层只能留在应用内。',
        'pipHint': '浮层已放到独立的置顶窗口；关闭开关即可收回。',
        'overlayOsHint': '已在系统置顶窗口显示——最小化本应用也会继续显示。',
        'collapse': '折叠',
        'expand': '展开',
        'overlayOff': '已隐藏，字幕仍在记录；需要时在这里重新打开。',
        'hideOverlay': '隐藏浮层',
        'dragHint': '拖动可移动',
        'resize': '调整大小',
        'backToLive': '回到最新',
        'lang.auto': '自动识别',
        'lang.zh': '中文',
        'lang.en': '英文',
        'lang.yue': '粤语',
        'lang.ja': '日文',
        'lang.ko': '韩文',
        'lang.es': '西班牙文',
        'lang.fr': '法文',
        'lang.de': '德文',
        'lang.ru': '俄文',
        'lang.pt': '葡萄牙文',
        'translate': '翻译字幕',
        'translateOff': '未开启翻译：字幕只显示识别到的原文。',
        'engine': '翻译引擎',
        'engine.cloud': '云端大模型',
        'engine.builtin': '离线模型',
        'engine.local': '本地推理服务',
        'cloudModel': '模型',
        'followDefault': '跟随 dsh 默认模型',
        'modelsLoading': '正在读取模型列表…',
        'modelsFailed': '读取模型列表失败',
        'offlineModel': '离线模型',
        'downloaded': '已下载',
        'download': '下载',
        'loading': '加载中',
        'loaded': '已加载',
        'cancel': '取消',
        'depsMissing': '内置推理依赖（@huggingface/transformers）未安装。',
        'mtPreparing': '正在准备内置翻译模型',
        'mtFailed': '内置模型不可用',
        'retry': '重试',
        'downloadDeps': '下载依赖',
        'localUrl': '服务地址',
        'localModel': '模型名',
        'localHint': 'Ollama：http://127.0.0.1:11434/v1 · LM Studio：http://127.0.0.1:1234/v1',
        'engineLocalNote': '需要你自己启动这个服务（Ollama/LM Studio/vLLM），插件不自带模型权重；只负责字幕翻译，纪要仍用云端。',
        'keepAudio': '保留音频',
        'keepAudioHint': '每段音频保存成 WAV，留在该会话的 segments 目录里（约 1.2 GB/小时）；关闭时识别完立即删除。',
        'listening': '正在聆听…',
        'noCaptions': '有人说话时字幕会显示在这里。',
        'transcript': '转写记录',
        'emptyTranscript': '还没有识别到内容。',
        'status.idle': '未运行',
        'status.preparing': '准备模型中',
        'status.starting': '正在启动',
        'status.running': '正在采集',
        'status.stopping': '正在停止',
        'status.error': '出错',
        'minutesEmpty': '会议结束后可以一键生成纪要。',
        'minutesPath': '文件',
        'segments': '段音频',
        'lines': '条字幕',
        'translationFailed': '翻译失败',
      },
    }

    const TARGET_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'yue', 'es', 'fr', 'de', 'ru', 'pt']
    const SOURCE_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']
    const LYRIC_RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

    function localeId(ctx) {
      try {
        const snapshot = ctx.locale.getLocale()
        const id = snapshot?.active ?? snapshot?.id ?? snapshot?.locale ?? 'en'
        return String(id).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    function useLanguage(ctx) {
      const [id, setId] = useState(() => localeId(ctx))
      useEffect(() => {
        const update = () => setId(localeId(ctx))
        update()
        let dispose = () => {}
        try {
          dispose = ctx.locale.subscribe(update) ?? (() => {})
        } catch {
          // locale service unavailable: keep the initial id
        }
        return () => { try { dispose() } catch { /* ignore */ } }
      }, [ctx])
      return id
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '00:00:00'
      const total = Math.floor(ms / 1000)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
    }

    /** "2026-11-20 21:31:00" for a session picker row. */
    function formatClock(value) {
      const ms = typeof value === 'number' ? value : Date.parse(value)
      if (!Number.isFinite(ms)) return null
      const date = new Date(ms)
      const pad = (part) => String(part).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Compact length like 45s / 30m / 1h05m for a session picker row. */
    function formatDurationShort(ms) {
      if (!Number.isFinite(ms) || ms < 0) return null
      const total = Math.round(ms / 1000)
      if (total < 60) return `${total}s`
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return `${minutes}m`
      return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
    }

    /** Dropdown label: start time, how long it ran, how many lines. */
    function sessionLabel(session, unit) {
      const clock = formatClock(session.startedAt) ?? String(session.id ?? '')
      const length = formatDurationShort(session.durationMs) ?? '0m'
      const count = session.entries ? ` · ${session.entries}${unit ? ` ${unit}` : ''}` : ''
      return `${clock} · ${length}${count}`
    }

    /** Escape text for the hand-built Picture-in-Picture markup. */
    function escapeText(value) {
      return String(value ?? '').replace(/[&<>"]/g, (char) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]
      ))
    }

    // The desktop overlay lives in a separate, always-on-top window; that window
    // has its own document, so the theme tokens have to be copied into it.
    const THEME_TOKENS = [
      '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
      '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
      '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
      '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
      '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
      '--dsw-specific-sidebar-fill',
    ]

    /**
     * First-run overlay size. Derived from the subtitle font size so the box
     * shows two full bilingual pairs with the next one peeking in, and capped
     * so it stays a subtitle strip: the width follows a readable line length
     * (~34 CJK characters), not a share of the screen.
     *
     * Height budget: 10 top pad + 31 tool row + 6 flex gap + entries + 10 bottom
     * pad, where one pair is source (0.72x at 1.4) + target (1.45) + 3 gap
     * + 8 padding + 1 border, and pairs sit 12px apart.
     */
    function autoLyricSize(fontSize, viewportW, viewportH) {
      const size = Number.isFinite(fontSize) ? fontSize : 22
      const pair = size * 2.46 + 12
      const entries = pair * 2.5 + 12
      return {
        w: Math.round(Math.min(880, Math.max(560, size * 34), viewportW * 0.82)),
        h: Math.round(Math.min(360, Math.max(190, 58 + entries), viewportH * 0.5)),
      }
    }

    /**
     * Default resting place for an unpositioned box: horizontally centred, a
     * fixed fraction up from the bottom so it clears the composer on a short
     * window without hugging the bottom edge on a tall one.
     */
    function autoLyricBottom(viewportH) {
      const height = Number.isFinite(viewportH) ? viewportH : 800
      return Math.round(Math.min(180, Math.max(88, height * 0.12)))
    }

    /**
     * Pure geometry for an edge drag: the next box rect for `dir` ('n','se',…).
     * West and north drags keep the opposite edge anchored — x + w (or y + h)
     * stays constant — and no drag can push the box outside the viewport.
     */
    function resizeLyricBox(state, dir, dx, dy, bounds) {
      let w = state.w0
      let h = state.h0
      let x = state.x0
      let y = state.y0
      if (dir.includes('e')) {
        // The right edge only has the space between the left edge and the screen.
        const maxW = Math.min(bounds.maxW, bounds.viewportW - 8 - state.x0)
        w = Math.min(maxW, Math.max(bounds.minW, state.w0 + dx))
      }
      if (dir.includes('w')) {
        const maxW = Math.min(bounds.maxW, state.x0 + state.w0 - 8)
        w = Math.min(maxW, Math.max(bounds.minW, state.w0 - dx))
        x = state.x0 + (state.w0 - w)
      }
      if (dir.includes('s')) {
        const maxH = Math.min(bounds.maxH, bounds.viewportH - 8 - state.y0)
        h = Math.min(maxH, Math.max(bounds.minH, state.h0 + dy))
      }
      if (dir.includes('n')) {
        const maxH = Math.min(bounds.maxH, state.y0 + state.h0 - 8)
        h = Math.min(maxH, Math.max(bounds.minH, state.h0 - dy))
        y = state.y0 + (state.h0 - h)
      }
      return { x, y, w, h }
    }

    function statusColor(status) {
      if (status === 'running') return 'var(--dsw-alias-state-success-primary)'
      if (status === 'error') return 'var(--dsw-alias-state-error-primary)'
      if (status === 'preparing' || status === 'starting') return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-idle-primary)'
    }

    const styles = `
.mc-root{position:fixed;inset:0;pointer-events:none;font-family:inherit}
.mc-line{display:flex;align-items:baseline;gap:8px;text-align:left;max-width:100%}
.mc-line-text{min-width:0;overflow-wrap:anywhere}
.mc-line-source{font-size:16px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.mc-line-target{font-size:19px;line-height:1.45;font-weight:600;color:var(--dsw-alias-label-primary)}
.mc-lyric{position:fixed;z-index:5;pointer-events:auto;
  box-sizing:border-box;
  display:flex;flex-direction:column;gap:6px;padding:10px 14px;border-radius:12px;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);
  box-shadow:0 10px 28px rgba(0,0,0,.18);cursor:grab;user-select:none}
.mc-lyric:active{cursor:grabbing}
.mc-lyric-locked{pointer-events:none;cursor:default;border-style:dashed}
.mc-lyric-tools{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding-bottom:6px;
  border-bottom:1px solid var(--dsw-alias-border-l1);pointer-events:auto;flex:0 0 auto}
.mc-lyric-tool{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;
  min-width:26px;height:24px;padding:0 6px;border-radius:6px;border:1px solid transparent;
  background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.mc-lyric-tool:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.mc-lyric-tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mc-lyric-tool-close{margin-left:auto;font-size:14px;line-height:1;padding-bottom:2px}
.mc-lyric-body{display:flex;flex-direction:column;gap:12px;min-height:0;flex:1 1 auto;
  overflow-y:auto;overflow-x:hidden;padding-right:4px;overscroll-behavior:contain}
.mc-lyric-entry{display:grid;grid-template-columns:auto 1fr;gap:8px;padding-bottom:8px;
  border-bottom:1px dashed var(--dsw-alias-border-l1)}
.mc-lyric-entry:last-child{border-bottom:0;padding-bottom:0}
.mc-lyric-time{font-size:calc(var(--mc-lyric-size,22px) * 0.45);line-height:1.4;padding-top:2px;
  color:var(--dsw-alias-label-secondary);opacity:.75;font-variant-numeric:tabular-nums;white-space:nowrap}
.mc-lyric-lines{display:flex;flex-direction:column;gap:3px;min-width:0}
.mc-lyric .mc-line-source{font-size:calc(var(--mc-lyric-size,22px) * 0.72);line-height:1.4;
  color:var(--dsw-alias-label-secondary);opacity:.85}
.mc-lyric .mc-line-target{font-size:var(--mc-lyric-size,22px);line-height:1.45;font-weight:600;
  color:var(--dsw-alias-label-primary)}
.mc-lyric-resize{position:absolute;z-index:2;pointer-events:auto;background:transparent}
.mc-lyric-resize-n{top:0;left:12px;right:12px;height:5px;cursor:n-resize}
.mc-lyric-resize-s{bottom:0;left:12px;right:12px;height:5px;cursor:s-resize}
.mc-lyric-resize-e{top:12px;bottom:12px;right:0;width:5px;cursor:e-resize}
.mc-lyric-resize-w{top:12px;bottom:12px;left:0;width:5px;cursor:w-resize}
.mc-lyric-resize-ne{top:0;right:0;width:12px;height:12px;cursor:ne-resize}
.mc-lyric-resize-nw{top:0;left:0;width:12px;height:12px;cursor:nw-resize}
.mc-lyric-resize-se{bottom:0;right:0;width:12px;height:12px;cursor:se-resize}
.mc-lyric-resize-sw{bottom:0;left:0;width:12px;height:12px;cursor:sw-resize}
.mc-lyric-badge{position:absolute;left:8px;top:-9px;font-size:10px;line-height:1.6;padding:0 6px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);pointer-events:auto;cursor:pointer}
.mc-record-window{position:fixed;z-index:30;display:flex;flex-direction:column;min-width:320px;min-height:240px;
  border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.28);pointer-events:auto;overflow:hidden}
.mc-records-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);
  cursor:grab;flex:0 0 auto}
.mc-records-head:active{cursor:grabbing}
.mc-records-title{font-size:14px;font-weight:600;flex:0 0 auto}
.mc-records-list{flex:1 1 auto;overflow:auto;padding:8px 14px 14px;display:flex;flex-direction:column;gap:8px;min-height:0}
.mc-window-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;pointer-events:auto;
  background:linear-gradient(135deg,transparent 46%,var(--dsw-alias-border-l2) 46%,var(--dsw-alias-border-l2) 58%,transparent 58%)}
.mc-record{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mc-record-time{flex:0 0 68px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.mc-record-texts{display:flex;flex-direction:column;gap:3px;min-width:0}
.mc-record-src{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.mc-record-tr{font-size:13.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.mc-records-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.mc-dock{position:absolute;right:18px;bottom:18px;display:flex;flex-direction:column;align-items:flex-end;gap:9px}
.mc-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;
  border-radius:17px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);
  color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.18)}
.mc-pill:hover{border-color:var(--dsw-alias-border-l2)}
.mc-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mc-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.mc-bar{display:inline-flex;align-items:flex-end;gap:2px;height:11px;margin-left:1px}
.mc-bar > i{display:block;width:2.5px;border-radius:2px;background:var(--dsw-alias-state-success-primary);
  transform-origin:bottom;animation:mc-level 1.05s ease-in-out infinite}
.mc-bar > i:nth-child(1){height:4px;animation-delay:0s}
.mc-bar > i:nth-child(2){height:10px;animation-delay:.14s}
.mc-bar > i:nth-child(3){height:6px;animation-delay:.3s}
.mc-bar > i:nth-child(4){height:8px;animation-delay:.44s}
@keyframes mc-level{0%,100%{transform:scaleY(.55)}50%{transform:scaleY(1)}}
@keyframes mc-pulse{0%,100%{box-shadow:0 0 0 3px rgba(62,207,142,.16)}50%{box-shadow:0 0 0 6px rgba(62,207,142,.05)}}
.mc-timer{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mc-cap{font-size:10.5px;letter-spacing:.07em;color:var(--dsw-alias-label-secondary);opacity:.82}

.mc-panel{pointer-events:auto;width:400px;max-height:min(74vh,660px);display:flex;flex-direction:column;
  border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);overflow:hidden;box-shadow:0 20px 54px rgba(0,0,0,.32)}
.mc-head{display:flex;align-items:center;gap:7px;height:38px;padding:0 8px 0 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.mc-head-title{font-size:13px;font-weight:600;white-space:nowrap;flex:0 0 auto}
.mc-head-status{font-size:11px;color:var(--dsw-alias-label-secondary);flex:1 1 auto;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-head .mc-timer{padding-left:6px}
.mc-toggle{pointer-events:auto;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;
  border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font-size:11.5px;font-family:inherit;cursor:pointer;flex:0 0 auto}
.mc-toggle:hover:not([disabled]){border-color:var(--dsw-alias-label-secondary)}
.mc-toggle[disabled]{opacity:.5;cursor:not-allowed}
.mc-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mc-toggle-mark{width:7px;height:7px;border-radius:1.5px;background:var(--dsw-alias-state-error-primary);flex:0 0 auto}
.mc-start{pointer-events:auto;height:24px;padding:0 10px;border-radius:6px;border:1px solid transparent;
  background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-size:11.5px;font-weight:600;
  font-family:inherit;cursor:pointer;flex:0 0 auto}
.mc-start:hover:not([disabled]){opacity:.88}
.mc-start[disabled]{opacity:.5;cursor:not-allowed}
.mc-start:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mc-icon-btn{pointer-events:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;font-size:15px;line-height:1;padding:4px 5px;border-radius:6px;flex:0 0 auto}
.mc-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mc-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mc-icon-btn[disabled]{opacity:.45;cursor:not-allowed}

.mc-body{padding:12px 12px 0;display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;min-height:0}
.mc-alerts{display:flex;flex-direction:column;gap:6px;padding-bottom:2px}
.mc-grp{display:flex;flex-direction:column;gap:7px}
.mc-grp + .mc-grp{margin-top:11px;padding-top:11px;border-top:1px solid var(--dsw-alias-border-l1)}
.mc-irow{display:flex;align-items:center;gap:8px;min-width:0}
.mc-irow .mc-lbl{font-size:12px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.mc-irow .mc-lbl-strong{font-size:12.5px;color:var(--dsw-alias-label-primary);flex:0 0 auto}
.mc-irow .mc-note{font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.85;margin-left:auto;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-seg{display:flex;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:2.5px;gap:2px}
.mc-seg > button{pointer-events:auto;flex:1 1 0;height:24px;min-width:0;padding:0 4px;border:0;border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-family:inherit;
  cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-seg > button:hover:not([aria-pressed="true"]){color:var(--dsw-alias-label-primary)}
.mc-seg > button[aria-pressed="true"]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  box-shadow:0 1px 2px rgba(0,0,0,.18)}
.mc-seg > button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mc-sw{pointer-events:auto;position:relative;width:34px;height:19px;flex:0 0 auto;padding:0;border:0;
  border-radius:10px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s;margin-left:auto}
.mc-sw::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;
  background:var(--dsw-alias-label-primary);transition:left .15s,background .15s,opacity .15s;opacity:.92}
.mc-sw[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.mc-sw[aria-checked="true"]::after{left:17px;background:#fff}
.mc-sw:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}

.mc-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px}
.mc-list{display:flex;flex-direction:column;max-height:236px;overflow-y:auto;overflow-x:hidden;padding-right:2px}
.mc-tr-row{display:grid;grid-template-columns:40px 1fr;gap:9px;padding:6px 0;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.mc-tr-row:last-child{border-bottom:0}
.mc-tr-t{font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;
  padding-top:3px;opacity:.9}
.mc-tr-body{min-width:0}
.mc-tr-src{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.mc-tr-tr{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);margin-top:1px;overflow-wrap:anywhere}
.mc-tr-live .mc-tr-t{color:var(--dsw-alias-state-success-primary)}
.mc-tr-pending{opacity:.6}

.mc-foot{display:flex;gap:6px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1);
  flex:0 0 auto;margin-top:11px;background:var(--dsw-alias-bg-layer-1)}
.mc-fbtn{pointer-events:auto;flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:5px;
  height:29px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;
  color:var(--dsw-alias-label-primary);font-size:11.5px;font-family:inherit;cursor:pointer}
.mc-fbtn:hover:not([disabled]){background:var(--dsw-alias-bg-layer-2)}
.mc-fbtn[disabled]{opacity:.45;cursor:not-allowed}
.mc-fbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mc-fbtn.icon{flex:0 0 36px;font-size:13px}
.mc-fbtn[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2)}

.mc-select{pointer-events:auto;height:29px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;
  padding:0 6px;width:100%;font-family:inherit}
.mc-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mc-irow .mc-select{width:148px;flex:0 0 148px;margin-left:auto}
.mc-irow .mc-select.grow{width:100%;flex:1 1 auto;margin-left:0}
.mc-spin{width:13px;height:13px;flex:0 0 auto;border-radius:50%;
  border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);
  animation:mc-spin .8s linear infinite}
@keyframes mc-spin{to{transform:rotate(360deg)}}
.mc-ok{flex:0 0 auto;font-size:14px;line-height:1;color:var(--dsw-alias-state-success-primary)}
.mc-pct{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mc-input{pointer-events:auto;height:29px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 8px;
  width:100%;box-sizing:border-box;font-family:inherit}
.mc-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mc-progress{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;flex:0 0 auto}
.mc-progress > span{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s}
/* First-run model download: a small card instead of a bare bar, so a background
   download is something the user can read and not just a floored progress line. */
.mc-download{pointer-events:none;display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.mc-download-head{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dsw-alias-label-primary)}
.mc-download-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-download-pct{flex:0 0 auto;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.mc-download .mc-progress{width:100%}
.mc-download-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.mc-pill-progress{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mc-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.55;overflow-wrap:anywhere}
.mc-error{font-size:11px;color:var(--dsw-alias-state-error-primary);line-height:1.55;overflow-wrap:anywhere}
.mc-warn{font-size:11px;color:var(--dsw-alias-state-warn-primary);line-height:1.55;overflow-wrap:anywhere}
.mc-section-title{font-size:10.5px;letter-spacing:.07em;color:var(--dsw-alias-label-secondary);
  display:flex;gap:8px;align-items:center;justify-content:space-between}
.mc-minutes{white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:12px;line-height:1.55;
  margin:0;padding:9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);max-height:220px;overflow:auto;
  color:var(--dsw-alias-label-primary)}
.mc-empty{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:6px 0}
.mc-advanced{display:flex;flex-direction:column;gap:9px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1);margin-top:11px}
/* Generic utilities kept for the advanced section, which stacks label over control. */
.mc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mc-field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);flex:1 1 0;min-width:0}
.mc-ghost-btn{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:29px;padding:0 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);
  background:transparent;color:var(--dsw-alias-label-primary);font-size:11.5px;font-family:inherit;
  cursor:pointer;flex:0 0 auto;white-space:nowrap}
.mc-ghost-btn:hover:not([disabled]){background:var(--dsw-alias-bg-layer-2)}
.mc-ghost-btn[disabled]{opacity:.45;cursor:not-allowed}
.mc-ghost-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mc-advanced .mc-ghost-btn{align-self:flex-start}
@media (max-width:1100px){
  .mc-dock{bottom:184px}
}
@media (max-width:720px){
  .mc-lyric{max-width:88vw;min-width:240px}
  .mc-panel{width:min(92vw,400px);max-height:min(62vh,520px)}
  .mc-fbtn{flex:1 1 auto}
  .mc-records{inset:2vh 2vw}
}
`

    function TextField(props) {
      const { value, placeholder, onCommit, ariaLabel } = props
      const [draft, setDraft] = useState(value ?? '')
      useEffect(() => {
        setDraft(value ?? '')
      }, [value])
      return h('input', {
        className: 'mc-input',
        type: 'text',
        value: draft,
        placeholder,
        'aria-label': ariaLabel,
        onChange: (event) => setDraft(event.target.value),
        onBlur: () => {
          const next = draft.trim()
          if (next !== (value ?? '')) onCommit(next)
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(value ?? '')
        },
      })
    }

    function Overlay(props) {
      const { ctx } = props
      const lang = useLanguage(ctx)
      const dict = DICT[lang] ?? DICT.en
      const t = useCallback((key) => dict[key] ?? DICT.en[key] ?? key, [dict])

      const [state, setState] = useState(null)
      const [entries, setEntries] = useState([])
      const [open, setOpen] = useState(false)
      const [recordsOpen, setRecordsOpen] = useState(false)
      // Detached live-transcript window; shares the records geometry on purpose
      // so only one of the two is on screen at a time.
      const [liveOpen, setLiveOpen] = useState(false)
      // A detached, always-on-top window is the overlay's preferred home.
      const [pipActive, setPipActive] = useState(false)
      // The live transcript starts folded: the overlay is where the captions are
      // read, and the panel stays a compact control surface.
      const [transcriptCollapsed, setTranscriptCollapsed] = useState(true)
      const [showAdvanced, setShowAdvanced] = useState(false)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [copied, setCopied] = useState(false)
      // Two-step confirm for deleting the selected records session.
      const [deleteArmed, setDeleteArmed] = useState(false)
      const deleteArmRef = useRef(null)
      const sinceRef = useRef(0)
      const sessionRef = useRef(null)
      const aliveRef = useRef(true)
      const listRef = useRef(null)
      const liveListRef = useRef(null)
      const pipRef = useRef(null)
      // "Follow the newest line" is a per-list sticky decision: it stays on until
      // the reader scrolls up, and any content change re-pins the view.
      const listPinnedRef = useRef(true)
      const livePinnedRef = useRef(true)

      // Keep the transcript pinned to the newest line; a new poll, a late
      // translation or a taller row all count as "something changed".
      useEffect(() => {
        const list = listRef.current
        if (list === null || !listPinnedRef.current) return
        list.scrollTop = list.scrollHeight
      }, [entries])

      // The detached window follows the newest line the same way.
      useEffect(() => {
        const list = liveListRef.current
        if (list === null || !livePinnedRef.current) return
        list.scrollTop = list.scrollHeight
      }, [entries, liveOpen])

      // Escape closes the records pop-up first, then the panel; only one of the
      // two responds so the other stays open underneath.
      useEffect(() => {
        if (!open && !recordsOpen && !liveOpen) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (liveOpen) setLiveOpen(false)
          else if (recordsOpen) setRecordsOpen(false)
          else setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open, recordsOpen, liveOpen])

      const applyState = useCallback((next) => {
        if (!next) return
        const sessionId = next.session?.id ?? null
        if (sessionRef.current !== sessionId) {
          sessionRef.current = sessionId
          sinceRef.current = 0
          setEntries([])
        }
        const fresh = Array.isArray(next.entries) ? next.entries : []
        const touched = Array.isArray(next.recent) ? next.recent : []
        if (fresh.length > 0 || touched.length > 0) {
          if (fresh.length > 0) {
            const maxSeq = fresh.reduce((top, entry) => Math.max(top, entry.seq), 0)
            sinceRef.current = Math.max(sinceRef.current, maxSeq)
          }
          setEntries((previous) => {
            const merged = new Map(previous.map((entry) => [entry.seq, entry]))
            for (const entry of fresh) merged.set(entry.seq, entry)
            for (const entry of touched) merged.set(entry.seq, { ...merged.get(entry.seq), ...entry })
            return [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-300)
          })
        }
        setState(next)
      }, [])

      const reset = useCallback(() => {
        sinceRef.current = 0
        sessionRef.current = null
        setEntries([])
      }, [])

      useEffect(() => {
        aliveRef.current = true
        let timer = null
        const tick = async () => {
          if (!aliveRef.current) return
          let delay = 1200
          try {
            const response = await fetch(`${API}/state?since=${sinceRef.current}`, { headers: { accept: 'application/json' } })
            if (response.ok) {
              const payload = await response.json()
              if (aliveRef.current && payload?.ok) {
                applyState(payload.state)
                if (payload.state?.status === 'running') delay = 400
                else if (payload.state?.status === 'preparing' || payload.state?.status === 'starting') delay = 1200
                else delay = 4000
              }
            } else {
              delay = 5000
            }
          } catch {
            delay = 5000
          }
          if (aliveRef.current) timer = setTimeout(tick, delay)
        }
        void tick()
        return () => {
          aliveRef.current = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [applyState])

      const command = useCallback(async (body) => {
        setBusy(body.action)
        setNotice('')
        try {
          const response = await fetch(`${API}/command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, since: sinceRef.current }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload?.ok === false) {
            setNotice(payload?.error ?? `请求失败（${response.status}）`)
          } else {
            if (body.action === 'clear' || body.action === 'delete_session') reset()
            if (payload.state) applyState(payload.state)
          }
          return payload
        } catch (error) {
          setNotice(String(error?.message ?? error))
          return null
        } finally {
          setBusy('')
        }
      }, [applyState, reset])

      const copyMinutes = useCallback(async () => {
        const text = state?.minutes?.text ?? ''
        if (text === '') return
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          setNotice(t('copy'))
        }
      }, [state, t])

      // Desktop-lyrics box state: drag position, size, scroll follow, records window.
      const [lyricPos, setLyricPos] = useState(null)
      const [lyricSize, setLyricSize] = useState(null)
      const [pinned, setPinned] = useState(true)
      const [recordsData, setRecordsData] = useState(null)
      const [recordsGeom, setRecordsGeom] = useState(null)
      // Cloud routes and the offline catalog, fetched once from the Host.
      const [catalog, setCatalog] = useState(null)
      const lyricRef = useRef(null)
      const lyricBodyRef = useRef(null)
      const pinnedRef = useRef(true)
      const dragRef = useRef(null)
      const resizeRef = useRef(null)
      const recordsMoveRef = useRef(null)
      const recordsGrowRef = useRef(null)

      const save = useCallback((patch) => command({ action: 'settings', settings: patch }), [command])

      /**
       * "Generate minutes" creates a fresh Session over the wire, sends the
       * transcript plus minutes prompt into it through the same Remote
       * `session/prompt` channel the chat composer uses (see
       * runMinutesAutoSend at module scope), and then reveals the session —
       * the AI starts replying without any manual Enter. On failure the
       * prompt is pre-filled (and copied) so no work is lost.
       */
      const openMinutesSession = useCallback(async () => {
        let prompt = ''
        try {
          const response = await fetch(`${API}/minutes-prompt`, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => null)
          if (!payload?.ok) {
            setNotice(payload?.error ?? '生成纪要提示词失败')
            return
          }
          prompt = payload.prompt
          const prefill = async (notice) => {
            const workspace = typeof ctx?.get === 'function' ? ctx.get('uiWorkspace') : undefined
            if (workspace !== undefined && typeof workspace.startSession === 'function') {
              workspace.startSession(undefined, { prompt, clearPreviousDraft: true, whenDraftExists: 'replace' })
            } else {
              try { await navigator.clipboard.writeText(prompt) } catch { /* no clipboard */ }
            }
            setNotice(notice)
            setOpen(false)
          }

          const workspace = typeof ctx?.get === 'function' ? ctx.get('uiWorkspace') : undefined
          // ctx is a strict proxy: even an optional-chained property read
          // (ctx?.sessions) throws for a service outside our inject list, so
          // never touch it. The workspace service already holds the sessions
          // service instance it was constructed with — use that first.
          let sessions = workspace?.sessions ?? undefined
          if (sessions === undefined || typeof sessions.create !== 'function' || typeof sessions.retain !== 'function') {
            try { sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined } catch { sessions = undefined }
          }
          if (workspace === undefined || typeof workspace.openSession !== 'function'
            || sessions === undefined || typeof sessions.create !== 'function'
            || typeof sessions.retain !== 'function'
            || typeof runMinutesAutoSend !== 'function') {
            await prefill(t('minutesNoSession'))
            return
          }

          const result = await runMinutesAutoSend(workspace, sessions, prompt)
          if (result.ok === true) {
            setOpen(false)
            return
          }
          // The wire path failed before anything was sent: prefill the
          // composer in a fresh session so no work is lost, then explain.
          try { if (workspace.startSession instanceof Function) workspace.startSession(undefined, { prompt, clearPreviousDraft: true, whenDraftExists: 'replace' }) } catch { /* clipboard fallback below */ }
          try { await navigator.clipboard.writeText(prompt) } catch { /* no clipboard */ }
          setNotice(`${t('minutesAutoSendFailed')} (${result.reason ?? 'unknown'})`)
          setOpen(false)
        } catch (error) {
          // Never lose the work: fall back to the clipboard and say why.
          try { if (prompt !== '') await navigator.clipboard.writeText(prompt) } catch { /* no clipboard */ }
          setNotice(`${t('minutesNoSession')} ${String(error?.message ?? error)}`)
        }
      }, [ctx, t])

      /** Model pickers: one fetch is enough, the list changes with settings only. */
      const loadCatalog = useCallback(async () => {
        try {
          const response = await fetch(`${API}/models`, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => null)
          if (payload?.ok) setCatalog({ cloud: payload.cloud ?? { providers: [] }, offline: payload.offline ?? null })
        } catch (error) {
          setCatalog({ cloud: { providers: [], error: String(error?.message ?? error) }, offline: null })
        }
      }, [])

      useEffect(() => {
        void loadCatalog()
      }, [loadCatalog])

      // Opening the advanced group retries the catalog: a failed first fetch (the
      // page may load before the profile finishes mounting its providers) should
      // not leave an empty picker for the rest of the session.
      useEffect(() => {
        if (showAdvanced) void loadCatalog()
      }, [showAdvanced, loadCatalog])

      const loadRecords = useCallback(async (sessionId) => {
        try {
          const query = typeof sessionId === 'string' && sessionId !== '' ? `?session=${encodeURIComponent(sessionId)}` : ''
          const response = await fetch(`${API}/records${query}`, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => null)
          if (payload?.ok) setRecordsData(payload)
        } catch (error) {
          setNotice(String(error?.message ?? error))
        }
      }, [])

      const copyRecords = useCallback(async () => {
        const rows = recordsData?.records?.entries ?? []
        const text = rows
          .map((row) => `[${row.time || '--:--:--'}] ${row.text}${row.translation && row.translation !== row.text ? `\n          ${row.translation}` : ''}`)
          .join('\n')
        if (text === '') return
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          setNotice(t('copy'))
        }
      }, [recordsData, t])

      const beginDrag = (event) => {
        if (event.button !== 0) return
        if (event.target?.closest?.('button, select, input, textarea, a, .mc-lyric-resize')) return
        const rect = event.currentTarget.getBoundingClientRect()
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* not supported */ }
        event.preventDefault()
      }

      const moveDrag = (event) => {
        const drag = dragRef.current
        if (drag === null) return
        const width = event.currentTarget?.offsetWidth ?? 320
        const maxX = (window.innerWidth ?? 1200) - width - 8
        const maxY = (window.innerHeight ?? 800) - 72
        const x = Math.max(8, Math.min(maxX, event.clientX - drag.dx))
        const y = Math.max(8, Math.min(maxY, event.clientY - drag.dy))
        drag.x = x
        drag.y = y
        setLyricPos({ x, y })
      }

      const endDrag = () => {
        const drag = dragRef.current
        dragRef.current = null
        if (drag !== null && typeof drag.x === 'number') save({ lyricX: drag.x, lyricY: drag.y })
      }

      const LYRIC_MIN_W = 320
      const LYRIC_MIN_H = 140

      // Every edge and corner resizes, so `direction` names the sides to move.
      const beginLyricResize = (direction) => (event) => {
        event.stopPropagation()
        const box = lyricRef.current
        if (box === null) return
        const rect = box.getBoundingClientRect()
        // Pin the box to explicit left/top first: a west or north drag has to be
        // able to move the origin, which a centred box has no anchor for.
        setLyricPos({ x: rect.left, y: rect.top })
        resizeRef.current = {
          dir: direction,
          startX: event.clientX, startY: event.clientY,
          x0: rect.left, y0: rect.top,
          w0: rect.width, h0: rect.height,
          x: rect.left, y: rect.top, w: rect.width, h: rect.height,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* not supported */ }
        event.preventDefault()
      }

      const moveLyricResize = (event) => {
        const resize = resizeRef.current
        if (resize === null) return
        const viewportW = window.innerWidth ?? 1200
        const viewportH = window.innerHeight ?? 800
        const next = resizeLyricBox(
          resize, resize.dir,
          event.clientX - resize.startX, event.clientY - resize.startY,
          {
            minW: LYRIC_MIN_W, minH: LYRIC_MIN_H,
            maxW: viewportW - 16, maxH: viewportH - 16,
            viewportW, viewportH,
          },
        )
        resize.w = next.w
        resize.h = next.h
        resize.x = next.x
        resize.y = next.y
        setLyricSize({ w: next.w, h: next.h })
        setLyricPos({ x: next.x, y: next.y })
      }

      const endLyricResize = () => {
        const resize = resizeRef.current
        resizeRef.current = null
        if (resize === null) return
        const changed = resize.w !== resize.w0 || resize.h !== resize.h0
          || resize.x !== resize.x0 || resize.y !== resize.y0
        // A click on an edge without dragging must not rewrite the geometry.
        if (!changed) return
        save({
          lyricW: Math.round(resize.w), lyricH: Math.round(resize.h),
          lyricX: Math.round(resize.x), lyricY: Math.round(resize.y),
        })
      }

      /** Follow the newest line unless the reader scrolled up inside the box. */
      const onLyricScroll = () => {
        const body = lyricBodyRef.current
        if (body === null) return
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24
        pinnedRef.current = atBottom
        setPinned(atBottom)
      }

      /** Same rule for the panel list and the detached window. */
      const onListScroll = () => {
        const list = listRef.current
        if (list === null) return
        listPinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24
      }

      const onLiveScroll = () => {
        const list = liveListRef.current
        if (list === null) return
        livePinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24
      }

      const scrollToLatest = () => {
        const body = lyricBodyRef.current
        if (body === null) return
        pinnedRef.current = true
        setPinned(true)
        body.scrollTop = body.scrollHeight
      }

      const recordsGeometry = () => recordsGeom ?? {
        x: typeof settings.recordsX === 'number' ? settings.recordsX : Math.max(16, Math.round((window.innerWidth ?? 1200) / 2 - 210)),
        y: typeof settings.recordsY === 'number' ? settings.recordsY : Math.max(16, Math.round((window.innerHeight ?? 800) / 2 - 230)),
        w: typeof settings.recordsW === 'number' ? settings.recordsW : 420,
        h: typeof settings.recordsH === 'number' ? settings.recordsH : 460,
      }

      const beginRecordsMove = (event) => {
        if (event.button !== 0) return
        // Never start a drag from a control: pointer capture on the header would
        // swallow the button's click, which is exactly how close stopped working.
        if (event.target?.closest?.('button, select, input, textarea, a, .mc-records-list, .mc-window-resize, .mc-records-foot')) return
        const geometry = recordsGeometry()
        recordsMoveRef.current = { dx: event.clientX - geometry.x, dy: event.clientY - geometry.y }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* not supported */ }
        event.preventDefault()
      }

      const moveRecordsMove = (event) => {
        const drag = recordsMoveRef.current
        if (drag === null) return
        const geometry = recordsGeometry()
        const x = Math.max(8, Math.min((window.innerWidth ?? 1200) - 140, event.clientX - drag.dx))
        const y = Math.max(8, Math.min((window.innerHeight ?? 800) - 60, event.clientY - drag.dy))
        setRecordsGeom({ ...geometry, x, y })
      }

      const endRecordsMove = () => {
        const drag = recordsMoveRef.current
        recordsMoveRef.current = null
        if (drag === null) return
        const geometry = recordsGeometry()
        save({ recordsX: Math.round(geometry.x), recordsY: Math.round(geometry.y) })
      }

      const beginRecordsResize = (event) => {
        event.stopPropagation()
        const geometry = recordsGeometry()
        recordsGrowRef.current = { startX: event.clientX, startY: event.clientY, w0: geometry.w, h0: geometry.h, w: geometry.w, h: geometry.h }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* not supported */ }
        event.preventDefault()
      }

      const moveRecordsResize = (event) => {
        const resize = recordsGrowRef.current
        if (resize === null) return
        const geometry = recordsGeometry()
        const w = Math.max(320, Math.min((window.innerWidth ?? 1200) - geometry.x - 8, resize.w0 + (event.clientX - resize.startX)))
        const h = Math.max(240, Math.min((window.innerHeight ?? 800) - geometry.y - 8, resize.h0 + (event.clientY - resize.startY)))
        resize.w = w
        resize.h = h
        setRecordsGeom({ ...geometry, w, h })
      }

      const endRecordsResize = () => {
        const resize = recordsGrowRef.current
        recordsGrowRef.current = null
        if (resize !== null) save({ recordsW: Math.round(resize.w), recordsH: Math.round(resize.h) })
      }

      const status = state?.status ?? 'idle'
      const running = status === 'running' || status === 'starting'
      const preparing = status === 'preparing'
      const asr = state?.asr ?? { available: false, phase: 'unavailable' }
      const modelReady = asr.phase === 'ready' || asr.phase === 'standby'
      const asrBusy = ['downloading', 'loading', 'waking', 'checking', 'cancelling'].includes(asr.phase)
      const latest = entries.length > 0 ? entries[entries.length - 1] : null
      const settings = state?.settings ?? { source: 'both', sourceLanguage: 'auto', targetLanguage: 'zh', translate: true }
      // Target language and translation engine only mean something while
      // translation is on, so they are disclosed with the switch instead of
      // sitting there as a permanently disabled-looking pair of controls.
      const translateOn = settings.translate !== false
      // Off by default: a one-hour meeting keeps about 1.2 GB when it is on.
      const keepAudio = settings.keepAudio === true
      const minutes = state?.minutes ?? { generating: false, text: '', path: null, error: null }
      const mt = state?.mt ?? { state: 'idle', progress: {}, model: '', error: null }
      const mtPercent = mt.progress && mt.progress.total > 0
        ? Math.min(100, Math.round((mt.progress.loaded / mt.progress.total) * 100))
        : null
      const offlineModels = mt.models ?? []
      const currentOffline = offlineModels.find((entry) => entry.id === settings.builtinModel)
        ?? offlineModels[0] ?? null
      // Progress and readiness only speak for the model the user currently has
      // selected; a stale child for the previous model must not show a spinner.
      const mtLoadingThis = mt.state === 'loading' && mt.model === settings.builtinModel
      const mtReadyThis = mt.state === 'ready' && mt.model === settings.builtinModel
      // Providers with no model to offer are noise: the session's own selector
      // never lists them either.
      const cloudProviders = (catalog?.cloud?.providers ?? [])
        .filter((route) => (route.models ?? []).length > 0)

      const progress = asr.progress ?? {}
      const percent = progress.totalBytes ? Math.min(100, Math.round((progress.completedBytes / progress.totalBytes) * 100)) : null
      const elapsedMs = state?.session?.elapsedMs
      const elapsedLabel = typeof elapsedMs === 'number' ? formatDuration(elapsedMs) : null

      // A stored position or size may come from another monitor, so both windows
      // are clamped fully inside the current viewport — otherwise a title bar
      // (and its close button) can end up off-screen.
      const viewportW = window.innerWidth ?? 1200
      const viewportH = window.innerHeight ?? 800
      const clampX = (value, width) => Math.max(8, Math.min(viewportW - width - 8, value))
      const clampY = (value, height) => Math.max(8, Math.min(viewportH - height - 8, value))
      const lyricX = lyricPos === null ? settings.lyricX : lyricPos.x
      const lyricY = lyricPos === null ? settings.lyricY : lyricPos.y
      // A stored size wins; otherwise the box fits the current window.
      const autoSize = autoLyricSize(settings.lyricFontSize, viewportW, viewportH)
      const seedW = Number.isFinite(settings.lyricW) ? settings.lyricW : autoSize.w
      const seedH = Number.isFinite(settings.lyricH) ? settings.lyricH : autoSize.h
      const lyricW = Math.min(lyricSize === null ? seedW : lyricSize.w, viewportW - 16)
      const lyricH = Math.min(lyricSize === null ? seedH : lyricSize.h, viewportH - 16)
      const lyricLocked = settings.lyricLocked === true
      const lyricVisible = settings.lyricVisible !== false
      // The host's own always-on-top window is the real "stays when minimised"
      // overlay; PiP and the in-page box are progressively weaker fallbacks.
      const overlaySupported = state?.overlay?.supported === true
      const overlayOpen = state?.overlay?.open === true
      const lyricStyle = {
        '--mc-lyric-size': `${settings.lyricFontSize ?? 22}px`,
        opacity: settings.lyricOpacity ?? 0.92,
        width: `${lyricW}px`,
        height: `${lyricH}px`,
        ...(typeof lyricX !== 'number' || typeof lyricY !== 'number'
          ? { left: '50%', bottom: `${autoLyricBottom(viewportH)}px`, transform: 'translateX(-50%)' }
          : { left: `${clampX(lyricX, lyricW)}px`, top: `${clampY(lyricY, lyricH)}px` }),
      }
      const recordsStyle = (() => {
        const geometry = recordsGeometry()
        const width = Math.min(geometry.w, viewportW - 24)
        const height = Math.min(geometry.h, viewportH - 24)
        return {
          left: `${clampX(geometry.x, width)}px`,
          top: `${clampY(geometry.y, height)}px`,
          width: `${width}px`,
          height: `${height}px`,
        }
      })()

      /**
       * Markup for the detached overlay window. It is built as a string because
       * that document has no React root: the shell only owns the in-app overlay.
       */
      const pipMarkup = () => {
        const computed = getComputedStyle(document.documentElement)
        const tokens = THEME_TOKENS
          .map((name) => `${name}:${computed.getPropertyValue(name).trim()}`)
          .join(';')
        const showSource = settings.lyricShowSource !== false
        const rows = entries.slice(-60).map((entry) => {
          const showTarget = settings.translate !== false
            && !(entry.translation !== null && entry.translation === entry.text)
          return `<div class="mc-lyric-entry"><span class="mc-lyric-time">${escapeText(entry.at ?? '')}</span>`
            + '<div class="mc-lyric-lines">'
            + (showSource ? `<div class="mc-line mc-line-source"><span class="mc-line-text">${escapeText(entry.text)}</span></div>` : '')
            + (showTarget ? `<div class="mc-line mc-line-target"><span class="mc-line-text">${escapeText(entry.translation ?? '…')}</span></div>` : '')
            + '</div></div>'
        }).join('')
        const body = entries.length === 0
          ? `<div class="mc-line mc-line-source">${escapeText(running ? t('listening') : t('overlayIdle'))}</div>`
          : rows
        return `<style>:root{${tokens};--mc-lyric-size:${settings.lyricFontSize ?? 22}px}`
          + 'html,body{margin:0;background:transparent;font-family:"Segoe UI","Microsoft YaHei UI",system-ui,sans-serif}'
          + `body{color:var(--dsw-alias-label-primary);overflow:hidden}${styles}`
          + '.mc-lyric-pip{position:fixed;inset:0;width:auto;height:auto;min-width:0;max-width:none;margin:0;'
          + 'border:0;border-radius:0;box-shadow:none;background:var(--dsw-alias-bg-overlay);'
          + 'padding:10px 14px;box-sizing:border-box}'
          + '</style><div class="mc-lyric mc-lyric-pip"><div class="mc-lyric-body">'
          + `${body}</div></div>`
      }

      /** Close the detached window, if one is open. */
      const closePip = () => {
        const pip = pipRef.current
        pipRef.current = null
        setPipActive(false)
        if (pip !== null) {
          try { pip.win.close() } catch { /* already closed */ }
        }
      }

      /**
       * Open the always-on-top overlay window. Document Picture-in-Picture puts a
       * real OS window above other applications, which a page-fixed element can
       * never do; it must be requested from a user gesture.
       */
      const openPip = async () => {
        const api = window.documentPictureInPicture
        if (api === undefined || api === null || typeof api.requestWindow !== 'function') {
          // No always-on-top window in this shell: say so once and let the
          // in-app overlay take over.
          setNotice(t('pipUnavailable'))
          return false
        }
        try {
          const win = await api.requestWindow({ width: lyricW, height: lyricH })
          const doc = win.document
          doc.title = t('overlay')
          pipRef.current = { win, doc }
          win.addEventListener('pagehide', () => {
            pipRef.current = null
            setPipActive(false)
          })
          doc.body.innerHTML = pipMarkup()
          const resize = () => { try { doc.body.innerHTML = pipMarkup() } catch { /* gone */ } }
          win.addEventListener('resize', resize)
          setPipActive(true)
          return true
        } catch (error) {
          setNotice(`PiP: ${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      }

      // Keep the detached window in sync with the live transcript.
      useEffect(() => {
        const pip = pipRef.current
        if (pip === null) return
        try { pip.doc.body.innerHTML = pipMarkup() } catch { pipRef.current = null }
      }, [entries, running, settings.lyricShowSource, settings.translate, settings.lyricFontSize, t])

      // Never leave an orphan window behind when the plugin unloads.
      useEffect(() => () => {
        const pip = pipRef.current
        pipRef.current = null
        if (pip !== null) {
          try { pip.win.close() } catch { /* already closed */ }
        }
      }, [])

      // Keep the viewport pinned to the newest line while the reader stays at the bottom.
      useEffect(() => {
        const body = lyricBodyRef.current
        if (body === null || !pinnedRef.current) return
        body.scrollTop = body.scrollHeight
      }, [entries])

      return h('div', { className: 'mc-root' }, [
        h('style', { key: 'style' }, styles),

        lyricVisible && running && !pipActive && !overlayOpen ? h('div', {
          ref: lyricRef,
          className: `mc-lyric${lyricLocked ? ' mc-lyric-locked' : ''}`,
          key: 'lyric',
          style: lyricStyle,
          role: 'status',
          'aria-live': 'polite',
          title: lyricLocked ? t('lockedHint') : t('dragHint'),
          onPointerDown: lyricLocked ? undefined : beginDrag,
          onPointerMove: lyricLocked ? undefined : moveDrag,
          onPointerUp: lyricLocked ? undefined : endDrag,
        }, [
          !lyricLocked && !pinned
            ? h('button', {
                className: 'mc-lyric-badge', key: 'history', type: 'button',
                onClick: scrollToLatest, title: t('backToLive'),
              }, `↓ ${t('backToLive')}`)
            : null,
          lyricLocked ? null : h('div', { className: 'mc-lyric-tools', key: 'tools' }, [
            h('button', {
              className: 'mc-lyric-tool', key: 'font-down', type: 'button',
              title: t('fontSize'), 'aria-label': `${t('fontSize')} -`,
              onClick: () => save({ lyricFontSize: (settings.lyricFontSize ?? 22) - 2 }),
            }, 'A−'),
            h('button', {
              className: 'mc-lyric-tool', key: 'font-up', type: 'button',
              title: t('fontSize'), 'aria-label': `${t('fontSize')} +`,
              onClick: () => save({ lyricFontSize: (settings.lyricFontSize ?? 22) + 2 }),
            }, 'A+'),
            h('button', {
              className: 'mc-lyric-tool', key: 'opacity-down', type: 'button',
              title: t('opacity'), 'aria-label': `${t('opacity')} -`,
              onClick: () => save({ lyricOpacity: (settings.lyricOpacity ?? 0.92) - 0.08 }),
            }, '◐−'),
            h('button', {
              className: 'mc-lyric-tool', key: 'opacity-up', type: 'button',
              title: t('opacity'), 'aria-label': `${t('opacity')} +`,
              onClick: () => save({ lyricOpacity: (settings.lyricOpacity ?? 0.92) + 0.08 }),
            }, '◐+'),
            h('button', {
              className: 'mc-lyric-tool', key: 'toggle-source', type: 'button',
              title: t('tagSource'), 'aria-pressed': settings.lyricShowSource !== false,
              onClick: () => save({ lyricShowSource: settings.lyricShowSource === false }),
            }, settings.lyricShowSource === false ? '原文✕' : '原文✓'),
            h('button', {
              className: 'mc-lyric-tool', key: 'lock', type: 'button',
              title: t('lock'), 'aria-label': t('lock'),
              onClick: () => save({ lyricLocked: true }),
            }, '🔒'),
            h('button', {
              className: 'mc-lyric-tool', key: 'reset-pos', type: 'button',
              title: t('resetPos'), 'aria-label': t('resetPos'),
              onClick: () => { setLyricPos(null); setLyricSize(null); save({ lyricReset: true }) },
            }, '⟲'),
            h('button', {
              className: 'mc-lyric-tool mc-lyric-tool-close', key: 'hide', type: 'button',
              title: t('hideOverlay'), 'aria-label': t('hideOverlay'),
              onClick: () => save({ lyricVisible: false }),
            }, '×'),
          ]),
          h('div', {
            className: 'mc-lyric-body', key: 'body',
            ref: lyricBodyRef, onScroll: onLyricScroll,
          },
            entries.length === 0
              ? h('div', { className: 'mc-line mc-line-source', key: 'listening' },
                  running ? t('listening') : t('overlayIdle'))
              : entries.slice(-60).map((entry) => h('div', { className: 'mc-lyric-entry', key: entry.seq }, [
                  h('span', { className: 'mc-lyric-time', key: 'time' }, entry.at ?? ''),
                  h('div', { className: 'mc-lyric-lines', key: 'lines' }, [
                    settings.lyricShowSource === false
                      ? null
                      : h('div', { className: 'mc-line mc-line-source', key: 'source' },
                          h('span', { className: 'mc-line-text', key: 'text' }, entry.text)),
                    settings.translate === false || (entry.translation !== null && entry.translation === entry.text)
                      ? null
                      : h('div', { className: 'mc-line mc-line-target', key: 'target' },
                          h('span', { className: 'mc-line-text', key: 'text' }, entry.translation ?? '…')),
                  ]),
                ]))),
          lyricLocked ? null : LYRIC_RESIZE_EDGES.map((direction) => h('div', {
            className: `mc-lyric-resize mc-lyric-resize-${direction}`,
            key: `resize-${direction}`,
            title: t('resize'),
            onPointerDown: beginLyricResize(direction),
            onPointerMove: moveLyricResize,
            onPointerUp: endLyricResize,
            onPointerCancel: endLyricResize,
          })),
        ]) : null,

        liveOpen ? h('section', {
          className: 'mc-record-window', key: 'live', role: 'dialog', 'aria-label': t('liveWindow'),
          style: recordsStyle,
        }, [
          h('header', {
            className: 'mc-records-head', key: 'head',
            onPointerDown: beginRecordsMove,
            onPointerMove: moveRecordsMove,
            onPointerUp: endRecordsMove,
          }, [
            h('span', { className: 'mc-records-title', key: 'title' }, t('liveWindow')),
            h('span', {
              className: 'mc-hint', key: 'count',
              style: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' },
            }, `${state?.totalEntries ?? entries.length} ${t('lines')}`),
            h('button', {
              className: 'mc-icon-btn', key: 'close', type: 'button',
              onClick: () => setLiveOpen(false), 'aria-label': t('close'), title: t('close'),
            }, '×'),
          ]),
          h('div', { className: 'mc-records-list', key: 'list', ref: liveListRef, onScroll: onLiveScroll },
            entries.length === 0
              ? h('div', { className: 'mc-empty', key: 'empty' }, running ? t('listening') : t('emptyTranscript'))
              : entries.slice(-200).map((entry) => h('div', { className: 'mc-record', key: entry.seq }, [
                  h('span', { className: 'mc-record-time', key: 'time' }, entry.at ?? ''),
                  h('div', { className: 'mc-record-texts', key: 'texts' }, [
                    h('span', { className: 'mc-record-src', key: 'src' }, entry.text),
                    entry.translation && entry.translation !== entry.text
                      ? h('span', { className: 'mc-record-tr', key: 'tr' }, entry.translation)
                      : null,
                  ]),
                ]))),
          h('div', {
            className: 'mc-window-resize', key: 'resize', title: t('resize'),
            onPointerDown: beginRecordsResize,
            onPointerMove: moveRecordsResize,
            onPointerUp: endRecordsResize,
          }),
        ]) : null,

        recordsOpen ? h('section', {
          className: 'mc-record-window', key: 'records', role: 'dialog', 'aria-label': t('recordsTitle'),
          style: recordsStyle,
        }, [
          h('header', {
            className: 'mc-records-head', key: 'head',
            onPointerDown: beginRecordsMove,
            onPointerMove: moveRecordsMove,
            onPointerUp: endRecordsMove,
          }, [
            h('span', { className: 'mc-records-title', key: 'title' }, t('recordsTitle')),
            h('select', {
              className: 'mc-select', key: 'pick',
              style: { flex: '1 1 auto', minWidth: '90px' },
              value: recordsData?.sessionId ?? '',
              'aria-label': t('recordsPick'),
              onChange: (event) => { void loadRecords(event.target.value) },
            }, (recordsData?.sessions ?? []).map((session) => h('option', { key: session.id, value: session.id },
              sessionLabel(session, t('lines'))))),
            h('button', {
              className: 'mc-icon-btn', key: 'close', type: 'button',
              onClick: () => setRecordsOpen(false), 'aria-label': t('close'), title: t('close'),
            }, '×'),
          ]),
          h('div', { className: 'mc-records-list', key: 'list' },
            (recordsData?.records?.entries ?? []).length === 0
              ? h('div', { className: 'mc-empty', key: 'empty' }, t('recordsEmpty'))
              : recordsData.records.entries.map((row) => h('div', { className: 'mc-record', key: row.seq }, [
                  h('span', { className: 'mc-record-time', key: 'time' }, row.time || '--:--:--'),
                  h('div', { className: 'mc-record-texts', key: 'texts' }, [
                    h('span', { className: 'mc-record-src', key: 'src' }, row.text),
                    row.translation && row.translation !== row.text
                      ? h('span', { className: 'mc-record-tr', key: 'tr' }, row.translation)
                      : null,
                  ]),
                ]))),
          h('div', { className: 'mc-records-foot', key: 'foot' }, [
            h('span', { className: 'mc-hint', key: 'count' },
              `${(recordsData?.records?.entries ?? []).length} ${t('lines')}`),
            h('button', {
              className: 'mc-ghost-btn', key: 'delete', type: 'button',
              disabled: busy !== '' || recordsData?.sessionId == null,
              title: deleteArmed ? ''
                : (recordsData?.sessionId === (sessionRef.current ?? undefined) ? t('deleteCurrent') : t('deleteRecord')),
              onClick: () => {
                if (!deleteArmed) {
                  setDeleteArmed(true)
                  clearTimeout(deleteArmRef.current)
                  deleteArmRef.current = setTimeout(() => setDeleteArmed(false), 4000)
                  return
                }
                clearTimeout(deleteArmRef.current)
                deleteArmRef.current = null
                setDeleteArmed(false)
                const target = recordsData?.sessionId ?? null
                if (target === null) return
                void command({ action: 'delete_session', session: target }).then((payload) => {
                  if (payload?.ok === false) return
                  // The deleted rows may be the live session's own list; drop the
                  // stale view and let the next poll rebuild what is left.
                  reset()
                  void loadRecords()
                })
              },
            }, deleteArmed ? t('confirmDelete') : t('deleteRecord')),
            h('button', {
              className: 'mc-ghost-btn', key: 'copy', type: 'button',
              disabled: (recordsData?.records?.entries ?? []).length === 0,
              onClick: copyRecords,
            }, copied ? t('copied') : t('copyAll')),
          ]),
          h('div', {
            className: 'mc-window-resize', key: 'resize', title: t('resize'),
            onPointerDown: beginRecordsResize,
            onPointerMove: moveRecordsResize,
            onPointerUp: endRecordsResize,
          }),
        ]) : null,

        h('div', { className: 'mc-dock', key: 'dock' }, [
          open ? h('section', {
            className: 'mc-panel',
            key: 'panel',
            role: 'dialog',
            'aria-label': t('title'),
          }, [
            h('header', { className: 'mc-head', key: 'head' }, [
              h('span', {
                className: 'mc-dot', key: 'dot',
                style: {
                  background: statusColor(status),
                  animation: running ? 'mc-pulse 2s infinite' : undefined,
                },
              }),
              h('span', { className: 'mc-head-title', key: 'title' }, t('title')),
              h('span', { className: 'mc-head-status', key: 'status' },
                asrBusy && !running ? t('preparing') : t(`status.${status}`)),
              running && elapsedLabel !== null
                ? h('span', { className: 'mc-timer', key: 'timer' }, elapsedLabel)
                : null,
              // The capture switch lives in the header: one visible on/off control
              // instead of a full-width button pushing the settings down.
              running || preparing
                ? h('button', {
                    className: 'mc-toggle', key: 'stop', type: 'button',
                    disabled: busy !== '',
                    onClick: () => command({ action: 'stop' }),
                    title: t('stop'), 'aria-label': t('stop'),
                  }, [h('span', { className: 'mc-toggle-mark', key: 'mark' }), t('stop')])
                : h('button', {
                    className: 'mc-start', key: 'start', type: 'button',
                    disabled: busy !== '' || !asr.available,
                    onClick: () => command({ action: 'start' }),
                    title: t('start'), 'aria-label': t('start'),
                  }, t('start')),
              h('button', {
                className: 'mc-icon-btn', key: 'close', type: 'button',
                onClick: () => setOpen(false), 'aria-label': t('close'), title: t('close'),
              }, '×'),
            ]),

            h('div', { className: 'mc-body', key: 'body' }, [

              // Anything that blocks usage or needs attention stays above the fold.
              asr.available === false
                ? h('div', { className: 'mc-error', key: 'asr-missing', role: 'alert' }, asr.message ?? '')
                : null,
              state?.setup ? h('div', { className: 'mc-warn', key: 'setup', role: 'alert' }, [
                h('span', { key: 'text' }, state.setup),
                h('button', {
                  className: 'mc-ghost-btn',
                  key: 'setup-btn',
                  onClick: () => command({ action: 'install_clt' }),
                }, '打开安装向导'),
              ]) : null,
              notice ? h('div', { className: 'mc-error', key: 'notice', role: 'alert' }, notice) : null,
              state?.translationError ? h('div', { className: 'mc-error', key: 'tr-error' }, `${t('translationFailed')}: ${state.translationError}`) : null,
              (state?.warnings ?? []).map((warning, index) =>
                h('div', { className: 'mc-warn', key: `warn-${index}` }, warning)),
              // First run: the model is fetching itself in the background, so say
              // what is happening, how big it is and that it happens once.
              asrBusy
                ? h('div', { className: 'mc-download', key: 'download', role: 'status' }, [
                    h('div', { className: 'mc-download-head', key: 'head' }, [
                      h('div', { className: 'mc-spin', key: 'spin' }),
                      h('span', { className: 'mc-download-title', key: 'title' }, t('downloadTitle')),
                      h('span', { className: 'mc-download-pct', key: 'pct' },
                        percent === null ? t('preparing') : `${percent}%`),
                    ]),
                    h('div', { className: 'mc-progress', key: 'bar' },
                      h('span', { style: { width: `${percent === null ? 100 : percent}%` } })),
                    h('div', { className: 'mc-download-hint', key: 'hint' }, t('downloadHint')),
                  ])
                : null,
              !modelReady && !asrBusy && asr.available
                ? h('div', { className: 'mc-hint', key: 'first-run' }, t('firstRunHint'))
                : null,

              // Capture: the source is a three-way choice, so it is a segmented
              // control; the spoken language is a lookup, so it stays a select.
              h('div', { className: 'mc-grp', key: 'capture' }, [
                h('span', { className: 'mc-cap', key: 'cap' }, t('source')),
                h('div', { className: 'mc-seg', key: 'seg', role: 'group', 'aria-label': t('source') },
                  [['both', t('source.both')], ['speaker', t('source.speaker')], ['mic', t('source.mic')]].map(([value, label]) =>
                    h('button', {
                      key: value, type: 'button',
                      'aria-pressed': settings.source === value,
                      onClick: () => command({ action: 'settings', settings: { source: value } }),
                    }, label))),
                h('div', { className: 'mc-irow', key: 'spoken' }, [
                  h('span', { className: 'mc-lbl', key: 'lbl' }, t('spoken')),
                  h('select', {
                    className: 'mc-select', key: 'select', value: settings.sourceLanguage,
                    'aria-label': t('spoken'),
                    onChange: (event) => command({ action: 'settings', settings: { sourceLanguage: event.target.value } }),
                  }, SOURCE_LANGUAGES.map((value) => h('option', { key: value, value }, t(`lang.${value}`)))),
                ]),
              ]),

              // Translation: one switch owns the whole group, so the target
              // language only exists while the switch is on.
              h('div', { className: 'mc-grp', key: 'translation' }, [
                h('div', { className: 'mc-irow', key: 'switch' }, [
                  h('span', { className: 'mc-lbl-strong', key: 'lbl' }, t('translate')),
                  translateOn && state?.engine?.label
                    ? h('span', { className: 'mc-note', key: 'engine' }, state.engine.label)
                    : null,
                  h('button', {
                    className: 'mc-sw', key: 'sw', type: 'button', role: 'switch',
                    'aria-checked': translateOn, 'aria-label': t('translate'),
                    onClick: () => command({ action: 'settings', settings: { translate: !translateOn } }),
                  }),
                ]),
                translateOn
                  ? h('div', { className: 'mc-irow', key: 'target' }, [
                      h('span', { className: 'mc-lbl', key: 'lbl' }, t('target')),
                      h('select', {
                        className: 'mc-select', key: 'select', value: settings.targetLanguage,
                        'aria-label': t('target'),
                        onChange: (event) => command({ action: 'settings', settings: { targetLanguage: event.target.value } }),
                      }, TARGET_LANGUAGES.map((value) => h('option', { key: value, value }, t(`lang.${value}`)))),
                    ])
                  : h('div', { className: 'mc-hint', key: 'off' }, t('translateOff')),
              ]),

              // The overlay can be dismissed from its own close button; this is
              // the way back in, and the only place that turns it on again.
              h('div', { className: 'mc-grp', key: 'overlay' }, [
                h('div', { className: 'mc-irow', key: 'switch' }, [
                  h('span', { className: 'mc-lbl-strong', key: 'lbl' }, t('overlay')),
                  // A locked overlay is click-through, so its own tools are out of
                  // reach: unlocking has to live here.
                  lyricLocked
                    ? h('button', {
                        className: 'mc-ghost-btn', key: 'unlock', type: 'button',
                        onClick: () => save({ lyricLocked: false }),
                      }, t('unlock'))
                    : null,
                  h('button', {
                    className: 'mc-sw', key: 'sw', type: 'button', role: 'switch',
                    'aria-checked': lyricVisible, 'aria-label': t('overlay'),
                    onClick: () => {
                      if (lyricVisible) {
                        closePip()
                        if (overlayOpen) void command({ action: 'overlay_close' })
                        else save({ lyricVisible: false })
                        return
                      }
                      save({ lyricVisible: true })
                      if (overlaySupported) {
                        // A real OS window needs no user gesture and survives
                        // minimising this app; errors surface via `notice`.
                        void command({ action: 'overlay_open' })
                        return
                      }
                      // Prefer PiP when the host cannot open its own topmost
                      // window; the in-app overlay is the last resort.
                      void openPip()
                    },
                  }),
                ]),
                overlayOpen ? h('div', { className: 'mc-hint', key: 'os' }, t('overlayOsHint')) : null,
                pipActive ? h('div', { className: 'mc-hint', key: 'pip' }, t('pipHint')) : null,
                lyricVisible ? null : h('div', { className: 'mc-hint', key: 'off' }, t('overlayOff')),
              ]),

              // Live transcript.
              h('div', { className: 'mc-grp', key: 'transcript' }, [
                h('div', { className: 'mc-list-head', key: 'head' }, [
                  h('span', { className: 'mc-cap', key: 'left' }, t('transcript')),
                  h('span', {
                    className: 'mc-cap', key: 'right',
                    style: { fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' },
                  }, [
                    state?.totalEntries ? `${state.totalEntries} ${t('lines')}` : '',
                    state?.session ? `${state.session.segments} ${t('segments')}` : '',
                  ].filter(Boolean).join(' · ')),
                  h('button', {
                    className: 'mc-icon-btn', key: 'collapse', type: 'button',
                    title: transcriptCollapsed ? t('expand') : t('collapse'),
                    'aria-label': transcriptCollapsed ? t('expand') : t('collapse'),
                    'aria-expanded': !transcriptCollapsed,
                    onClick: () => setTranscriptCollapsed((value) => !value),
                  }, transcriptCollapsed ? '▸' : '▾'),
                  // A detached window is useful when the panel closes mid-meeting:
                  // it keeps mirroring the live list as new lines arrive.
                  h('button', {
                    className: 'mc-icon-btn', key: 'popup', type: 'button',
                    title: t('liveWindow'), 'aria-label': t('liveWindow'),
                    'aria-pressed': liveOpen,
                    onClick: () => {
                      setLiveOpen((value) => !value)
                      setRecordsOpen(false)
                    },
                  }, '⧉'),
                ]),
                // While the detached window owns the transcript, the panel keeps
                // only the header so the same lines are not shown twice.
                transcriptCollapsed
                  ? null
                  : liveOpen
                    ? h('div', { className: 'mc-empty', key: 'detached' }, t('transcriptDetached'))
                    : entries.length === 0
                    ? h('div', { className: 'mc-empty', key: 'empty' }, running ? t('listening') : t('emptyTranscript'))
                    : h('div', { className: 'mc-list', key: 'list', ref: listRef, onScroll: onListScroll }, entries.slice(-40).map((entry) =>
                      h('div', {
                        className: `mc-tr-row${entry.live ? ' mc-tr-live' : ''}`, key: entry.seq,
                      }, [
                        h('span', { className: 'mc-tr-t', key: 'time' }, entry.at),
                        h('div', { className: 'mc-tr-body', key: 'body' }, [
                          h('div', { className: 'mc-tr-src', key: 'src' }, entry.text),
                          translateOn && entry.translation
                            ? h('div', { className: 'mc-tr-tr', key: 'tr' }, entry.translation)
                            : null,
                          entry.translationFailed
                            ? h('div', { className: 'mc-tr-t', key: 'fail' }, t('translationFailed'))
                            : null,
                        ]),
                      ]))),
              ]),

              // Meeting minutes from the agent tool, when present.
              minutes.text
                ? h('div', { className: 'mc-grp', key: 'minutes' }, [
                    h('div', { className: 'mc-list-head', key: 'minutes-title' }, [
                      h('span', { className: 'mc-cap', key: 'left' }, t('minutes')),
                      h('button', { className: 'mc-icon-btn', key: 'copy', type: 'button', onClick: copyMinutes, title: t('copy') }, copied ? t('copied') : t('copy')),
                    ]),
                    h('pre', { className: 'mc-minutes', key: 'text' }, minutes.text),
                  ])
                : null,
              minutes.error ? h('div', { className: 'mc-error', key: 'minutes-error' }, minutes.error) : null,
              minutes.path ? h('div', { className: 'mc-hint', key: 'minutes-path', title: minutes.path }, `${t('minutesPath')}: ${minutes.path}`) : null,

              showAdvanced
                ? h('div', { className: 'mc-advanced', key: 'advanced' }, [

                    // Translation settings are a preference, not a mode: they stay
                    // editable while the translate switch is off, so the engine and
                    // model can be chosen before the first translation happens.
                    h('div', { className: 'mc-irow', key: 'engine-row' }, [
                      h('span', { className: 'mc-lbl', key: 'label' }, t('engine')),
                      h('select', {
                        className: 'mc-select', key: 'select',
                        'aria-label': t('engine'),
                        value: settings.translateEngine === 'local'
                          ? 'local'
                          : settings.translateEngine === 'builtin' ? 'builtin' : 'cloud',
                        onChange: (event) => command({
                          action: 'settings',
                          settings: { translateEngine: event.target.value },
                        }),
                      }, [
                        h('option', { key: 'cloud', value: 'cloud' }, t('engine.cloud')),
                        h('option', { key: 'builtin', value: 'builtin' }, t('engine.builtin')),
                        h('option', { key: 'local', value: 'local' }, t('engine.local')),
                      ]),
                    ]),

                    settings.translateEngine === 'cloud'
                      ? h('label', { className: 'mc-field', key: 'cloud-model' }, [
                          h('span', { key: 'label' }, t('cloudModel')),
                          h('select', {
                            className: 'mc-select', key: 'select',
                            'aria-label': t('cloudModel'),
                            value: settings.cloudProvider !== '' && settings.cloudModel !== ''
                              ? `${settings.cloudProvider}|${settings.cloudModel}`
                              : '',
                            onChange: (event) => {
                              const value = event.target.value
                              if (value === '') {
                                void command({ action: 'settings', settings: { cloudProvider: '', cloudModel: '' } })
                                return
                              }
                              const split = value.indexOf('|')
                              void command({
                                action: 'settings',
                                settings: {
                                  cloudProvider: value.slice(0, split),
                                  cloudModel: value.slice(split + 1),
                                },
                              })
                            },
                          }, [
                            h('option', { key: 'default', value: '' }, t('followDefault')),
                            ...cloudProviders.map((route) =>
                              h('optgroup', {
                                key: route.id, label: route.name,
                              }, (route.models ?? []).map((model) =>
                                h('option', {
                                  key: `${route.id}|${model.id}`, value: `${route.id}|${model.id}`,
                                }, model.name)))),
                          ]),
                        ])
                      : null,
                    settings.translateEngine === 'cloud' && catalog === null
                      ? h('div', { className: 'mc-hint', key: 'cloud-loading' }, t('modelsLoading'))
                      : null,
                    settings.translateEngine === 'cloud' && catalog?.cloud?.error
                      ? h('div', { className: 'mc-hint', key: 'cloud-error' },
                          `${t('modelsFailed')}：${catalog.cloud.error}`)
                      : null,

                    settings.translateEngine === 'builtin'
                      ? h('div', { className: 'mc-grp', key: 'offline-model' }, [
                          h('span', { className: 'mc-cap', key: 'cap' }, t('offlineModel')),
                          // The download button / load state sits at the right of the
                          // picker: choosing a model loads it, and the icon tells the
                          // user whether that is still running or done.
                          h('div', { className: 'mc-irow', key: 'row' }, [
                            h('select', {
                              className: 'mc-select grow', key: 'select',
                              'aria-label': t('offlineModel'),
                              value: settings.builtinModel ?? '',
                              onChange: (event) => void command({
                                action: 'settings', settings: { builtinModel: event.target.value },
                              }),
                            }, offlineModels.map((model) => h('option', {
                              key: model.id, value: model.id,
                            }, `${model.label} · ${model.sizeMb} MB${model.downloaded ? ` · ${t('downloaded')}` : ''}`))),
                            mtLoadingThis
                              ? [
                                  h('span', {
                                    className: 'mc-spin', key: 'spin',
                                    title: t('loading'), 'aria-label': t('loading'),
                                  }),
                                  h('span', { className: 'mc-pct', key: 'pct' },
                                    mtPercent === null ? formatBytes(mt.progress?.loaded ?? 0) : `${mtPercent}%`),
                                  h('button', {
                                    className: 'mc-ghost-btn', key: 'cancel', type: 'button',
                                    onClick: () => command({ action: 'cancel_model' }),
                                  }, t('cancel')),
                                ]
                              : mtReadyThis || currentOffline?.downloaded
                                ? h('span', { className: 'mc-ok', key: 'ok', title: t('loaded'), 'aria-label': t('loaded') }, '✓')
                                : h('button', {
                                    className: 'mc-ghost-btn', key: 'download', type: 'button',
                                    disabled: busy !== '' || mt.installing,
                                    onClick: () => command({ action: 'download_model', model: settings.builtinModel }),
                                  }, t('download')),
                          ]),
                          currentOffline
                            ? h('div', { className: 'mc-hint', key: 'meta' },
                                [currentOffline.detail, currentOffline.license].filter(Boolean).join(' · '))
                            : null,
                          mt.depsInstalled === false && !mt.installing
                            ? h('div', { className: 'mc-irow', key: 'deps' }, [
                                h('span', { className: 'mc-hint', key: 'hint' }, t('depsMissing')),
                                h('button', {
                                  className: 'mc-ghost-btn', key: 'install', type: 'button',
                                  onClick: () => command({ action: 'install_mt_deps' }),
                                }, t('downloadDeps')),
                              ])
                            : null,
                          mt.installing
                            ? h('div', { className: 'mc-hint', key: 'installing' },
                                mt.installProgress?.message ?? t('mtPreparing'))
                            : null,
                          mt.state === 'failed'
                            ? h('div', { className: 'mc-error', key: 'failed' }, `${t('mtFailed')}：${mt.error ?? ''}`)
                            : null,
                          mtLoadingThis && mtPercent !== null
                            ? h('div', {
                                className: 'mc-progress', key: 'progress',
                                role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': mtPercent,
                              }, h('span', { style: { width: `${mtPercent}%` } }))
                            : null,
                          mtLoadingThis && mtPercent === null
                            ? h('div', { className: 'mc-hint', key: 'preparing' },
                                `${t('mtPreparing')} · ${formatBytes(mt.progress?.loaded ?? 0)}`)
                            : null,
                        ])
                      : null,

                    settings.translateEngine === 'local'
                      ? h('div', { className: 'mc-row', key: 'local-fields' }, [
                          h('label', { className: 'mc-field', key: 'local-url' }, [
                            h('span', { key: 'label' }, t('localUrl')),
                            h(TextField, {
                              key: 'input', value: settings.localBaseUrl ?? '',
                              placeholder: 'http://127.0.0.1:11434/v1',
                              ariaLabel: t('localUrl'),
                              onCommit: (value) => command({ action: 'settings', settings: { localBaseUrl: value } }),
                            }),
                          ]),
                          h('label', { className: 'mc-field', key: 'local-model' }, [
                            h('span', { key: 'label' }, t('localModel')),
                            h(TextField, {
                              key: 'input', value: settings.localModel ?? '',
                              placeholder: 'qwen2.5:7b',
                              ariaLabel: t('localModel'),
                              onCommit: (value) => command({ action: 'settings', settings: { localModel: value } }),
                            }),
                          ]),
                        ])
                      : null,
                    settings.translateEngine === 'local'
                      ? h('div', { className: 'mc-hint', key: 'local-hint' }, t('localHint'))
                      : null,
                    settings.translateEngine === 'local'
                      ? h('div', { className: 'mc-hint', key: 'local-note' }, t('engineLocalNote'))
                      : null,

                    // Capture, not translation: keeping the WAVs is an explicit
                    // opt-in, and the hint is the only place that says how much
                    // disk it costs.
                    h('div', { className: 'mc-grp', key: 'keep-audio' }, [
                      h('div', { className: 'mc-irow', key: 'row' }, [
                        h('span', { className: 'mc-lbl', key: 'lbl' }, t('keepAudio')),
                        h('button', {
                          className: 'mc-sw', key: 'sw', type: 'button', role: 'switch',
                          'aria-checked': keepAudio, 'aria-label': t('keepAudio'),
                          onClick: () => command({ action: 'settings', settings: { keepAudio: !keepAudio } }),
                        }),
                      ]),
                      keepAudio ? h('div', { className: 'mc-hint', key: 'hint' }, t('keepAudioHint')) : null,
                    ]),

                    !modelReady && !asrBusy && asr.available
                      ? h('div', { className: 'mc-hint', key: 'first-run' }, t('firstRunHint'))
                      : null,
                    asrBusy
                      ? h('div', { className: 'mc-download', key: 'download', role: 'status' }, [
                          h('div', { className: 'mc-download-head', key: 'head' }, [
                            h('div', { className: 'mc-spin', key: 'spin' }),
                            h('span', { className: 'mc-download-title', key: 'title' }, t('downloadTitle')),
                            h('span', { className: 'mc-download-pct', key: 'pct' },
                              percent === null ? t('preparing') : `${percent}%`),
                          ]),
                          h('div', { className: 'mc-progress', key: 'bar' },
                            h('span', { style: { width: `${percent === null ? 100 : percent}%` } })),
                          h('div', { className: 'mc-download-hint', key: 'hint' }, t('downloadHint')),
                        ])
                      : null,

                    state?.engine?.label
                      ? h('div', { className: 'mc-hint', key: 'engine-label' }, state.engine.label)
                      : null,
                  ])
                : null,
            ]),

            // Footer holds the three secondary destinations; the last one toggles
            // the advanced group so the main body stays a straight read.
            h('div', { className: 'mc-foot', key: 'foot' }, [
              h('button', {
                className: 'mc-fbtn', key: 'minutes', type: 'button',
                title: t('minutesHint'), 'aria-label': t('minutesHint'),
                disabled: busy !== '' || (state?.totalEntries ?? 0) === 0,
                onClick: () => void openMinutesSession(),
              }, t('minutes')),
              h('button', {
                className: 'mc-fbtn', key: 'records', type: 'button',
                title: t('recordsTitle'), 'aria-label': t('recordsTitle'),
                onClick: () => { setRecordsOpen((value) => !value); setLiveOpen(false); if (!recordsOpen) void loadRecords() },
              }, t('records')),
              h('button', {
                className: 'mc-fbtn icon', key: 'more', type: 'button',
                'aria-expanded': showAdvanced, title: t('moreSettings'), 'aria-label': t('moreSettings'),
                onClick: () => setShowAdvanced((value) => !value),
              }, showAdvanced ? '▾' : '⋯'),
            ]),
          ]) : null,

          h('button', {
            className: 'mc-pill', key: 'pill', type: 'button',
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open,
            'aria-label': t('open'),
            title: t('open'),
          }, [
            h('span', {
              className: 'mc-dot', key: 'dot',
              style: {
                background: statusColor(status),
                animation: running ? 'mc-pulse 2s infinite' : undefined,
              },
            }),
            h('span', { key: 'label' }, t('title')),
            // A background model download has to be visible with the panel shut,
            // otherwise the app silently pulls 230 MB.
            asrBusy
              ? h('span', { className: 'mc-pill-progress', key: 'asr-progress' },
                  percent === null ? t('preparing') : `${percent}%`)
              : null,
            running
              ? h('span', { className: 'mc-bar', key: 'bars' },
                  [0, 1, 2, 3].map((index) => h('i', { key: index })))
              : null,
            running && elapsedLabel !== null
              ? h('span', { className: 'mc-timer', key: 'timer' }, elapsedLabel)
              : null,
            h('span', { key: 'chev', style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '9px' } },
              open ? '▾' : '▸'),
          ]),
        ]),
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, DICT), 'live-captions: locale')
        } catch (error) {
          console.warn('[live-captions] locale registration failed', error)
        }
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'live-captions',
          order: 40,
          label: () => (localeId(ctx) === 'zh' ? '实时字幕' : 'Live captions'),
        }, (props) => h(Overlay, { ...props, ctx })))
      },
    }
  },
})
