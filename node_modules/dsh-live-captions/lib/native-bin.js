/**
 * Build and cache the macOS Swift helpers (capture, overlay).
 *
 * The plugin ships the Swift sources in `native/`; on first use on a Mac they
 * are compiled once with the system `swiftc` into `<dataRoot>/bin` and cached
 * keyed by the source hash, so an upgrade of the plugin recompiles exactly
 * once. Every other platform (and a Mac without the command line tools)
 * reports `supported: false` and the caller shows its usual fallback.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HELPERS = {
  capture: {
    source: 'capture.swift',
    frameworks: ['AVFoundation', 'ScreenCaptureKit', 'CoreMedia'],
  },
  overlay: {
    source: 'overlay.swift',
    frameworks: ['AppKit'],
  },
}

let swiftcPathCache

function swiftcPath() {
  if (swiftcPathCache !== undefined) return swiftcPathCache
  swiftcPathCache = null
  for (const candidate of ['/usr/bin/swiftc', '/Library/Developer/CommandLineTools/usr/bin/swiftc']) {
    if (existsSync(candidate)) {
      swiftcPathCache = candidate
      break
    }
  }
  return swiftcPathCache
}

function runSwiftc(args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const useXcrun = swiftcPath() === '/usr/bin/swiftc'
    const child = spawn(useXcrun ? '/usr/bin/xcrun' : swiftcPath(),
      useXcrun ? ['-sdk', 'macosx', 'swiftc', ...args] : args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, timeoutMs)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error.message })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, error: code === 0 ? null : stderr.trim().split('\n').slice(-6).join('\n') })
    })
  })
}

/**
 * Resolve (building on demand) one helper binary.
 * Returns `{ ok, path?, building?, error? }`. Concurrent callers share the
 * same in-flight build; the promise is memoised per source hash.
 */
export function createNativeBin({ packageDir, cacheRoot, log }) {
  if (process.platform !== 'darwin') {
    return { supported: false, describe: () => ({ supported: false }) }
  }
  if (packageDir === null || packageDir === undefined) {
    return { supported: false, describe: () => ({ supported: false, error: '插件目录不可用' }) }
  }

  const binRoot = join(cacheRoot, 'bin')
  const inflight = new Map()

  function describe(name) {
    const helper = HELPERS[name]
    if (helper === undefined) return { supported: false, error: `未知助手：${name}` }
    if (swiftcPath() === null) {
      return {
        supported: false,
        error: '需要 Xcode Command Line Tools（swiftc）。请运行 `xcode-select --install` 后重试。',
      }
    }
    try {
      const source = readFileSync(join(packageDir, 'native', helper.source))
      const hash = createHash('sha256').update(source).digest('hex').slice(0, 12)
      const path = join(binRoot, `${name}-${hash}`)
      const result = { supported: true, path, hash, current: existsSync(path) }
      if (existsSync(path)) {
        try {
          writeFileSync(join(binRoot, `${name}-${hash}.origin`), join(packageDir, 'native', helper.source))
        } catch { /* best effort marker */ }
      }
      return result
    } catch (error) {
      return { supported: false, error: error.message }
    }
  }

  async function ensure(name) {
    const state = describe(name)
    if (state.supported !== true) {
      return { ok: false, error: state.error ?? '当前环境无法编译采集助手' }
    }
    if (state.current) return { ok: true, path: state.path }
    const pending = inflight.get(state.path)
    if (pending !== undefined) return pending

    const helper = HELPERS[name]
    const build = (async () => {
      mkdirSync(binRoot, { recursive: true })
      const sourcePath = join(packageDir, 'native', helper.source)
      const target = join(binRoot, `${name}-${state.hash}`)
      const temp = `${target}.build-${process.pid}`
      rmSync(temp, { force: true })
      log(`native-bin: building ${name} -> ${target}`)
      const result = await runSwiftc([
        '-O',
        ...helper.frameworks.flatMap((framework) => ['-framework', framework]),
        '-o', temp,
        sourcePath,
      ])
      if (result.ok !== true) {
        log(`native-bin: build failed: ${result.error}`)
        return { ok: false, error: `编译 ${name} 助手失败：${result.error}` }
      }
      // Atomic publish: concurrent readers either see nothing or the binary.
      try { rmSync(target, { force: true }) } catch { /* first install */ }
      renameSync(temp, target)
      log(`native-bin: built ${name}`)
      return { ok: true, path: target }
    })()
    inflight.set(state.path, build)
    try {
      return await build
    } finally {
      inflight.delete(state.path)
    }
  }

  return { supported: true, ensure, describe }
}
