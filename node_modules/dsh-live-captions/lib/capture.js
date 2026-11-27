import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../native/capture.ps1', import.meta.url))

/** Locate the Windows PowerShell host that can compile the capture helper. */
function powershellPath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ]
  for (const candidate of candidates) {
    if (candidate === 'powershell.exe' || existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/**
 * Own one capture helper process. Segment files are reported through
 * `onSegment`; stdout JSON lines also drive status reporting.
 *
 * Platform backends share the stdout protocol:
 * - Windows: `native/capture.ps1` (WASAPI loopback via PowerShell + C#).
 * - macOS:   `native/capture.swift` (ScreenCaptureKit loopback + AVAudioEngine),
 *            compiled and cached by `native-bin.js`.
 */
export function startCapture(options) {
  const {
    outDir,
    segmentSeconds = 8,
    minSegmentSeconds = 1.2,
    source = 'both',
    onSegment = () => {},
    onDraft = () => {},
    onStatus = () => {},
    onWarning = () => {},
    log = () => {},
  } = options

  if (process.platform === 'darwin') {
    const binary = options.nativeCapture
    if (binary === undefined || typeof binary !== 'string') {
      onStatus({
        phase: 'error',
        error: 'macOS 采集助手尚未就绪：需要 Xcode Command Line Tools（`xcode-select --install`）。',
      })
      return { get ready() { return false }, get pid() { return null }, async stop() {} }
    }
    return startProcess({
      command: binary,
      args: [
        '--out-dir', outDir,
        '--segment-seconds', String(segmentSeconds),
        '--min-segment-seconds', String(minSegmentSeconds),
        '--source', source,
        '--sample-rate', '16000',
      ],
      outDir,
      log,
      onSegment,
      onDraft,
      onStatus,
      onWarning,
      exitedNote: '采集进程提前退出，请检查屏幕录制/麦克风权限（系统设置 → 隐私与安全性）。',
    })
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    SCRIPT,
    '-OutDir',
    outDir,
    '-SegmentSeconds',
    String(segmentSeconds),
    '-MinSegmentSeconds',
    String(minSegmentSeconds),
    '-Source',
    source,
  ]
  log(`capture: starting ${source} -> ${outDir}`)
  return startProcess({
    command: powershellPath(),
    args,
    windowsHide: true,
    outDir,
    log,
    onSegment,
    onDraft,
    onStatus,
    onWarning,
    exitedNote: '采集进程提前退出，请检查系统声音设备与麦克风权限。',
  })
}

/**
 * Shared process plumbing: stdout JSON protocol, sweep for lost segment
 * lines, stop flag and graceful teardown. Identical on every platform.
 */
function startProcess({
  command,
  args,
  windowsHide,
  outDir,
  log,
  onSegment,
  onDraft,
  onStatus,
  onWarning,
  exitedNote,
}) {
  mkdirSync(outDir, { recursive: true })
  const stopFile = join(outDir, 'stop.flag')
  if (existsSync(stopFile)) rmSync(stopFile, { force: true })
  for (const name of readdirSync(outDir)) {
    if (name.endsWith('.wav')) rmSync(join(outDir, name), { force: true })
  }

  log(`capture: starting ${args.join(' ')} -> ${outDir}`)
  const child = spawn(command, args, {
    windowsHide: windowsHide === true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let ready = false
  let stdoutBuffer = ''
  const reported = new Set()
  let stopped = false
  let exitResolve
  const exited = new Promise((resolve) => { exitResolve = resolve })

  const emit = (file, reason, index) => {
    if (reported.has(file)) return
    reported.add(file)
    onSegment({ file: join(outDir, file), reason: reason === 'cut' ? 'cut' : 'pause', index })
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    let index
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, index).trim()
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        log(`capture: ${line}`)
        continue
      }
      if (message.type === 'ready') {
        ready = true
        onStatus({ phase: 'capturing' })
      } else if (message.type === 'segment') {
        emit(message.file, message.reason, message.index)
      } else if (message.type === 'draft') {
        onDraft({ file: join(outDir, message.file), seconds: message.seconds, index: message.index })
      } else if (message.type === 'warning') {
        log(`capture warning: ${message.warning}`)
        onWarning(message.warning)
      } else if (message.type === 'error') {
        log(`capture error: ${message.error}`)
        onStatus({ phase: 'error', error: message.error })
      }
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text !== '') log(`capture stderr: ${text}`)
  })

  child.on('error', (error) => {
    log(`capture spawn failed: ${error.message}`)
    onStatus({ phase: 'error', error: `无法启动采集进程：${error.message}` })
    exitResolve()
  })

  child.on('exit', (code, signal) => {
    log(`capture exited code=${code} signal=${signal}`)
    if (!stopped) {
      onStatus({
        phase: 'exited',
        error: ready ? undefined : exitedNote,
      })
    }
    exitResolve()
  })

  // The helper announces each finished segment; this sweep covers a lost line.
  // A file is complete once a newer segment file exists, so skip the newest.
  const sweep = setInterval(() => {
    let files
    try {
      files = readdirSync(outDir).filter((name) => name.endsWith('.wav') && !name.startsWith('draft-')).sort()
    } catch {
      return
    }
    for (let index = 0; index < files.length - 1; index += 1) emit(files[index])
  }, 1000)

  return {
    get ready() { return ready },
    get pid() { return child.pid },
    async stop() {
      if (stopped) return exited
      stopped = true
      clearInterval(sweep)
      try {
        writeFileSync(stopFile, 'stop')
      } catch (error) {
        log(`capture: could not write stop flag: ${error.message}`)
      }
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 4000)),
      ])
      if (!graceful) {
        log('capture: terminating')
        try { child.kill() } catch { /* already gone */ }
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ])
      }
      clearInterval(sweep)
      try { rmSync(stopFile, { force: true }) } catch { /* already gone */ }
      return exited
    },
  }
}
