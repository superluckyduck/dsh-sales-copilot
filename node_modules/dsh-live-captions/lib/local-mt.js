import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MT_MODELS, checkPair, defaultMtModelId, detectLanguage, findMtModel, langCodeFor,
} from './mt-models.js'

const SERVER = fileURLToPath(new URL('./mt-server.js', import.meta.url))
// Resolves from this file's directory, which is exactly the resolution scope the
// mt-server child uses for `@huggingface/transformers`.
const require = createRequire(import.meta.url)
const MT_DEP = '@huggingface/transformers'

/**
 * Owns the translation child process: model download/load progress, one queued
 * request at a time, and clean teardown. A crash inside ONNX Runtime only ends
 * this child, and the next request respawns it.
 */
export function createLocalMt({ dataRoot, config, packageDir, log, modelOf }) {
  const cacheDir = join(dataRoot, 'models', 'mt')
  const configured = typeof config?.mtModel === 'string' && config.mtModel !== '' ? config.mtModel : null
  const hosts = Array.isArray(config?.mtHosts) && config.mtHosts.length > 0
    ? config.mtHosts
    : ['https://hf-mirror.com', 'https://huggingface.co']

  /** Current model id: the setting, then the config, then the shipped default. */
  function currentModelId() {
    const chosen = modelOf?.()
    if (typeof chosen === 'string' && chosen !== '') return chosen
    return configured ?? defaultMtModelId()
  }

  let modelId = currentModelId()

  let child = null
  let state = 'idle' // idle | loading | ready | failed
  let error = null
  let hostIndex = 0
  let disposed = false
  let seq = 0
  let stdoutBuffer = ''
  let lastUsed = Date.now()
  let lastProgressAt = Date.now()
  let missingDeps = false
  let loggedResolveFailure = false
  let installing = false
  let installProgress = null
  // Set while a model is being fetched from scratch, so a cancel can throw the
  // half-written weights away instead of leaving a cache the loader chokes on.
  let freshDownload = null
  // Whether the active model already had files before this attempt: a load that
  // then fails on the files themselves means the cache is stale, not the network.
  let hadCache = false
  const pending = new Map()
  const files = new Map()
  const waiters = new Set()

  /**
   * Where the weights live. transformers.js writes `<cacheDir>/<org>/<name>/`,
   * while the Hugging Face hub cache uses `models--org--name`; accept both so a
   * pre-populated download is never offered again.
   */
  function modelDirs(id) {
    const [org, name] = id.split('/')
    return [
      join(cacheDir, org ?? id, name ?? ''),
      join(cacheDir, `models--${id.replace('/', '--')}`),
    ]
  }

  /** Every .onnx under a model directory, with its size. */
  function onnxFiles(dir, depth = 0, out = []) {
    if (depth > 4) return out
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        onnxFiles(full, depth + 1, out)
      } else if (entry.isFile() && entry.name.endsWith('.onnx')) {
        try {
          out.push({ name: entry.name, size: statSync(full).size })
        } catch { /* vanished */ }
      }
    }
    return out
  }

  /**
   * A model counts as downloaded only when both halves of the seq2seq graph are
   * on disk and non-empty. A killed download leaves zero-byte or truncated .onnx
   * files, and "the file exists" is exactly the trap that made a broken cache
   * look ready while loading fell through to the network.
   */
  function hasWeights(dir) {
    const files = onnxFiles(dir)
    const encoder = files.some((file) => /encoder/i.test(file.name) && file.size > 1024 * 1024)
    const decoder = files.some((file) => /decoder/i.test(file.name) && file.size > 1024 * 1024)
    return encoder && decoder
  }

  /** Whether one catalog model already sits fully in the local cache. */
  function isDownloaded(id) {
    return modelDirs(id).some((dir) => hasWeights(dir))
  }


  /**
   * Whether the built-in translation dependency can be resolved right now.
   */
  function depsInstalled() {
    try {
      require.resolve(MT_DEP)
      return true
    } catch (error) {
      if (!loggedResolveFailure) {
        loggedResolveFailure = true
        log(`mt: ${MT_DEP} resolve failed: ${error.message.split('\n')[0]}`)
      }
      return false
    }
  }

    // The model holds roughly 600 MB of RAM; give it back when nothing uses it.
  const idleTimer = setInterval(() => {
    if (state !== 'ready' || child === null || pending.size > 0) return
    if (Date.now() - lastUsed < 10 * 60 * 1000) return
    log('mt: releasing idle translation process')
    const current = child
    child = null
    state = 'idle'
    try { current.kill() } catch { /* already gone */ }
  }, 60 * 1000)
  idleTimer.unref?.()

  // A mirror can accept a connection and then stop sending bytes; without a
  // watchdog the download sits there forever and looks like "fetch failed" much
  // later. Abort after a minute without progress so a retry can switch hosts.
  const stallTimer = setInterval(() => {
    if (state !== 'loading' || child === null) return
    if (Date.now() - lastProgressAt < 60 * 1000) return
    log('mt: download stalled for 60s, aborting')
    const current = child
    child = null
    try { current.kill() } catch { /* already gone */ }
    if (freshDownload !== null) {
      discardCorruptCache(freshDownload)
      freshDownload = null
    }
    fail('下载停滞超过 60 秒：当前下载源太慢或网络不稳，已停止。再点一次「下载」会自动换源重试。')
  }, 15 * 1000)
  stallTimer.unref?.()

  /**
   * Download URLs for the files in flight — or, when the failure arrived before
   * any progress event, the model's two weight files — so the error names the
   * exact address that failed.
   */
  function downloadUrls() {
    const host = hosts[hostIndex]
    const names = files.size > 0
      ? [...files.keys()]
      : (findMtModel(modelId)?.weights ?? [])
    return names.slice(0, 3).map((name) => `${host}/${modelId}/resolve/main/${name}`)
  }

  function progress() {
    let loaded = 0
    let total = 0
    for (const entry of files.values()) {
      loaded += entry.loaded
      total += entry.total
    }
    return { loaded, total, files: files.size }
  }

  function describe() {
    return {
      model: modelId,
      label: findMtModel(modelId)?.label ?? modelId,
      state,
      error,
      host: hosts[hostIndex],
      progress: progress(),
      cacheDir,
      depsInstalled: depsInstalled(),
      missingDeps,
      installing,
      installProgress,
      // The catalog travels with every state payload so the panel can offer the
      // models and show which ones are already on disk.
      models: MT_MODELS.map((entry) => ({
        id: entry.id,
        label: entry.label,
        detail: entry.detail,
        sizeMb: entry.sizeMb,
        license: entry.license,
        family: entry.family,
        downloaded: isDownloaded(entry.id),
      })),
    }
  }

  /**
   * Switch the active offline model. Any loaded process is dropped first, so the
   * next translation loads (and, if needed, downloads) the new weights.
   */
  function setModel(id) {
    if (typeof id !== 'string' || id === '' || !findMtModel(id)) return { ok: false, error: '未知的离线模型' }
    if (id === modelId) return { ok: true, note: '模型未变化' }
    const current = child
    if (current !== null) {
      child = null
      try { current.kill() } catch { /* already gone */ }
    }
    modelId = id
    state = 'idle'
    error = null
    missingDeps = false
    files.clear()
    log(`mt: model switched to ${id}`)
    return { ok: true }
  }

  /** Explicit "download and load" for one catalog model. */
  function download(id, { restart = false } = {}) {
    const switched = setModel(id)
    if (switched.ok === false) return switched
    if (restart) {
      // The button means "fetch it now": throw away whatever partial files an
      // earlier interrupted attempt left, which transformers.js would otherwise
      // reuse and fail to parse.
      const current = child
      if (current !== null) {
        child = null
        try { current.kill() } catch { /* already gone */ }
      }
      for (const dir of modelDirs(modelId)) {
        try { rmSync(dir, { recursive: true, force: true }) } catch (failure) { log(`mt: cannot clear ${dir}: ${failure.message}`) }
      }
      state = 'idle'
      error = null
      freshDownload = null
      files.clear()
    }
    return prepare()
  }

  function notify() {
    for (const waiter of waiters) waiter()
  }

  /** Failure text that means the weights on disk are unusable, not that the
   * network or the Host is at fault. */
  const CORRUPT = /protobuf|invalid model|can'?t load|failed to load|unexpected end|corrupt/i
  /** A network failure on top of an existing cache means the cache is unusable. */
  const STALE_FETCH = /fetch failed|network|enotfound|etimedout|econnrefused|http error|request failed/i

  /**
   * Throw away a cache that failed to load. A download killed halfway (plugin
   * reload, cancel, power loss) leaves files that exist but cannot be parsed, and
   * "file exists" is the only completeness signal transformers.js leaves behind.
   */
  function discardCorruptCache(id) {
    const dirs = modelDirs(id)
    setTimeout(() => {
      for (const dir of dirs) {
        try { rmSync(dir, { recursive: true, force: true }) } catch (failure) { log(`mt: cannot remove ${dir}: ${failure.message}`) }
      }
      log(`mt: discarded corrupt cache for ${id}`)
      notify()
    }, 1200).unref?.()
  }

  function fail(message, { missing = false } = {}) {
    // A load that fails on the weights themselves — or that ends up needing the
    // network even though files are on disk — means the cache is damaged; wipe it
    // so the panel offers a fresh download instead of a broken "已下载".
    const damaged = !missing && hadCache && (CORRUPT.test(message) || STALE_FETCH.test(message))
    if (damaged) {
      discardCorruptCache(modelId)
      message = `${findMtModel(modelId)?.label ?? modelId} 的本地缓存不完整（上次下载中断过），已自动清除，请重新下载。`
    }
    // A failed download names the exact addresses it was fetching, whether it
    // died mid-file or before the first progress event.
    if (state === 'loading' && !missing && !message.includes('/resolve/')) {
      const urls = downloadUrls()
      if (urls.length > 0) message = `${message}（下载地址：${urls.join(' ')}）`
    }
    hadCache = false
    if (state === 'failed' && error === message && missingDeps === missing) return
    state = 'failed'
    error = message
    missingDeps = missing
    freshDownload = null
    log(`mt: ${message}`)
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(message))
      pending.delete(id)
    }
    notify()
  }

  function handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.type === 'ready') {
      state = 'ready'
      error = null
      freshDownload = null
      hadCache = false
      lastUsed = Date.now()
      log('mt: ready')
      notify()
      return
    }
    if (message.type === 'fatal') {
      fail(message.error ?? '内置翻译模型加载失败', { missing: message.code === 'missing-deps' })
      return
    }
    if (message.type === 'progress') {
      lastProgressAt = Date.now()
      const payload = message.payload ?? {}
      const name = payload.file ?? 'model'
      if (payload.status === 'progress' || payload.status === 'download') {
        files.set(name, { loaded: payload.loaded ?? 0, total: payload.total ?? 0 })
      } else if (payload.status === 'done') {
        const entry = files.get(name)
        if (entry !== undefined && entry.total > 0) entry.loaded = entry.total
      }
      return
    }
    if (message.type === 'result' || message.type === 'error') {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.type === 'result') entry.resolve(String(message.text ?? ''))
      else entry.reject(new Error(message.error ?? '翻译失败'))
    }
  }

  function ensureChild() {
    if (disposed) throw new Error('插件已卸载')
    if (child !== null) return child
    if (state === 'ready') return null
    if (missingDeps || !depsInstalled()) {
      fail('内置离线翻译的依赖（@huggingface/transformers）未安装', { missing: true })
      throw new Error('内置翻译依赖未安装')
    }
    mkdirSync(cacheDir, { recursive: true })
    state = 'loading'
    error = null
    lastProgressAt = Date.now()
    hadCache = modelDirs(modelId).some((dir) => existsSync(dir))
    if (!isDownloaded(modelId)) freshDownload = modelId
    log(`mt: starting translation process for ${modelId} (${hosts[hostIndex]})`)
    child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MT_CACHE_DIR: cacheDir,
        MT_REMOTE_HOST: hosts[hostIndex],
        MT_MODEL: modelId,
        MT_FAMILY: findMtModel(modelId)?.family ?? 'm2m100',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk
      let index
      while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, index).trim()
        stdoutBuffer = stdoutBuffer.slice(index + 1)
        if (line !== '') handleLine(line)
      }
    })

    child.stderr.setEncoding('utf8')
    let stderrSeen = 0
    child.stderr.on('data', (chunk) => {
      if (stderrSeen > 4000) return
      stderrSeen += chunk.length
      const text = String(chunk).trim()
      if (text !== '') log(`mt stderr: ${text.slice(0, 400)}`)
    })

    child.on('error', (spawnError) => {
      child = null
      fail(`翻译进程启动失败：${spawnError.message}`)
    })

    child.on('exit', (code, signal) => {
      child = null
      if (disposed) return
      if (state !== 'failed') {
        fail(`翻译进程退出（code ${code}${signal ? `, ${signal}` : ''}）`)
      }
      // Try the next download source once the process died before readiness.
      if (state === 'failed' && hosts.length > 1) hostIndex = (hostIndex + 1) % hosts.length
    })

    return child
  }

  /** Start the process without waiting; safe to call repeatedly. */
  function prepare() {
    try {
      // The setting may have changed since the last call; switching drops the
      // loaded process so the next readiness comes from the new weights.
      const chosen = currentModelId()
      if (chosen !== modelId) setModel(chosen)
      if (state === 'ready') return { ok: true }
      ensureChild()
      return { ok: true }
    } catch (failure) {
      return { ok: false, error: failure.message }
    }
  }

  /**
   * Install the built-in translation dependency on the user's explicit request.
   * The dependency is intentionally NOT a package dependency, so installing the
   * plugin stays light; it lands here only when someone picks the built-in or
   * offline engine.
   */
  async function installDeps() {
    if (depsInstalled()) {
      missingDeps = false
      state = 'idle'
      error = null
      return { ok: true, note: '依赖已就绪' }
    }
    if (installing) return { ok: false, error: '正在下载内置翻译依赖，请稍候。' }
    if (packageDir === null) {
      return { ok: false, error: '无法定位插件目录，请手动在插件目录执行 npm install @huggingface/transformers。' }
    }
    installing = true
    installProgress = { phase: 'installing', message: `正在下载 ${MT_DEP}…` }
    try {
      await runInstall()
      await ensureSharp()
      missingDeps = false
      installProgress = { phase: 'done' }
      state = 'idle'
      error = null
      hostIndex = 0
      return { ok: true, note: '依赖已安装，正在加载内置翻译模型…' }
    } catch (failure) {
      installProgress = null
      return { ok: false, error: `依赖下载失败：${failure.message}` }
    } finally {
      installing = false
    }
  }

  function runInstall() {
    return new Promise((resolve, reject) => {
      const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      // Use the Alibaba npm mirror so the dependency installs on a domestic
      // network; it is the same package as npmjs.org, only reachable from China.
      const args = ['install', '--no-save', '--no-audit', '--no-fund', '--no-package-lock',
        '--registry', 'https://registry.npmmirror.com', `${MT_DEP}@^3.0.0`]
      log(`mt: installing ${MT_DEP} into ${packageDir} (npmmirror)`)
      const child = spawn(command, args, {
        cwd: packageDir,
        windowsHide: true,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let tail = ''
      const capture = (chunk) => {
        const text = String(chunk).trim()
        if (text !== '') {
          tail = text.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? text
          installProgress = { phase: 'installing', message: tail.slice(0, 120) }
        }
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', capture)
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', capture)
      child.on('error', (spawnError) => reject(new Error(spawnError.message)))
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`npm 退出码 ${code}${tail ? `（${tail.slice(0, 160)}）` : ''}`))
      })
    })
  }

  /**
   * transformers.js needs the sharp native binding; a partial or pruned
   * install (npm with --no-save can drop packages mid-flight) leaves
   * `@img/sharp-<platform>-<arch>` out, which then fails only when the model
   * loads. Detect that and install the platform package explicitly.
   */
  async function ensureSharp() {
    if (process.platform === 'win32') return // not needed for the Windows build
    const native = `@img/sharp-${process.platform}-${process.arch}`
    try {
      require.resolve(native)
      return
    } catch { /* missing, install below */ }
    log(`mt: installing missing ${native}`)
    await new Promise((resolve, reject) => {
      const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const args = ['install', '--no-save', '--no-audit', '--no-fund', '--no-package-lock',
        '--registry', 'https://registry.npmmirror.com',
        `@img/sharp-${process.platform}-${process.arch}`,
        `@img/sharp-libvips-${process.platform}-${process.arch}`,
        MT_DEP]
      const child = spawn(command, args, {
        cwd: packageDir,
        windowsHide: true,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.on('error', (spawnError) => reject(new Error(spawnError.message)))
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${native} 补装失败（npm 退出码 ${code}）`))
      })
    })
  }

  async function waitReady(timeoutMs = 20 * 60 * 1000) {
    if (state === 'ready') return
    if (state === 'failed') {
      // A previous failure may be transient (network, crash): retry once.
      if (child !== null) {
        try { child.kill() } catch { /* already gone */ }
        child = null
      }
      state = 'idle'
      error = null
    }
    if (child === null) ensureChild()
    if (state === 'ready') return
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error('内置翻译模型准备超时'))
      }, timeoutMs)
      const check = () => {
        if (state === 'ready') {
          clearTimeout(timer)
          waiters.delete(check)
          resolve()
        } else if (state === 'failed') {
          clearTimeout(timer)
          waiters.delete(check)
          reject(new Error(error ?? '内置翻译模型不可用'))
        }
      }
      waiters.add(check)
    })
  }

  /**
   * Translate one line. Waits for the model (first use downloads it), then
   * queues behind earlier lines because the child handles one at a time.
   */
  async function translate(text, { sourceLanguage, targetLanguage, timeoutMs = 180000 } = {}) {
    const model = findMtModel(modelId) ?? findMtModel(defaultMtModelId())
    const target = langCodeFor(model, targetLanguage)
    if (target === undefined) throw new Error(`${model.label} 不支持目标语言：${targetLanguage}`)
    const detected = detectLanguage(text, sourceLanguage)
    const pairProblem = checkPair(model, detected, targetLanguage)
    if (pairProblem !== null) throw new Error(pairProblem)
    await waitReady()
    if (child === null) throw new Error('翻译进程不可用')
    const source = langCodeFor(model, detected)
    if (source === undefined) throw new Error(`${model.label} 无法识别源语言：${detected}`)
    if (source === target) return text
    lastUsed = Date.now()
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('本地翻译超时'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ type: 'translate', id, text, src: source, tgt: target })}\n`)
    })
  }

  /**
   * Abort a download/load in progress. A first-time download is discarded (the
   * process is killed, then its half-written directory is removed) so the next
   * attempt starts clean; a model that was already cached is simply unloaded.
   */
  function cancel() {
    const current = child
    const target = freshDownload
    freshDownload = null
    if (current === null && state === 'idle') return { ok: true, note: '没有正在进行的下载' }
    child = null
    state = 'idle'
    error = null
    missingDeps = false
    files.clear()
    if (current !== null) {
      try { current.kill() } catch { /* already gone */ }
    }
    if (target !== null) {
      // Give the child a moment to exit before deleting what it was writing.
      setTimeout(() => {
        for (const dir of modelDirs(target)) {
          try { rmSync(dir, { recursive: true, force: true }) } catch (failure) { log(`mt: cleanup failed: ${failure.message}`) }
        }
        log(`mt: discarded partial download of ${target}`)
      }, 1500).unref?.()
    }
    log(`mt: cancelled ${modelId}`)
    notify()
    return { ok: true }
  }

  async function dispose() {
    disposed = true
    clearInterval(idleTimer)
    clearInterval(stallTimer)
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('插件已卸载'))
      pending.delete(id)
    }
    const current = child
    child = null
    state = 'idle'
    if (current !== null) {
      try { current.kill() } catch (failure) { log(`mt: kill failed: ${failure.message}`) }
    }
    // An unload in the middle of a first-time download leaves unparsable weights
    // behind; drop them once the killed child releases the files so the next
    // start offers a clean download instead of a broken cache.
    const discard = freshDownload
    freshDownload = null
    if (discard !== null) {
      setTimeout(() => {
        for (const dir of modelDirs(discard)) {
          try { rmSync(dir, { recursive: true, force: true }) } catch { /* still locked */ }
        }
        log(`mt: discarded partial download of ${discard} on unload`)
      }, 1500).unref?.()
    }
  }

  return {
    describe, prepare, translate, waitReady, installDeps, depsInstalled, dispose,
    setModel, download, cancel, isDownloaded,
    get model() { return modelId },
  }

}
