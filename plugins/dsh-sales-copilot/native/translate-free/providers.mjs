/**
 * 免费翻译提供方：Google（gtx 端点）+ Microsoft（Bing 网页会话端点）。
 *
 * 两条都是"免密钥"通道，因此都不稳定：
 *   - Google：translate_a/single 客户端端点，无 key，超量会 429；
 *   - Microsoft：老的 edge.microsoft.com/translate/auth 已 404 下线，
 *     现在只能走 www.bing.com 网页会话（key/token + IG/IID + cookie），
 *     token 约 1 小时过期，过期后要重新取一次。
 * 所以默认链路是 Google → 失败再落到 Microsoft。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 语言名（live-captions 用中文名传目标语言）→ 各家的语言代码 */
const LANG_TABLE = [
  { names: ['简体中文', '中文', 'zh', 'zh-cn', 'zh-hans'], google: 'zh-CN', bing: 'zh-Hans' },
  { names: ['繁體中文', '繁体中文', 'zh-tw', 'zh-hant'], google: 'zh-TW', bing: 'zh-Hant' },
  { names: ['粤语', '粵語', 'yue', 'cantonese'], google: 'zh-TW', bing: 'zh-Hant' },
  { names: ['English', '英语', '英文', 'en'], google: 'en', bing: 'en' },
  { names: ['日本語', '日语', '日文', 'ja'], google: 'ja', bing: 'ja' },
  { names: ['한국어', '韩语', '韩文', 'ko'], google: 'ko', bing: 'ko' },
  { names: ['Español', '西班牙语', 'es'], google: 'es', bing: 'es' },
  { names: ['Français', '法语', 'fr'], google: 'fr', bing: 'fr' },
  { names: ['Deutsch', '德语', 'de'], google: 'de', bing: 'de' },
  { names: ['Русский', '俄语', 'ru'], google: 'ru', bing: 'ru' },
  { names: ['Português', '葡萄牙语', 'pt'], google: 'pt', bing: 'pt' },
]

/** 把任意写法的目标语言归一成 { google, bing } 代码 */
export function resolveLanguage(target) {
  const raw = String(target ?? '').trim()
  const hit = LANG_TABLE.find((row) =>
    row.names.some((name) => name.toLowerCase() === raw.toLowerCase()),
  )
  if (hit !== undefined) return { google: hit.google, bing: hit.bing }
  // 没命中就原样透传：Google 认 "auto"/"it" 这类代码，Bing 认 "it"
  return { google: raw || 'en', bing: raw || 'en' }
}

/** 统一超时，避免一条请求把字幕队列堵死 */
function withTimeout(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

/* ------------------------------------------------------------------ Google */

export async function translateGoogle(text, target, { timeoutMs = 8000 } = {}) {
  const lang = resolveLanguage(target)
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
    `&sl=auto&tl=${encodeURIComponent(lang.google)}&q=${encodeURIComponent(text)}`
  const t = withTimeout(timeoutMs)
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA }, signal: t.signal })
    if (!response.ok) throw new Error(`google http ${response.status}`)
    const payload = await response.json()
    const segments = Array.isArray(payload?.[0]) ? payload[0] : []
    const translated = segments
      .map((segment) => (Array.isArray(segment) ? segment[0] : ''))
      .filter((piece) => typeof piece === 'string')
      .join('')
    if (translated.trim() === '') throw new Error('google empty result')
    return translated
  } finally {
    t.done()
  }
}

/* --------------------------------------------------------------- Microsoft */

/** 极简 cookie jar：Bing 的会话只在这一个域名上，存 name=value 就够 */
function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

function absorbCookies(jar, response) {
  const list =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
  for (const line of list) {
    const pair = String(line).split(';')[0]
    const index = pair.indexOf('=')
    if (index <= 0) continue
    jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  }
}

let bingSession = { jar: new Map(), key: '', token: '', ig: '', iid: '', expiresAt: 0 }

async function refreshBingSession(timeoutMs) {
  const t = withTimeout(timeoutMs)
  try {
    const response = await fetch('https://www.bing.com/translator', {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: t.signal,
    })
    if (!response.ok) throw new Error(`bing page http ${response.status}`)
    const html = await response.text()
    const jar = new Map()
    absorbCookies(jar, response)

    const helper = /params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/.exec(html)
    if (helper === null) throw new Error('bing: params_AbusePreventionHelper missing')
    const parts = helper[1].split(',')
    const key = parts[0].trim()
    const token = parts[1].trim().replace(/^["']|["']$/g, '')
    const ttl = Number(parts[2]?.trim() ?? 3600000) || 3600000

    const ig = /IG:"([0-9A-Fa-f]+)"/.exec(html)?.[1] ?? ''
    const iid = /data-iid="([^"]+)"/.exec(html)?.[1] ?? 'translator.5025'
    if (key === '' || token === '' || ig === '') throw new Error('bing: session fields incomplete')

    // 留 5 分钟余量，避免刚好在过期瞬间打过去
    bingSession = { jar, key, token, ig, iid, expiresAt: Date.now() + Math.max(60_000, ttl - 300_000) }
    return bingSession
  } finally {
    t.done()
  }
}

export async function translateBing(text, target, { timeoutMs = 10000 } = {}) {
  const lang = resolveLanguage(target)
  let session = bingSession
  if (session.key === '' || Date.now() >= session.expiresAt) session = await refreshBingSession(timeoutMs)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url =
      `https://www.bing.com/ttranslatev3?isVertical=1&IG=${session.ig}` +
      `&IID=${session.iid}.${attempt + 1}`
    const body =
      'fromLang=auto-detect' +
      `&to=${encodeURIComponent(lang.bing)}` +
      `&text=${encodeURIComponent(text)}` +
      `&token=${encodeURIComponent(session.token)}` +
      `&key=${encodeURIComponent(session.key)}`

    const t = withTimeout(timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'user-agent': UA,
          'content-type': 'application/x-www-form-urlencoded',
          referer: 'https://www.bing.com/translator',
          cookie: cookieHeader(session.jar),
        },
        body,
        signal: t.signal,
      })
      absorbCookies(session.jar, response)
      if (response.status === 429 || response.status === 401) {
        session = await refreshBingSession(timeoutMs)
        continue
      }
      if (!response.ok) throw new Error(`bing http ${response.status}`)
      const payload = await response.json()
      const translated = payload?.[0]?.translations?.[0]?.text ?? ''
      if (String(translated).trim() === '') throw new Error('bing empty result')
      return translated
    } finally {
      t.done()
    }
  }
  throw new Error('bing gave up after refresh')
}

/* ------------------------------------------------------------------ router */

const PROVIDERS = {
  google: { label: 'Google Translate', run: translateGoogle },
  microsoft: { label: 'Microsoft Translator', run: translateBing },
}

export function providerLabel(name) {
  return PROVIDERS[name]?.label ?? name
}

/**
 * 按 order 依次尝试，第一个成功的返回；全部失败时抛出最后一次错误。
 * @param {string} text
 * @param {string} target
 * @param {{order?: string[], timeoutMs?: number}} options
 * @returns {Promise<{text: string, provider: string, ms: number}>}
 */
export async function translate(text, target, { order = ['google', 'microsoft'], timeoutMs = 9000 } = {}) {
  const failures = []
  const known = order.filter((name) => PROVIDERS[name] !== undefined)
  if (known.length === 0) throw new Error(`no known provider in order: ${order.join(',')}`)
  for (const name of known) {
    const provider = PROVIDERS[name]
    if (provider === undefined) continue
    const startedAt = Date.now()
    try {
      const translated = await provider.run(text, target, { timeoutMs })
      return { text: translated, provider: name, ms: Date.now() - startedAt }
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
    }
  }
  throw new Error(`all providers failed → ${failures.join(' | ')}`)
}
