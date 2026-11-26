/**
 * Integration test: mounts the plugin through a fake cordis context whose
 * `webServer` actually listens on a real port, then drives every HTTP route and
 * the agent tool. This is the same code path DSH runs, minus DSH itself.
 *
 *   node scripts/integration.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const dataRoot = mkdtempSync(join(tmpdir(), 'sales-copilot-http-'))

// Keep the suite silent: /tts/speak would otherwise really talk out of the
// speakers on every run.
process.env.DSH_SALES_COPILOT_TTS = 'off'

const routes = []
const effects = []
const tools = []

function scoped(services) {
  return {
    // DSH exposes services both as `scoped.get(name)` and as `scoped.<name>`
    // (dsh-live-captions/index.js:332 uses `scoped.tools.register`).
    ...services,
    get: (name) => services[name],
    effect: (fn, label) => {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
  }
}

const webServer = {
  register(options) {
    routes.push(options)
    return () => {
      const index = routes.indexOf(options)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}

const toolsService = {
  register(definition) {
    tools.push(definition)
    return () => {
      const index = tools.indexOf(definition)
      if (index >= 0) tools.splice(index, 1)
    }
  },
}

const modelQueue = []
function queueModel(text) {
  modelQueue.push(text)
}

const llmService = {
  async *stream() {
    const text = modelQueue.length > 0 ? modelQueue.shift() : '{}'
    yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const ctx = {
  get(name) {
    if (name === 'llm') return llmService
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'test-model' }) }
    if (name === 'webServer') return webServer
    return undefined
  },
  inject(names, callback) {
    const services = {}
    if (names.includes('webServer')) services.webServer = webServer
    if (names.includes('tools')) services.tools = toolsService
    callback(scoped(services))
  },
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return dispose
  },
}

apply(ctx, { dataRoot })

if (routes.length !== 1 || routes[0].kind !== 'prefix' || routes[0].path !== '/sales-copilot/api') {
  console.error('FAIL  expected exactly one prefix route at /sales-copilot/api, got', JSON.stringify(routes.map((r) => [r.kind, r.path])))
  process.exit(1)
}
if (tools.length !== 1 || tools[0].name !== 'sales_copilot') {
  console.error('FAIL  expected the sales_copilot tool to be registered, got', JSON.stringify(tools.map((t) => t.name)))
  process.exit(1)
}
console.log('PASS  route registered:', routes[0].path)
console.log('PASS  tool registered:', tools[0].name)

const handler = routes[0].handler
const server = createServer((request, response) => {
  void handler(request, response)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/sales-copilot/api`

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`)
  }
}

async function get(path) {
  const response = await fetch(base + path)
  return { status: response.status, body: await response.json() }
}

async function post(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

const state = await get('/state')
check('GET /state ok', state.status === 200 && state.body.ok === true, state.body)
check('GET /state seeded 21 FAQ', state.body.state?.qa === 21, state.body.state)
check('GET /state reports the temp data root', state.body.state?.dataRoot === dataRoot, state.body.state?.dataRoot)

const search = await post('/qa/search', { query: '能打折吗', limit: 3 })
check('POST /qa/search ok', search.status === 200 && search.body.ok === true, search.body)
check('search returns a hit', (search.body.matches ?? []).length > 0, search.body)
check('top hit is the discount answer', search.body.matches?.[0]?.answer?.includes('9.5 折'), search.body.matches?.[0])

const english = await post('/qa/search', { query: 'do you support multiple warehouses', limit: 2 })
check('English search hits the multi-warehouse entry', english.body.matches?.[0]?.answerEn?.includes('multi-warehouse'), english.body.matches?.[0])

const missing = await post('/qa/search', { query: 'zzzz qqqq', limit: 3 })
check('unmatched query returns an empty list', (missing.body.matches ?? []).length === 0, missing.body)

const created = await post('/qa/save', { question: '能开专票吗？', answer: '可以，13% 增值税专用发票。', answerEn: 'Yes, we can issue a 13 percent VAT invoice.', tags: ['财务'] })
check('POST /qa/save ok', created.status === 200 && created.body.ok === true, created.body)
const createdId = created.body.item?.id
check('saved item has an id', typeof createdId === 'string' && createdId.length > 10)

const found = await post('/qa/search', { query: '专票', limit: 2 })
check('new entry is searchable immediately', found.body.matches?.[0]?.question === '能开专票吗？', found.body.matches?.[0])

const list = await get('/qa')
check('GET /qa lists 22 entries', list.body.items?.length === 22, list.body.items?.length)

const imported = await post('/qa/import', { text: '问：支持英文界面吗？\n答：支持中英日三种界面。\nstd重复？\t重复项' })
check('POST /qa/import ok', imported.status === 200 && imported.body.ok === true, imported.body)
check('import parsed 2 rows', imported.body.parsed === 2, imported.body)
check('import added 2 rows', imported.body.added === 2, imported.body)

const deleted = await post('/qa/delete', { id: createdId })
check('POST /qa/delete ok', deleted.body.deleted === true, deleted.body)

const customer = await post('/customer/save', { name: '李总', company: '宁波汽配', stage: '谈判', budget: '旗舰版', tags: ['汽配'], notes: '关心 WES 与私有化' })
check('POST /customer/save ok', customer.body.ok === true && customer.body.item?.name === '李总', customer.body)
const customers = await get('/customers')
check('GET /customers lists 3', customers.body.items?.length === 3, customers.body.items?.length)

const exported = await get('/export')
check('GET /export returns the whole db', exported.body.db?.qa?.length === 23, exported.body.db?.qa?.length)

const notFound = await get('/nope')
check('unknown route → 404', notFound.status === 404, notFound.status)

/* realtime -------------------------------------------------------- */
const rtState = await get('/rt/state')
check('GET /rt/state ok', rtState.status === 200 && rtState.body.ok === true, rtState.body)
check('realtime starts stopped', rtState.body.rt?.running === false, rtState.body.rt)
check('realtime reports the active model', rtState.body.model?.model === 'test-model', rtState.body.model)
const rtStart = await post('/rt/start', {})
check('POST /rt/start ok', rtStart.status === 200 && rtStart.body.rt?.running === true, rtStart.body)
const rtAi = await post('/rt/ai', { enabled: true })
check('POST /rt/ai toggles AI answers', rtAi.body.rt?.aiAssist === true, rtAi.body.rt)
const rtStop = await post('/rt/stop', {})
check('POST /rt/stop ok', rtStop.body.rt?.running === false, rtStop.body.rt)

/* always-on-top overlay ------------------------------------------- */
const overlayState = await get('/overlay/state')
check('GET /overlay/state ok', overlayState.status === 200 && overlayState.body.ok === true, overlayState.body)
check('overlay reports platform support', typeof overlayState.body.overlay?.supported === 'boolean', overlayState.body.overlay)
check('overlay starts closed', overlayState.body.overlay?.open === false, overlayState.body.overlay)
const overlayOpenNoOrigin = await post('/overlay/open', {})
check(
  'overlay refuses to open without a web origin',
  overlayOpenNoOrigin.status === 400 && overlayOpenNoOrigin.body.ok === false,
  overlayOpenNoOrigin.body,
)
const overlayClose = await post('/overlay/close', {})
check('POST /overlay/close ok', overlayClose.body.ok === true && overlayClose.body.overlay?.open === false, overlayClose.body)
check('GET /rt/state carries overlay state', typeof rtState.body.overlay?.open === 'boolean', rtState.body.overlay)

/* voice: text-to-speech (muted in tests) -------------------------- */
const ttsState = await get('/tts/state')
check('GET /tts/state ok', ttsState.status === 200 && typeof ttsState.body.tts?.supported === 'boolean', ttsState.body)
const ttsVoices = await get('/tts/voices')
check('GET /tts/voices ok', ttsVoices.status === 200 && ttsVoices.body.ok === true, ttsVoices.body)
check('tts reports itself muted in tests', ttsVoices.body.supported === false, ttsVoices.body.supported)
const ttsSpeak = await post('/tts/speak', { text: 'hello', lang: 'en' })
check('POST /tts/speak refuses without a voice', ttsSpeak.status === 400 && ttsSpeak.body.ok === false, ttsSpeak.body)
const ttsStop = await post('/tts/stop', {})
check('POST /tts/stop is harmless when idle', ttsStop.body.ok === true && ttsStop.body.stopped === false, ttsStop.body)

/* fake dsh-live-captions ------------------------------------------ */
let liveStarted = false
let liveCommands = []
const fakeLive = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const send = (payload) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(payload))
  }
  if (url.pathname === '/live-captions/api/sessions') {
    send({ ok: true, sessions: [{ id: 's1', startedAt: '2026-11-26T09:00:00.000Z', source: 'speaker', entries: 2, durationMs: 60000 }] })
    return
  }
  if (url.pathname === '/live-captions/api/records') {
    send({
      ok: true,
      sessionId: 's1',
      sessions: [{ id: 's1', entries: 2 }],
      records: {
        id: 's1',
        entries: [
          { time: '10:00:01', text: 'We need four warehouses.', translation: '我们需要四个仓库。' },
          { time: '10:00:08', text: 'Can you give us a discount?', translation: '能给我们打折吗？' },
        ],
      },
    })
    return
  }
  if (url.pathname === '/live-captions/api/state') {
    send({
      ok: true,
      state: {
        status: liveStarted ? 'running' : 'idle',
        session: { id: 's1' },
        settings: { source: 'speaker', sourceLanguage: 'en' },
        entries: liveStarted
          ? [{ seq: 1, text: 'Yes, five percent for four warehouses.', translation: '四个仓库可以打 9.5 折。', draft: false }]
          : [],
      },
    })
    return
  }
  if (url.pathname === '/live-captions/api/command') {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw === '' ? '{}' : raw)
      } catch {
        body = {}
      }
      liveCommands.push(body)
      if (body.action === 'start') liveStarted = true
      if (body.action === 'stop') liveStarted = false
      send({ ok: true, result: { ok: true }, state: { status: liveStarted ? 'running' : 'idle', settings: { source: 'speaker', sourceLanguage: 'en' }, entries: [] } })
    })
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: false, error: 'not found' }))
})
await new Promise((resolve) => fakeLive.listen(0, '127.0.0.1', resolve))
const fakeOrigin = `http://127.0.0.1:${fakeLive.address().port}`
webServer.getOrigin = () => fakeOrigin

const captionsSessions = await get('/captions/sessions')
check('GET /captions/sessions proxies live-captions', (captionsSessions.body.sessions ?? []).length === 1, captionsSessions.body)

/* post-call summary prompt ---------------------------------------- */
await post('/rt/ai', { enabled: false })
await post('/rt/reset', {})
const rtRestart = await post('/rt/start', {})
check('POST /rt/start ok once captions are reachable', rtRestart.body.rt?.running === true, rtRestart.body.rt)
await new Promise((resolve) => setTimeout(resolve, 1300))
const rtLive = await get('/rt/state')
check('realtime ingests a caption line', (rtLive.body.rt?.items ?? []).length >= 1, (rtLive.body.rt?.items ?? []).length)
const rtCallStop = await post('/rt/stop', {})
check('stopping after a call offers a summary', (rtCallStop.body.rt?.callEnded?.entries ?? 0) >= 1, rtCallStop.body.rt?.callEnded)
check('the summary prompt knows the caption session', rtCallStop.body.rt?.callEnded?.sessionId === 's1', rtCallStop.body.rt?.callEnded)
const rtAck = await post('/rt/ack', {})
check('POST /rt/ack dismisses the summary prompt', rtAck.body.rt?.callEnded === null, rtAck.body.rt?.callEnded)

queueModel(
  JSON.stringify({
    summary: '客户有四个仓库，关心跨仓调拨与折扣。',
    needs: ['多仓调拨', '折扣'],
    nextSteps: ['发 EU 案例'],
    profile: { stage: '需求确认', budget: '', notes: '四个仓库', tags: ['多仓'] },
  }),
)
const importedCall = await post('/meeting/from-captions', { sessionId: 's1' })
check('POST /meeting/from-captions ok', importedCall.body.ok === true, importedCall.body)
check('imported call has 2 messages', importedCall.body.meeting?.messages?.length === 2, importedCall.body.meeting?.messages?.length)
check('imported call is marked as call-import', importedCall.body.meeting?.mode === 'call-import', importedCall.body.meeting?.mode)
check('imported call was summarized', typeof importedCall.body.summary?.summary === 'string', importedCall.body.summary)

/* voice turn: mic answer through live-captions -------------------- */
const voiceMeeting = await post('/meeting/create', { title: '语音回答测试', mode: 'user-customer' })
const voiceTurn = await post('/meeting/voice-turn', { id: voiceMeeting.body.meeting?.id, timeoutMs: 6000 })
check('POST /meeting/voice-turn ok', voiceTurn.body.ok === true, voiceTurn.body)
check('voice turn heard the sentence', String(voiceTurn.body.heard ?? '').includes('five percent'), voiceTurn.body.heard)
check('voice turn appended a sales message', voiceTurn.body.message?.speaker === 'sales', voiceTurn.body.message)
check('voice turn restored the captions settings', liveCommands.some((item) => item.action === 'settings' && item.settings?.source === 'speaker'), liveCommands)
check('voice turn stopped the capture', liveCommands.filter((item) => item.action === 'stop').length >= 1, liveCommands)

// The import tests above created meetings; remove them so the meeting-count
// assertions further down still see exactly the meetings they expect.
await post('/meeting/delete', { id: importedCall.body.meeting?.id })
await post('/meeting/delete', { id: voiceMeeting.body.meeting?.id })
check('imported meetings removed', (await get('/meetings')).body.items?.length === 0, (await get('/meetings')).body.items?.length)

/* roles ----------------------------------------------------------- */
const roles = await get('/roles')
check('GET /roles returns the seeded roles', (roles.body.items ?? []).length === 3, roles.body.items?.length)
const roleId = roles.body.items?.[0]?.id

queueModel(
  JSON.stringify([
    { name: '测试角色 A', persona: '你是测试客户 A，只问价格。', language: 'zh', difficulty: 'normal', company: 'A 公司' },
    { name: 'Test Role B', persona: 'You are test customer B.', language: 'en', difficulty: 'hard', company: 'B Ltd' },
  ]),
)
const suggested = await post('/role/suggest', { brief: '测试', count: 2 })
check('POST /role/suggest ok', suggested.status === 200 && suggested.body.ok === true, suggested.body)
check('role/suggest saved 2 roles', (suggested.body.items ?? []).length === 2, suggested.body.items?.length)
check('role/suggest persists them', (await get('/roles')).body.items?.length === 5)

/* meetings -------------------------------------------------------- */
const meeting = await post('/meeting/create', { title: '集成测试对练', mode: 'ai-customer', roleIds: [roleId] })
check('POST /meeting/create ok', meeting.body.ok === true && typeof meeting.body.meeting?.id === 'string', meeting.body)
const meetingId = meeting.body.meeting?.id

const sent = await post('/meeting/message', { id: meetingId, speaker: 'sales', text: 'Can I ask what your current setup is?' })
check('POST /meeting/message ok', sent.body.ok === true && sent.body.meeting?.messages?.length === 1, sent.body)

queueModel('We run everything on Excel, and it breaks every month.')
const turn = await post('/meeting/turn', { id: meetingId })
check('POST /meeting/turn ok', turn.body.ok === true && turn.body.message?.speaker === 'customer', turn.body)
check('customer turn is appended', turn.body.meeting?.messages?.length === 2, turn.body.meeting?.messages?.length)

queueModel(
  JSON.stringify({
    summary: '客户目前用 Excel，月底容易出错，关注上线速度。',
    needs: ['替换 Excel', '月底前上线'],
    nextSteps: ['下周约技术对接'],
    profile: { stage: '需求确认', budget: '专业版', notes: '决策人是他本人', tags: ['Excel', '月底'] },
  }),
)
const summarized = await post('/meeting/summary', { id: meetingId, applyProfile: true })
check('POST /meeting/summary ok', summarized.body.ok === true, summarized.body)
check('summary has needs', (summarized.body.summary?.needs ?? []).length === 2, summarized.body.summary)
check('summary is stored on the meeting', summarized.body.meeting?.summary?.summary?.includes('Excel'), summarized.body.meeting?.summary)

const meetings = await get('/meetings')
check('GET /meetings lists one', meetings.body.items?.length === 1, meetings.body.items?.length)
check('/meetings marks it summarized', meetings.body.items?.[0]?.summarized === true, meetings.body.items?.[0])

const detail = await get(`/meeting?id=${meetingId}`)
check('GET /meeting returns the transcript', detail.body.meeting?.messages?.length === 2, detail.body.meeting?.messages?.length)
check('unknown meeting → 404', (await get('/meeting?id=nope')).status === 404)

const linkedCustomer = await post('/customer/save', { name: '画像测试', company: '画像公司', stage: '线索' })
const linkedId = linkedCustomer.body.item?.id
const meeting2 = await post('/meeting/create', { title: '画像写入测试', mode: 'user-customer', customerId: linkedId, roleIds: [roleId] })
await post('/meeting/message', { id: meeting2.body.meeting?.id, speaker: 'customer', text: '预算大概三十万，年底前要上。' })
queueModel(JSON.stringify({ summary: '客户预算 30 万。', needs: ['年底上线'], nextSteps: [], profile: { stage: '报价', budget: '旗舰版', notes: '年底上线', tags: ['年底'] } }))
const applied = await post('/meeting/summary', { id: meeting2.body.meeting?.id, applyProfile: true })
check('summary writes back to the customer profile', applied.body.customer?.stage === '报价' && applied.body.customer?.budget === '旗舰版', applied.body.customer)

const deletedMeeting = await post('/meeting/delete', { id: meeting2.body.meeting?.id })
check('POST /meeting/delete ok', deletedMeeting.body.deleted === true, deletedMeeting.body)

const deletedRole = await post('/role/delete', { id: roleId })
check('POST /role/delete ok', deletedRole.body.deleted === true, deletedRole.body)

const toolSearch = await tools[0].execute({ action: 'search', query: '上线要多久', limit: 2 })
check('tool search ok', toolSearch.ok === true && toolSearch.matches?.length === 2, toolSearch.summary)
check('tool search summary mentions the answer', toolSearch.summary.includes('2 周'), toolSearch.summary)

const toolSave = await tools[0].execute({ action: 'qa_save', question: '支持本地部署吗？', answer: '旗舰版支持私有化。' })
check('tool qa_save ok', toolSave.ok === true, toolSave)
const toolStats = await tools[0].execute({ action: 'stats' })
check('tool stats ok', toolStats.ok === true && toolStats.summary.includes('问答'), toolStats)

const toolMiss = await tools[0].execute({ action: 'nonsense' })
check('tool rejects an unknown action', toolMiss.ok === false, toolMiss)

server.close()
fakeLive.close()
for (const effect of effects) {
  if (typeof effect.dispose === 'function') effect.dispose()
}
rmSync(dataRoot, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}  passed=${passed} failed=${failed}\n`)
process.exit(failed === 0 ? 0 : 1)
