/**
 * Focused checks for the two practice-mode gaps fixed in this pass:
 *   1. mode 'user-customer' must produce a real AI SALESPERSON turn,
 *   2. the voice room must file the user's line under the side they play and
 *      reply with the opposite side, continuously, via live-captions.
 *
 *   node scripts/meeting-voice-test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../index.js'
import { createMeeting, buildSalesSystem } from '../lib/meeting.js'
import { createVoiceRoom } from '../lib/voice-room.js'

const dir = mkdtempSync(join(tmpdir(), 'sales-copilot-voice-'))
const store = new Store(dir, () => {})
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

/* --- 1. seller system prompt ---------------------------------------- */
const sellerPrompt = buildSalesSystem()
check('seller prompt exists', sellerPrompt.length > 100)
check('seller never speaks for the customer', sellerPrompt.includes('绝不能替客户说话'))
check('seller is grounded in product facts', sellerPrompt.includes('只能取自资料'))

/* --- 2. a fake LLM + meeting runner --------------------------------- */
const queue = []
const llm = {
  available: () => true,
  describe: () => ({ available: true, provider: 'fake', model: 'test' }),
  ask: async () => (queue.length > 0 ? queue.shift() : ''),
  parseJson: (text) => JSON.parse(text),
}
const runner = createMeeting({ store, llm, log: () => {} })

const aiCustomerMeeting = store.createMeeting({ title: 'ai-customer', mode: 'ai-customer', roleIds: [] })
await store.addMessage(aiCustomerMeeting.id, { speaker: 'sales', text: '你们现在用什么系统？' })
queue.push('我们现在用 Excel，月底经常出错。你们上线要多久？')
const cTurn = await runner.customerTurn({ meeting: store.getMeeting(aiCustomerMeeting.id) })
check('customer mode still yields a customer turn', cTurn.text.includes('Excel'), cTurn)
check('customer turn carries a role', typeof cTurn.role?.name === 'string')

const userCustomerMeeting = store.createMeeting({ title: 'user-customer', mode: 'user-customer', roleIds: [] })
await store.addMessage(userCustomerMeeting.id, { speaker: 'customer', text: '你们太贵了，能便宜点吗？' })
queue.push('标准版是 6.8 万一年，四仓库上线两个月内可以完成，我可以帮您申请一次特批。')
const sTurn = await runner.salesTurn({ meeting: store.getMeeting(userCustomerMeeting.id), language: 'zh' })
check('user-customer mode yields a real salesperson turn', sTurn.text.includes('标准版'), sTurn)
check('seller turn is not a customer turn', !sTurn.text.includes('我们现在用'), sTurn)
check('seller turn has no customer role', sTurn.role === undefined)

// The reasoning model leaks its analysis as plain text; the roleplay must
// extract only the line it drafted in quotes.
queue.push('我需要用英文回答。客户问到产品和价格，资料里标准版是六万八千。可说：“Our standard edition is 68,000 RMB per year. How many warehouses do you run?” 这样比较合适。')
const leaky = await runner.salesTurn({ meeting: store.getMeeting(userCustomerMeeting.id), language: 'en' })
check('reasoning leak is stripped from the reply', leaky.text === 'Our standard edition is 68,000 RMB per year. How many warehouses do you run?', leaky.text)
check('stripped reply is English', /^Our standard edition/.test(leaky.text), leaky.text)

/* --- 3. voice room: continuous, mode-aware -------------------------- */
let captionSeq = 0
let captionStatus = 'idle'
let captionsState = { status: 'idle', settings: { source: 'speaker', sourceLanguage: 'en', translate: true }, entries: [] }
const commands = []
const spoken = []
const voice = createVoiceRoom({
  store,
  meetingRunner: runner,
  llm,
  tts: { state: () => ({ supported: true }) },
  log: () => {},
  captionsGet: async () => ({ state: captionsState }),
  captionsPost: async (body) => {
    commands.push(body)
    if (body.action === 'start') {
      captionStatus = 'running'
      captionsState = { ...captionsState, status: captionStatus }
    } else if (body.action === 'stop') {
      captionStatus = 'idle'
      captionsState = { ...captionsState, status: captionStatus }
    } else if (body.action === 'settings') {
      captionsState = { ...captionsState, settings: { ...captionsState.settings, ...body.settings } }
    }
    return { ok: true }
  },
  speakText: async (text, lang) => { spoken.push({ text, lang }) },
})

const voiceMeeting = store.createMeeting({ title: 'voice', mode: 'user-customer', roleIds: [] })
const started = await voice.start({ meeting: voiceMeeting, language: 'zh', durationMs: 100000 })
check('voice room starts', started.ok === true, started)
check('voice room switched captions to mic', commands.some((c) => c.action === 'settings' && c.settings?.source === 'mic'), commands)
check('voice room started captions', commands.some((c) => c.action === 'start'), commands)

// Push two finalized user lines, as the ASR would produce them.
captionSeq += 1
captionsState = {
  ...captionsState,
  entries: [{ seq: captionSeq, text: '太贵了，能便宜一点吗？', draft: false, lang: 'zh' }],
}
queue.push('标准版 6.8 万一年，量大我可以帮您申请折扣。')
// Drive the private tick via the setInterval by waiting a bit.
await new Promise((resolve) => setTimeout(resolve, 900))
const afterOne = store.getMeeting(voiceMeeting.id)
check('voice room filed the user line as customer', afterOne.messages.some((m) => m.speaker === 'customer' && m.text.includes('太贵了')), afterOne.messages)
check('voice room replied as sales', afterOne.messages.some((m) => m.speaker === 'sales' && m.text.includes('标准版')), afterOne.messages)
check('voice room spoke the reply in Chinese', spoken.some((s) => s.lang === 'zh' && s.text.includes('标准版')), spoken)
check('voice room state reports one turn', voice.state().turns === 1, voice.state())

captionSeq += 1
captionsState = {
  ...captionsState,
  entries: [{ seq: captionSeq, text: '上线需要多久？', draft: false, lang: 'zh' }],
}
queue.push('标准版两周，专业版四到六周。')
await new Promise((resolve) => setTimeout(resolve, 900))
const afterTwo = store.getMeeting(voiceMeeting.id)
check('voice room keeps a continuous conversation', afterTwo.messages.filter((m) => m.speaker === 'customer').length === 2, afterTwo.messages)
check('voice room counted two turns', voice.state().turns === 2, voice.state())

const stopped = await voice.stop()
check('voice room stops cleanly', stopped.ok === true)
check('voice room restored captions settings', commands.some((c) => c.action === 'settings' && c.settings?.source === 'speaker'), commands)
check('voice room stopped captions', commands.filter((c) => c.action === 'stop').length >= 1, commands)
check('voice room state is idle after stop', voice.state().running === false)

/* --- 4. auto mode replies in the language the user spoke ------------- */
spoken.length = 0
const englishMeeting = store.createMeeting({ title: 'voice-en', mode: 'user-customer', roleIds: [] })
const autoStarted = await voice.start({ meeting: englishMeeting, language: 'auto', durationMs: 100000 })
check('auto voice room starts', autoStarted.ok === true, autoStarted)
check('auto room leaves ASR language on auto', commands.some((c) => c.action === 'settings' && c.settings?.sourceLanguage === 'auto'), commands)
captionSeq += 1
captionsState = {
  ...captionsState,
  entries: [{ seq: captionSeq, text: 'Please tell me about your product and the price.', draft: false, lang: 'en' }],
}
queue.push('Sure — our standard edition is 68,000 RMB per year. How many warehouses do you run?')
await new Promise((resolve) => setTimeout(resolve, 900))
const enState = voice.state()
check('auto room detected English and replied in English', enState.replyLanguage === 'en', enState)
check('auto room spoke the reply with the English voice', spoken.some((s) => s.lang === 'en' && s.text.includes('68,000')), spoken)
await voice.stop()

rmSync(dir, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}  passed=${passed} failed=${failed}\n`)
process.exit(failed === 0 ? 0 : 1)
