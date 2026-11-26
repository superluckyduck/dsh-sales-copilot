// Live smoke test against a running DSH host: roles → meeting → AI customer turn → summary → delete.
// Usage: node scripts/smoke.mjs http://127.0.0.1:54525/sales-copilot/api
const base = (process.argv[2] ?? 'http://127.0.0.1:54525/sales-copilot/api').replace(/\/$/, '')

async function call(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error(`${path} 返回的不是 JSON：${text.slice(0, 200)}`) }
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}：${text.slice(0, 300)}`)
  return payload
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const state = await call('/state')
check('state', state.ok === true && state.state.qa === 21, `qa=${state.state.qa} customers=${state.state.customers} roles=${state.state.roles} meetings=${state.state.meetings}`)
const rt = await call('/rt/state')
check('model route', rt.model?.available === true, `${rt.model?.provider}/${rt.model?.model}`)
const captions = rt.rt?.captions
check('captions bridge', typeof captions === 'string', `dsh-live-captions status=${captions}${rt.rt?.lastError ? ` · ${rt.rt.lastError}` : ''}`)

const roles = await call('/roles')
check('roles seeded', roles.items.length >= 3, roles.items.map((r) => `${r.name}(${r.language}/${r.difficulty})`).join(', '))

// Voice + call-import read paths: no side effects, safe to run on the live host.
const voices = await call('/tts/voices')
check('tts voices', voices.supported === true && (voices.voices ?? []).length > 0, (voices.voices ?? []).map((v) => `${v.name}(${v.culture})`).join(', '))
const captionsSessions = await call('/captions/sessions')
check('captions sessions', Array.isArray(captionsSessions.sessions), `${(captionsSessions.sessions ?? []).length} 段通话记录`)

const created = await call('/meeting/create', { title: '冒烟测试 · 请忽略', mode: 'ai-customer', roleIds: [roles.items[0].id], customerId: '' })
const meeting = created.meeting
check('meeting/create', Boolean(meeting?.id), `id=${meeting?.id} role=${meeting?.roleIds?.length}`)

await call('/meeting/message', { id: meeting.id, speaker: 'sales', text: 'Thanks for your time. Which part of your warehouse hurts most today?' })

const turn = await call('/meeting/turn', { id: meeting.id })
const line = turn.message?.text ?? ''
check('meeting/turn', typeof line === 'string' && line.trim().length > 0, `${turn.role?.name}: ${line.slice(0, 90)}`)

const summary = await call('/meeting/summary', { id: meeting.id, applyProfile: false })
const s = summary.summary
check('meeting/summary json', typeof s?.summary === 'string' && s.summary.trim().length > 0, JSON.stringify({ summary: s?.summary?.slice(0, 60), needs: s?.needs?.length, nextSteps: s?.nextSteps?.length }))

const deleted = await call('/meeting/delete', { id: meeting.id })
check('meeting/delete', deleted.ok === true)

const failures = results.filter((r) => !r.ok)
console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'}  passed=${results.length - failures.length} failed=${failures.length}`)
if (failures.length > 0) process.exitCode = 1
