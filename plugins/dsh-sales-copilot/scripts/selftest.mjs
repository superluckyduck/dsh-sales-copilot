/**
 * Self-test for the host half: tokenizer, seeding, BM25 ranking and the import
 * parser. Runs without DSH (no host services are touched).
 *
 *   node scripts/selftest.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store, parseImport } from '../index.js'
import { buildCustomerSystem } from '../lib/meeting.js'

const dir = mkdtempSync(join(tmpdir(), 'sales-copilot-test-'))
const store = new Store(dir, (message) => console.log('  log:', message))

let passed = 0
let failed = 0

function check(label, actual, expected) {
  const ok = actual === expected
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  → ${actual}${ok ? '' : ` (expected ${expected})`}`)
}

function top(query) {
  const hits = store.search(query, 3)
  return hits[0] ?? null
}

console.log(`\n[1] seed data — qa=${store.data.qa.length} customers=${store.data.customers.length} products=${store.data.products.length}`)
check('seed qa count', store.data.qa.length, 21)
check('seed customers', store.data.customers.length, 2)

console.log('\n[2] Chinese queries')
const zhCases = [
  ['标准版多少钱', '标准版年费 ¥68,000'],
  ['上线要多久', '标准版 2 周'],
  ['能打折吗', '销售代表 9.5 折'],
  ['数据安全怎么保证', '等保三级'],
  ['可以私有化部署吗', '旗舰版支持私有化部署'],
  ['我们预算不够', '首年即回本'],
  ['能对接用友吗', '用友 U8/U9'],
  ['老客户介绍有奖励吗', '5% 服务券'],
]
for (const [query, expectedFragment] of zhCases) {
  const hit = top(query)
  const ok = hit !== null && hit.answer.includes(expectedFragment)
  if (ok) passed += 1
  else failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  "${query}" → ${hit === null ? '(no match)' : `${Math.round(hit.confidence * 100)}% ${hit.question}`}`,
  )
}

console.log('\n[3] English queries')
const enCases = [
  ['How much does the standard edition cost', '68,000 RMB'],
  ['can you give us a discount', 'Discount limits'],
  ['do you support multiple warehouses', 'multi-warehouse'],
  ['is there a free trial', 'POC'],
  ['how do you keep our data secure', 'Level-3 security'],
]
for (const [query, expectedFragment] of enCases) {
  const hit = top(query)
  const ok = hit !== null && hit.answerEn.includes(expectedFragment)
  if (ok) passed += 1
  else failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  "${query}" → ${hit === null ? '(no match)' : `${Math.round(hit.confidence * 100)}% ${hit.questionEn}`}`,
  )
}

console.log('\n[4] no-match behaviour')
const miss = store.search('quantum blockchain guitar', 3)
check('irrelevant query returns nothing', miss.length, 0)

console.log('\n[5] import parser')
const parsed = parseImport(
  [
    '问：能开专票吗？',
    '答：可以，13% 增值税专用发票。',
    '支持多语言吗？\t支持中英日三种界面。\t产品',
    '有移动端吗？ | 有，PDA 与手机 App。',
    '# 这一行是注释',
    '',
  ].join('\n'),
)
check('parsed rows', parsed.length, 3)
check('parsed q/a block', parsed[0].question, '能开专票吗？')
check('parsed tsv product', parsed[1].product, '产品')
check('parsed pipe', parsed[2].answer, '有，PDA 与手机 App。')

const imported = store.importQa([...parsed.map((p) => `${p.question}\t${p.answer}`), '标准版多少钱？\t重复项'].join('\n'))
check('import added', imported.added, 3)
check('import skipped duplicates', imported.skipped, 1)
check('qa count after import', store.data.qa.length, 24)

console.log('\n[6] persistence round-trip')
store.flush()
const reloaded = new Store(dir, () => {})
check('reloaded qa count', reloaded.data.qa.length, 24)
const hitAfterReload = reloaded.search('标准版多少钱', 1)[0]
check('reloaded search still works', hitAfterReload !== undefined && hitAfterReload.answer.includes('68,000'), true)

console.log('\n[7] save / update / delete')
const created = store.saveQa({ question: '能开专票吗？', answer: '可以，13% 增值税专用发票。', tags: ['财务'] })
check('created id is a uuid', typeof created.id === 'string' && created.id.length >= 32, true)
const updated = store.saveQa({ id: created.id, question: '能开增值税专票吗？', answer: '可以，13% 专票。' })
check('updated question', updated.question, '能开增值税专票吗？')
check('delete returns true', store.deleteQa(created.id), true)

console.log('\n[8] customer role prompt')
const hardPrompt = buildCustomerSystem({ persona: '你是 Klaus。', difficulty: 'hard' })
const normalPrompt = buildCustomerSystem({ persona: '你是 Mei。', difficulty: 'normal' })
check('persona is kept', hardPrompt.includes('你是 Klaus。'), true)
check('buyer never plays dumb', hardPrompt.includes('绝不装听不懂'), true)
check('hard role applies price pressure', hardPrompt.includes('竞品报价压价'), true)
check('normal role asks for proof', normalPrompt.includes('客户见证'), true)
check('unknown difficulty falls back to normal', buildCustomerSystem({ difficulty: 'nonsense' }).includes('客户见证'), true)
check('empty role still yields a usable prompt', buildCustomerSystem(undefined).length > 80, true)

rmSync(dir, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}  passed=${passed} failed=${failed}\n`)
process.exit(failed === 0 ? 0 : 1)
