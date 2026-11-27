const PREFIX = '/live-captions/api'
const MAX_BODY = 64 * 1024

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * Same-origin JSON API used by the Web panel: one poll endpoint plus one
 * command endpoint. The agent tool drives the same controller methods.
 */
export function registerApi({ ctx, controller, overlay, log }) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    log('api: web server unavailable, the panel will not be able to poll')
    return () => {}
  }

  const handler = async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith(PREFIX)) {
        json(response, 404, { ok: false, error: 'not found' })
        return
      }
      const route = url.pathname.slice(PREFIX.length) || '/'

      if (request.method === 'GET' && (route === '/state' || route === '/')) {
        const since = Number(url.searchParams.get('since') ?? '0')
        json(response, 200, { ok: true, state: controller.state(Number.isFinite(since) ? since : 0) })
        return
      }

      if (request.method === 'GET' && route === '/sessions') {
        json(response, 200, { ok: true, sessions: controller.listSessions() })
        return
      }

      if (request.method === 'GET' && route === '/records') {
        const sessions = controller.listSessions()
        const requested = url.searchParams.get('session')
        const sessionId = requested !== null && requested !== '' ? requested : sessions[0]?.id
        if (sessionId === undefined || sessionId === null) {
          json(response, 200, { ok: true, sessionId: null, sessions, records: { entries: [] } })
          return
        }
        json(response, 200, {
          ok: true,
          sessionId,
          sessions,
          records: controller.readRecords(sessionId),
        })
        return
      }

      if (request.method === 'GET' && route === '/models') {
        const cloud = await controller.listCloudModels()
        json(response, 200, { ok: true, cloud, offline: controller.offlineModels() })
        return
      }

      // The always-on-top overlay window is a PowerShell/WPF process: it pulls
      // its labels, look and starting geometry from here so the script itself
      // stays ASCII-only (Windows PowerShell 5.1 would mangle a UTF-8 script).
      if (request.method === 'GET' && route === '/overlay-boot') {
        const settings = controller.settings
        json(response, 200, {
          ok: true,
          labels: {
            title: '字幕桌面浮层',
            font: '字号',
            dim: '透明度',
            fontOut: 'A−',
            fontIn: 'A+',
            dimOut: '◐−',
            dimIn: '◐+',
            source: '原文',
            sourceOn: '原文✓',
            sourceOff: '原文✕',
            lock: '🔒',
            lockHint: '锁定后点击穿透，在面板里解锁',
            close: '隐藏浮层',
            closeGlyph: '×',
            listening: '正在聆听…',
            idle: '浮层已就绪，开始采集后显示字幕。',
          },
          settings: {
            lyricFontSize: settings.lyricFontSize,
            lyricOpacity: settings.lyricOpacity,
            lyricShowSource: settings.lyricShowSource,
            lyricLocked: settings.lyricLocked,
          },
          geometry: {
            x: settings.lyricX,
            y: settings.lyricY,
            w: settings.lyricW,
            h: settings.lyricH,
          },
        })
        return
      }

      if (request.method === 'GET' && route === '/minutes-prompt') {
        const title = url.searchParams.get('title') ?? undefined
        json(response, 200, { ok: true, ...controller.minutesPrompt({ title }) })
        return
      }

      if (request.method === 'POST' && route === '/command') {
        const body = await readJson(request)
        const action = typeof body.action === 'string' ? body.action : ''
        let result
        switch (action) {
          case 'start':
            result = controller.start()
            break
          case 'stop':
            result = await controller.stop()
            break
          case 'prepare':
            result = controller.prepare()
            break
          case 'install_clt':
            result = controller.startCLTInstall()
            break
          case 'clear':
            controller.clear()
            result = { ok: true }
            break
          case 'install_mt_deps': {
            const install = controller.installMtDeps()
            install.catch((error) => log(`mt deps install failed: ${error.message}`))
            result = { ok: true, installing: true }
            break
          }
          case 'download_model': {
            result = controller.downloadOfflineModel(body.model)
            break
          }
          case 'cancel_model': {
            result = controller.cancelOfflineModel()
            break
          }
          case 'delete_session': {
            result = controller.deleteSession(String(body.session ?? ''))
            break
          }
          case 'overlay_open': {
            // Opening the window *is* making the overlay visible: the panel and
            // the window share one switch, so a stale `lyricVisible: false`
            // must not close the window the user just asked for.
            controller.updateSettings({ lyricVisible: true })
            result = overlay !== undefined ? overlay.open(controller.settings) : { ok: false, error: '此环境无法创建系统置顶窗口' }
            break
          }
          case 'overlay_close': {
            controller.updateSettings({ lyricVisible: false })
            if (overlay !== undefined) overlay.close()
            result = { ok: true }
            break
          }
          case 'settings':
            controller.updateSettings(body.settings ?? {})
            if (overlay !== undefined) overlay.sync(controller.settings)
            result = { ok: true }
            break
          case 'minutes': {
            const minutes = controller.generateMinutes({ title: body.title })
            minutes.catch((error) => log(`minutes failed: ${error.message}`))
            result = { ok: true, generating: true }
            break
          }
          default:
            json(response, 400, { ok: false, error: `未知操作：${action}` })
            return
        }
        if (result?.ok === false) {
          json(response, 409, { ok: false, error: result.error ?? '操作失败', state: controller.state(0) })
          return
        }
        const since = Number(body.since ?? 0)
        json(response, 200, { ok: true, result, state: controller.state(Number.isFinite(since) ? since : 0) })
        return
      }

      json(response, 405, { ok: false, error: '不支持的请求' })
    } catch (error) {
      log(`api: ${error.message}`)
      try {
        json(response, 500, { ok: false, error: error.message })
      } catch {
        // response already sent
      }
    }
  }

  try {
    return webServer.register({ kind: 'prefix', path: PREFIX, handler })
  } catch (error) {
    log(`api: registration failed: ${error.message}`)
    return () => {}
  }
}
