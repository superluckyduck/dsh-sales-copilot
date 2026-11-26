/**
 * dsh-sales-copilot — host half.
 *
 * A lightweight sales co-pilot for bilingual (zh/en) selling:
 *   - product / customer records,
 *   - a fast FAQ library with keyword (BM25) matching,
 *   - a same-origin JSON API for the browser panel,
 *   - one model-facing tool so the agent can search and maintain the library.
 *
 * Storage is a single JSON file under <DSH_HOME>/sales-copilot (no native
 * dependencies, no database server, easy to back up or move).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createLlm } from './lib/llm.js'
import { createRealtime } from './lib/realtime.js'
import { createMeeting } from './lib/meeting.js'
import { createOverlay } from './lib/overlay.js'
import { createTts } from './lib/tts.js'

const PREFIX = '/sales-copilot/api'
const TOOL_NAME = 'sales_copilot'
const MAX_BODY = 1024 * 1024
const DB_VERSION = 2

/* ------------------------------------------------------------------ */
/* logging                                                             */
/* ------------------------------------------------------------------ */

function createLogger(dataRoot) {
  const file = join(dataRoot, 'log.txt')
  return (message) => {
    try {
      appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`)
    } catch {
      // logging must never break the plugin
    }
  }
}

export function resolveDataRoot(config) {
  const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : ''
  if (configured !== '') return configured
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'sales-copilot')
}

/* ------------------------------------------------------------------ */
/* tokenizer + BM25                                                    */
/* ------------------------------------------------------------------ */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

/**
 * Mixed zh/en tokenizer: latin words stay whole, runs of CJK characters emit
 * unigrams *and* bigrams (so "多少钱" matches "价格是多少钱" without a
 * dictionary, and "仓库" matches "多仓库").
 */
export function tokenize(text) {
  const source = String(text ?? '').toLowerCase()
  const tokens = []
  const latin = source.match(/[a-z][a-z0-9+#._-]*|\d+(?:[.,]\d+)*/g) ?? []
  for (const word of latin) tokens.push(word)
  const runs = source.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? []
  for (const run of runs) {
    const chars = Array.from(run)
    for (let i = 0; i < chars.length; i += 1) {
      tokens.push(chars[i])
      if (i + 1 < chars.length) tokens.push(chars[i] + chars[i + 1])
    }
  }
  return tokens
}

const K1 = 1.2
const B = 0.75

function buildIndex(docs) {
  const df = new Map()
  const postings = []
  let total = 0
  for (const doc of docs) {
    const tf = new Map()
    for (const token of doc.tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1)
      total += 1
    }
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
    postings.push({ id: doc.id, tf, len: doc.tokens.length })
  }
  const n = docs.length
  const avgdl = n === 0 ? 1 : Math.max(1, total / n)
  return { df, postings, n, avgdl }
}

/**
 * Score one query against a prebuilt index. Exported for the self-test.
 * `docs` must be the same array the index was built from (id order matters).
 */
export function scoreDocs(index, queryTokens) {
  const unique = Array.from(new Set(queryTokens))
  if (unique.length === 0 || index.n === 0) return []
  const results = []
  for (const posting of index.postings) {
    let score = 0
    let matched = 0
    for (const token of unique) {
      const tf = posting.tf.get(token)
      if (tf === undefined) continue
      matched += 1
      const df = index.df.get(token) ?? 0
      const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5))
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * posting.len) / index.avgdl)))
    }
    if (score <= 0) continue
    results.push({ id: posting.id, score, coverage: matched / unique.length })
  }
  return results
}

/* ------------------------------------------------------------------ */
/* seed data                                                           */
/* ------------------------------------------------------------------ */

const SEED_QA = [
  {
    q: '标准版多少钱？',
    qEn: 'How much does the Standard edition cost?',
    a: '标准版年费 ¥68,000，含 20 个并发账号，适用于单仓、日单量 2,000 以内。',
    aEn: 'The Standard plan is 68,000 RMB per year, including 20 concurrent accounts. It fits a single warehouse under 2,000 orders a day.',
    product: '标准版',
    tags: ['价格', '标准版'],
  },
  {
    q: '专业版和旗舰版什么价？',
    qEn: 'What do the Professional and Enterprise editions cost?',
    a: '专业版年费 ¥128,000（2–5 仓、日单量 1 万以内）；旗舰版年费 ¥238,000（5 仓以上或集团）。',
    aEn: 'Professional is 128,000 RMB a year for two to five warehouses under 10,000 orders a day. Enterprise is 238,000 RMB for five or more warehouses or groups.',
    product: '专业版',
    tags: ['价格', '专业版', '旗舰版'],
  },
  {
    q: '上线要多久？',
    qEn: 'How long does implementation take?',
    a: '标准版 2 周、专业版 4–6 周、旗舰版 8–12 周，含一次全量盘点。',
    aEn: 'Two weeks for Standard, four to six weeks for Professional, eight to twelve weeks for Enterprise, including one full stocktake.',
    product: '实施',
    tags: ['实施', '周期'],
  },
  {
    q: '实施包含哪些交付内容？',
    qEn: 'What is included in the implementation?',
    a: '基础数据导入、2 场仓管员培训、上线陪跑 3 天、SOP 文档。',
    aEn: 'Base data import, two warehouse-staff training sessions, three days of go-live support, and SOP documents.',
    product: '实施',
    tags: ['实施', '交付'],
  },
  {
    q: '上线后不满意能退吗？',
    qEn: 'Can we get a refund if we are not satisfied?',
    a: '上线后 30 天内不满意，可按剩余月份退款，条款已在合同模板中。',
    aEn: 'Within 30 days of go-live you can get a refund for the remaining months. The clause is already in the contract template.',
    product: '政策',
    tags: ['退款', '风险'],
  },
  {
    q: '能不能再便宜一点？',
    qEn: 'Can you give us a better price?',
    a: '折扣权限按角色：销售代表 9.5 折、主管 8.8 折、区域总监 8.0 折（CRM 审批）、副总裁 7.2 折（邮件加毛利测算）。',
    aEn: 'Discount limits by role: reps down to 95 percent, managers 88 percent, regional directors 80 percent with CRM approval, VP 72 percent with an email request and margin analysis.',
    product: '政策',
    tags: ['折扣', '价格', '异议'],
  },
  {
    q: '付款方式有哪些？',
    qEn: 'What payment terms do you offer?',
    a: '年付标准价；两年付 9.2 折，三年付 8.6 折；季付加价 8%。',
    aEn: 'Annual at list price; two years at 92 percent, three years at 86 percent; quarterly billing adds 8 percent.',
    product: '政策',
    tags: ['付款', '价格'],
  },
  {
    q: '并发账号怎么买？',
    qEn: 'How do we buy extra concurrent accounts?',
    a: '标准版含 20 个并发账号；专业版及以上可增购，¥2,800/账号/年。',
    aEn: 'Standard includes 20 concurrent accounts. Professional and above can buy more at 2,800 RMB per account per year.',
    product: '政策',
    tags: ['账号', '增购'],
  },
  {
    q: '以后想升级版本怎么办？',
    qEn: 'What if we want to upgrade later?',
    a: '版本升级补差价，另收 15% 实施费。',
    aEn: 'You pay the price difference plus a 15 percent implementation fee.',
    product: '政策',
    tags: ['升级'],
  },
  {
    q: 'PDA 和标签打印机要另外买吗？',
    qEn: 'Do we need to buy PDAs and label printers separately?',
    a: '硬件包另计，¥18,000 起，也可租赁 ¥600/月/台，最短 12 个月。',
    aEn: 'Hardware is separate, starting at 18,000 RMB, or rented at 600 RMB per device per month with a 12-month minimum.',
    product: '硬件',
    tags: ['硬件', '价格'],
  },
  {
    q: '你们支持多仓库吗？',
    qEn: 'Do you support multiple warehouses?',
    a: '支持多仓调拨、调拨单自动生成、在途可视，总部一张网看全部仓库（专业版起）。',
    aEn: 'Yes: multi-warehouse transfers, auto-generated transfer orders, in-transit visibility, and one head-office view of every warehouse from Professional upwards.',
    product: '专业版',
    tags: ['多仓', '能力'],
  },
  {
    q: '能对接我们的 ERP 吗？',
    qEn: 'Can it integrate with our ERP?',
    a: '标准 API 加预置连接器：用友 U8/U9、金蝶云星空、SAP B1、旺店通、聚水潭。',
    aEn: 'A standard API plus ready connectors: Yonyou U8/U9, Kingdee Cloud, SAP B1, Wangdiantong and Jushuitan.',
    product: '集成',
    tags: ['对接', 'ERP', '能力'],
  },
  {
    q: '可以私有化部署吗？',
    qEn: 'Can we deploy it on-premise?',
    a: '旗舰版支持私有化部署；标准版与专业版走公有云（阿里云华东/华南双可用区）。',
    aEn: 'Enterprise supports on-premise deployment. Standard and Professional run on our public cloud with dual availability zones in East and South China.',
    product: '旗舰版',
    tags: ['部署', '私有化'],
  },
  {
    q: '数据安全怎么保证？',
    qEn: 'How do you keep our data secure?',
    a: '等保三级、数据每日异地备份、支持导出全量数据。',
    aEn: 'Level-3 security certification, daily off-site backups, and full data export at any time.',
    product: '安全',
    tags: ['安全', '合规'],
  },
  {
    q: '太贵了，我们预算不够',
    qEn: "It's too expensive for our budget.",
    a: '先算账：3 个仓管、人均月薪 7,000 元、效率提升 40%，年省人力约 10 万元，标准版首年即回本。',
    aEn: 'Let us do the math: three warehouse staff at 7,000 RMB a month with 40 percent efficiency gain saves about 100,000 RMB a year, so Standard pays for itself in year one.',
    product: '异议',
    tags: ['异议', '价格', 'ROI'],
  },
  {
    q: '我们用 Excel 就够了',
    qEn: 'Excel is good enough for us.',
    a: 'Excel 的问题不是记录而是协同与追溯。可以反问：上次盘点差异是谁的责任、查了多久？',
    aEn: 'The problem with Excel is not recording, it is collaboration and traceability. Ask: last stocktake, whose fault was the gap, and how long did it take to find out?',
    product: '异议',
    tags: ['异议', 'Excel'],
  },
  {
    q: '怕上线失败',
    qEn: 'We are worried the rollout will fail.',
    a: '提供三个同行业案例、30 天退款条款、分阶段上线（先单仓试点 2 周）。',
    aEn: 'Three reference customers in your industry, a 30-day refund clause, and a phased rollout starting with a two-week single-warehouse pilot.',
    product: '异议',
    tags: ['异议', '风险'],
  },
  {
    q: '能不能先免费试用？',
    qEn: 'Can we have a free trial first?',
    a: '不接受无限期免费试用；POC 最长 30 天，需签 POC 协议。也不接受按效果付费、先上线后付款。',
    aEn: 'We do not offer unlimited free trials. A POC runs up to 30 days under a POC agreement. We also cannot do pay-for-performance or pay-after-go-live.',
    product: '政策',
    tags: ['试用', 'POC', '政策'],
  },
  {
    q: '我们原来用竞品，有迁移补贴吗？',
    qEn: 'We are switching from a competitor. Is there a migration credit?',
    a: '提供竞品在用合同或发票可申请一次性迁移补贴：标准版 ¥5,000、专业版 ¥12,000、旗舰版 ¥25,000；与折扣叠加不超过总监权限。',
    aEn: 'With a current competitor contract or invoice you can request a one-time migration credit: 5,000 RMB for Standard, 12,000 for Professional, 25,000 for Enterprise. Combined with discounts it cannot exceed the director limit.',
    product: '政策',
    tags: ['竞品', '补贴', '价格'],
  },
  {
    q: '老客户转介绍有奖励吗？',
    qEn: 'Is there a referral reward?',
    a: '成交后返 5% 服务券。',
    aEn: 'Five percent of the deal comes back as a service voucher after it closes.',
    product: '政策',
    tags: ['转介绍', '政策'],
  },
  {
    q: '你们的账实差异和效率数据是多少？',
    qEn: 'What accuracy and efficiency numbers can you commit to?',
    a: '账实差异 <0.5%、出库效率提升 30–60%、首年回本 8–12 个月、标准版 2 周上线、30 天可退。',
    aEn: 'Stock accuracy within 0.5 percent, outbound efficiency up 30 to 60 percent, payback in 8 to 12 months, two-week go-live for Standard, and a 30-day refund window.',
    product: '数据',
    tags: ['数据', 'ROI'],
  },
]

const SEED_PRODUCTS = [
  {
    name: '标准版',
    price: 68000,
    priceUnit: '年费',
    cycle: '实施 2 周',
    fit: '单仓、日单量 <2,000',
    features: ['收货/上架/拣货/复核/盘点', '基础报表', '20 个并发账号'],
  },
  {
    name: '专业版',
    price: 128000,
    priceUnit: '年费',
    cycle: '实施 4–6 周',
    fit: '2–5 仓、日单量 <10,000',
    features: ['波次策略', '批次效期', '序列号', '多仓调拨', '开放 API'],
  },
  {
    name: '旗舰版',
    price: 238000,
    priceUnit: '年费',
    cycle: '实施 8–12 周',
    fit: '5 仓以上 / 集团',
    features: ['集团看板', '预测补货', 'WES 设备调度', '私有化部署选项'],
  },
]

const SEED_CUSTOMERS = [
  {
    name: '王经理',
    company: '华东冷链（示例）',
    language: 'zh',
    stage: '需求确认',
    budget: '专业版',
    tags: ['冷链', '3 仓'],
    notes: '关注批次效期与多仓调拨；担心上线影响双十一。',
  },
  {
    name: 'Michael Chen',
    company: 'Shenzhen Electronics (sample)',
    language: 'en',
    stage: '报价',
    budget: 'Standard',
    tags: ['electronics', 'single warehouse'],
    notes: 'Needs English documentation and an API sample; price sensitive.',
  },
]

const SEED_ROLES = [
  {
    name: 'Klaus · 德国汽配采购总监',
    kind: 'customer',
    language: 'en',
    company: 'AutoTeile GmbH (sample)',
    difficulty: 'hard',
    persona: [
      'You are Klaus, 52, purchasing director at a German auto-parts distributor with 4 warehouses.',
      'You speak English with a German accent and short sentences. You are polite but impatient.',
      'You care about: delivery lead time, TÜV/CE compliance, multi-warehouse transfer, and total cost over 3 years.',
      'You push back on price and ask for references in the EU. You dislike vague answers and will say "That is not what I asked."',
      'You never accept a discount on the first ask; you hint that a competitor quoted less.',
      'Keep every reply under 45 words and always end with a question or a demand.',
    ].join('\n'),
  },
  {
    name: 'Mei · 东南亚电商运营',
    kind: 'customer',
    language: 'zh',
    company: 'Lazada 卖家 (sample)',
    difficulty: 'normal',
    persona: [
      '你是 Mei，28 岁，东南亚跨境电商运营负责人，管理 3 个平台店铺和一个 1200 平的仓。',
      '你说话快、务实，中文夹英文单词（SKU、ERP、WMS、爆仓）。',
      '你最关心：多平台订单能不能自动同步、和现有 ERP 怎么对接、旺季爆仓怎么扛、价格能不能按月付。',
      '你会追问具体数字和上线周期，对"都可以"这种回答会追问"具体几天？"。',
      '每次回复不超过 60 字，并且要提出一个具体问题。',
    ].join('\n'),
  },
  {
    name: '王厂长 · 国内制造企业',
    kind: 'customer',
    language: 'zh',
    company: '宁波五金制造 (sample)',
    difficulty: 'normal',
    persona: [
      '你是王厂长，55 岁，宁波一家五金制造企业的厂长，厂里 300 人，仓库还靠 Excel 和纸质单。',
      '你谨慎、保守，担心花钱打水漂，也担心工人学不会新系统。',
      '你最关心：和现有用友 ERP 能不能打通、上线要多久、员工培训谁来做、出了问题谁负责。',
      '你不喜欢听概念，喜欢听"别家厂怎么做的""能不能先试一个月"。',
      '每次回复不超过 70 字，语气像面对面聊天，偶尔叹气或反问。',
    ].join('\n'),
  },
]

function nowIso() {
  return new Date().toISOString()
}

function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const question = String(raw.question ?? raw.q ?? '').trim()
  if (question === '') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
    question,
    questionEn: String(raw.questionEn ?? raw.qEn ?? '').trim(),
    answer: String(raw.answer ?? raw.a ?? '').trim(),
    answerEn: String(raw.answerEn ?? raw.aEn ?? '').trim(),
    product: String(raw.product ?? '').trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
    source: String(raw.source ?? 'manual'),
    hits: Number.isFinite(raw.hits) ? raw.hits : 0,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  }
}

function normalizeRole(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const name = String(raw.name ?? '').trim()
  const persona = String(raw.persona ?? '').trim()
  if (name === '' && persona === '') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
    name: name === '' ? '未命名角色' : name,
    persona,
    kind: raw.kind === 'self' ? 'self' : 'customer',
    company: String(raw.company ?? '').trim(),
    difficulty: String(raw.difficulty ?? 'normal'),
    language: raw.language === 'zh' ? 'zh' : 'en',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  }
}

function normalizeMessage(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const text = String(raw.text ?? '').trim()
  if (text === '') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
    speaker: raw.speaker === 'sales' ? 'sales' : raw.speaker === 'note' ? 'note' : 'customer',
    name: String(raw.name ?? '').trim(),
    text,
    at: typeof raw.at === 'string' ? raw.at : nowIso(),
  }
}

function normalizeMeeting(raw) {
  if (raw === null || typeof raw !== 'object') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
    title: String(raw.title ?? '').trim() || '未命名对练',
    mode: raw.mode === 'user-customer'
      ? 'user-customer'
      : raw.mode === 'call-import' ? 'call-import' : 'ai-customer',
    customerId: typeof raw.customerId === 'string' ? raw.customerId : '',
    roleIds: Array.isArray(raw.roleIds) ? raw.roleIds.map(String) : [],
    messages: (Array.isArray(raw.messages) ? raw.messages : []).map(normalizeMessage).filter(Boolean),
    summary: raw.summary !== null && typeof raw.summary === 'object' ? raw.summary : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  }
}

function normalizeStore(raw) {
  const data = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    version: DB_VERSION,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : nowIso(),
    products: Array.isArray(data.products) ? data.products : [],
    qa: (Array.isArray(data.qa) ? data.qa : []).map(normalizeEntry).filter(Boolean),
    roles: (Array.isArray(data.roles) ? data.roles : []).map(normalizeRole).filter(Boolean),
    meetings: (Array.isArray(data.meetings) ? data.meetings : []).map(normalizeMeeting).filter(Boolean),
    customers: Array.isArray(data.customers)
      ? data.customers.map((item) => ({
          id: typeof item?.id === 'string' ? item.id : randomUUID(),
          name: String(item?.name ?? '').trim(),
          company: String(item?.company ?? '').trim(),
          language: String(item?.language ?? 'zh'),
          stage: String(item?.stage ?? '').trim(),
          budget: String(item?.budget ?? '').trim(),
          tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
          notes: String(item?.notes ?? '').trim(),
          createdAt: typeof item?.createdAt === 'string' ? item.createdAt : nowIso(),
          updatedAt: typeof item?.updatedAt === 'string' ? item.updatedAt : nowIso(),
        }))
      : [],
  }
}

function seedPayload() {
  return {
    version: DB_VERSION,
    createdAt: nowIso(),
    products: SEED_PRODUCTS.map((item) => ({ ...item, id: randomUUID() })),
    qa: SEED_QA.map((item) => normalizeEntry({ ...item, source: 'seed' })),
    customers: SEED_CUSTOMERS.map((item) => ({
      ...item,
      id: randomUUID(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })),
    roles: SEED_ROLES.map((item) => normalizeRole(item)),
    meetings: [],
  }
}

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

export class Store {
  constructor(dataRoot, log) {
    this.dataRoot = dataRoot
    this.file = join(dataRoot, 'db.json')
    this.log = log ?? (() => {})
    this.data = normalizeStore(null)
    this.timer = null
    this.index = null
    this.load()
  }

  load() {
    if (!existsSync(this.file)) {
      this.data = seedPayload()
      this.saveNow()
      this.log(`store: seeded ${this.data.qa.length} FAQ entries at ${this.file}`)
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      this.data = normalizeStore(parsed)
    } catch (error) {
      this.log(`store: db.json unreadable (${error.message}); backing up and reseeding`)
      try {
        renameSync(this.file, `${this.file}.broken-${Date.now()}`)
      } catch {
        // ignore
      }
      this.data = seedPayload()
      this.saveNow()
    }
    this.index = null
    this.backfillRoles()
  }

  /** v0.1 databases have no roles; add the starter cast once. */
  backfillRoles() {
    if (this.data.roles.length > 0) return
    this.data.roles = SEED_ROLES.map((item) => normalizeRole(item))
    this.saveNow()
    this.log(`store: backfilled ${this.data.roles.length} starter roles`)
  }

  saveNow() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.log(`store: save failed: ${error.message}`)
    }
  }

  scheduleSave() {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.saveNow()
    }, 1500)
    if (typeof this.timer?.unref === 'function') this.timer.unref()
  }

  flush() {
    if (this.timer !== null) this.saveNow()
  }

  rebuild() {
    const docs = this.data.qa.map((entry) => ({
      id: entry.id,
      // Question text counts twice so "客户刚问的那句话" outranks a body mention.
      tokens: tokenize(
        `${entry.question} ${entry.question} ${entry.questionEn} ${entry.questionEn} ${entry.answer} ${entry.answerEn} ${entry.product} ${entry.tags.join(' ')}`,
      ),
    }))
    this.index = buildIndex(docs)
  }

  search(query, limit = 6) {
    const text = String(query ?? '').trim()
    if (text.length < 1) return []
    if (this.index === null) this.rebuild()
    const queryTokens = tokenize(text)
    if (queryTokens.length === 0) return []
    const byId = new Map(this.data.qa.map((entry) => [entry.id, entry]))
    const lower = text.toLowerCase()
    const scored = scoreDocs(this.index, queryTokens)
    for (const item of scored) {
      const entry = byId.get(item.id)
      if (entry === undefined) continue
      let score = item.score
      if (entry.question.toLowerCase().includes(lower)) score += 4
      else if (entry.questionEn.toLowerCase().includes(lower)) score += 3
      const productHit = entry.product !== '' && lower.includes(entry.product.toLowerCase())
      if (productHit) score += 2
      for (const tag of entry.tags) {
        if (tag !== '' && lower.includes(tag.toLowerCase())) {
          score += 1.5
          break
        }
      }
      item.score = score
      item.confidence = Math.min(0.99, 0.45 * item.coverage + 0.55 * (1 - Math.exp(-score / 6)))
    }
    const kept = scored
      .filter((item) => item.coverage >= 0.5 || item.score >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(20, limit)))
    const hits = []
    for (const item of kept) {
      const entry = byId.get(item.id)
      entry.hits += 1
      hits.push({
        id: entry.id,
        question: entry.question,
        questionEn: entry.questionEn,
        answer: entry.answer,
        answerEn: entry.answerEn,
        product: entry.product,
        tags: entry.tags,
        score: Math.round(item.score * 100) / 100,
        confidence: Math.round(item.confidence * 1000) / 1000,
        coverage: Math.round(item.coverage * 1000) / 1000,
        verdict: item.coverage >= 0.6 || item.score >= 4 ? 'hit' : 'weak',
      })
    }
    if (hits.length > 0) this.scheduleSave()
    return hits
  }

  listQa() {
    return [...this.data.qa].sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
  }

  saveQa(input) {
    const question = String(input?.question ?? '').trim()
    if (question === '') throw new Error('question 不能为空')
    const answer = String(input?.answer ?? '').trim()
    const existing = typeof input?.id === 'string' ? this.data.qa.find((item) => item.id === input.id) : undefined
    if (existing !== undefined) {
      existing.question = question
      existing.questionEn = String(input?.questionEn ?? existing.questionEn).trim()
      existing.answer = answer
      existing.answerEn = String(input?.answerEn ?? existing.answerEn).trim()
      existing.product = String(input?.product ?? existing.product).trim()
      existing.tags = Array.isArray(input?.tags) ? input.tags.map(String) : existing.tags
      existing.updatedAt = nowIso()
      this.index = null
      this.saveNow()
      return existing
    }
    const entry = normalizeEntry({
      question,
      questionEn: input?.questionEn,
      answer,
      answerEn: input?.answerEn,
      product: input?.product,
      tags: input?.tags,
      source: String(input?.source ?? 'manual'),
    })
    this.data.qa.push(entry)
    this.index = null
    this.saveNow()
    return entry
  }

  deleteQa(id) {
    const before = this.data.qa.length
    this.data.qa = this.data.qa.filter((item) => item.id !== id)
    if (this.data.qa.length === before) return false
    this.index = null
    this.saveNow()
    return true
  }

  importQa(text) {
    const parsed = parseImport(text)
    const seen = new Set(this.data.qa.map((item) => item.question.toLowerCase()))
    let added = 0
    for (const item of parsed) {
      if (seen.has(item.question.toLowerCase())) continue
      seen.add(item.question.toLowerCase())
      this.data.qa.push(normalizeEntry({ ...item, source: 'import' }))
      added += 1
    }
    if (added > 0) {
      this.index = null
      this.saveNow()
    }
    return { parsed: parsed.length, added, skipped: parsed.length - added }
  }

  seed() {
    const seen = new Set(this.data.qa.map((item) => item.question.toLowerCase()))
    let added = 0
    for (const item of SEED_QA) {
      if (seen.has(item.q.toLowerCase())) continue
      this.data.qa.push(normalizeEntry({ ...item, source: 'seed' }))
      added += 1
    }
    if (added > 0) {
      this.index = null
      this.saveNow()
    }
    return added
  }

  listCustomers() {
    return [...this.data.customers].sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
  }

  saveCustomer(input) {
    const name = String(input?.name ?? '').trim()
    if (name === '') throw new Error('name 不能为空')
    const existing =
      typeof input?.id === 'string' ? this.data.customers.find((item) => item.id === input.id) : undefined
    const fields = {
      name,
      company: String(input?.company ?? '').trim(),
      language: String(input?.language ?? 'zh'),
      stage: String(input?.stage ?? '').trim(),
      budget: String(input?.budget ?? '').trim(),
      tags: Array.isArray(input?.tags) ? input.tags.map(String) : [],
      notes: String(input?.notes ?? '').trim(),
    }
    if (existing !== undefined) {
      Object.assign(existing, fields, { updatedAt: nowIso() })
      this.saveNow()
      return existing
    }
    const created = { ...fields, id: randomUUID(), createdAt: nowIso(), updatedAt: nowIso() }
    this.data.customers.push(created)
    this.saveNow()
    return created
  }

  deleteCustomer(id) {
    const before = this.data.customers.length
    this.data.customers = this.data.customers.filter((item) => item.id !== id)
    if (this.data.customers.length === before) return false
    this.saveNow()
    return true
  }

  /* roles ---------------------------------------------------------- */

  listRoles() {
    return [...this.data.roles].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  saveRole(input) {
    const role = normalizeRole(input)
    if (role === null) throw new Error('角色至少要有名字或提示词')
    const index = this.data.roles.findIndex((item) => item.id === (input?.id ?? role.id))
    if (index >= 0) {
      role.id = this.data.roles[index].id
      role.createdAt = this.data.roles[index].createdAt
      role.updatedAt = nowIso()
      this.data.roles[index] = role
    } else {
      this.data.roles.push(role)
    }
    this.scheduleSave()
    return role
  }

  deleteRole(id) {
    const before = this.data.roles.length
    this.data.roles = this.data.roles.filter((item) => item.id !== id)
    const removed = before !== this.data.roles.length
    if (removed) this.scheduleSave()
    return removed
  }

  /* meetings ------------------------------------------------------- */

  listMeetings() {
    return [...this.data.meetings]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((meeting) => ({
        id: meeting.id,
        title: meeting.title,
        mode: meeting.mode,
        customerId: meeting.customerId,
        messages: meeting.messages.length,
        summarized: meeting.summary !== null,
        createdAt: meeting.createdAt,
        updatedAt: meeting.updatedAt,
      }))
  }

  getMeeting(id) {
    return this.data.meetings.find((item) => item.id === id) ?? null
  }

  createMeeting(input) {
    const meeting = normalizeMeeting({
      ...input,
      id: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      messages: [],
      summary: null,
    })
    this.data.meetings.push(meeting)
    this.scheduleSave()
    return meeting
  }

  addMessage(id, input) {
    const meeting = this.getMeeting(id)
    if (meeting === null) throw new Error('对练不存在')
    const message = normalizeMessage(input)
    if (message === null) throw new Error('消息不能为空')
    meeting.messages.push(message)
    meeting.updatedAt = nowIso()
    this.scheduleSave()
    return { meeting, message }
  }

  saveMeetingSummary(id, summary) {
    const meeting = this.getMeeting(id)
    if (meeting === null) throw new Error('对练不存在')
    meeting.summary = summary
    meeting.updatedAt = nowIso()
    this.scheduleSave()
    return meeting
  }

  deleteMeeting(id) {
    const before = this.data.meetings.length
    this.data.meetings = this.data.meetings.filter((item) => item.id !== id)
    const removed = before !== this.data.meetings.length
    if (removed) this.scheduleSave()
    return removed
  }

  stats() {
    return {
      dataRoot: this.dataRoot,
      file: this.file,
      qa: this.data.qa.length,
      customers: this.data.customers.length,
      products: this.data.products.length,
      roles: this.data.roles.length,
      meetings: this.data.meetings.length,
      topHits: [...this.data.qa]
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 8)
        .map((item) => ({ id: item.id, question: item.question, hits: item.hits })),
    }
  }
}

/** Parse pasted FAQ text: TSV rows, `Q: ... / A: ...` blocks, or `问 | 答`. */
export function parseImport(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []
  let pending = null
  const push = (question, answer, extra = {}) => {
    const q = String(question ?? '').trim()
    const a = String(answer ?? '').trim()
    if (q === '') return
    out.push({ question: q, answer: a, ...extra })
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const qMatch = /^(?:Q|问|问题)\s*[:：]\s*(.+)$/i.exec(line)
    const aMatch = /^(?:A|答|答案)\s*[:：]\s*(.+)$/i.exec(line)
    if (qMatch !== null) {
      pending = qMatch[1].trim()
      continue
    }
    if (aMatch !== null) {
      push(pending, aMatch[1])
      pending = null
      continue
    }
    const tabParts = line.split('\t')
    if (tabParts.length >= 2) {
      push(tabParts[0], tabParts[1], tabParts[2] !== undefined ? { product: tabParts[2].trim() } : {})
      continue
    }
    const pipeParts = line.split(/\s*[|｜]\s*/)
    if (pipeParts.length >= 2) {
      push(pipeParts[0], pipeParts.slice(1).join(' | '))
      continue
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

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

export function registerApi({ ctx, store, log, realtime, meetingRunner, llm, overlay, tts }) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    log('api: web server unavailable, the panel will not be able to reach the host')
    return () => {}
  }

  /** The host's own base URL, used to reach the live-captions plugin. */
  const selfOrigin = () => {
    try {
      const value = webServer.getOrigin()
      return typeof value === 'string' && value !== '' ? value : null
    } catch {
      return null
    }
  }

  const captionsBase = () => {
    const origin = selfOrigin()
    return origin === null ? null : `${origin}/live-captions/api`
  }

  async function captionsGet(path) {
    const base = captionsBase()
    if (base === null) throw new Error('Web 服务尚未就绪')
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8000) })
    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`live-captions 返回了非 JSON 响应（HTTP ${response.status}）`)
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `live-captions 返回 HTTP ${response.status}`)
    }
    return payload
  }

  async function captionsPost(body) {
    const base = captionsBase()
    if (base === null) throw new Error('Web 服务尚未就绪')
    const response = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`live-captions 返回了非 JSON 响应（HTTP ${response.status}）`)
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `live-captions 返回 HTTP ${response.status}`)
    }
    return payload
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
        json(response, 200, { ok: true, state: store.stats() })
        return
      }

      if (request.method === 'GET' && route === '/qa') {
        json(response, 200, { ok: true, items: store.listQa() })
        return
      }

      if (request.method === 'GET' && route === '/customers') {
        json(response, 200, { ok: true, items: store.listCustomers() })
        return
      }

      if (request.method === 'GET' && route === '/roles') {
        json(response, 200, { ok: true, items: store.listRoles() })
        return
      }

      if (request.method === 'GET' && route === '/meetings') {
        json(response, 200, { ok: true, items: store.listMeetings() })
        return
      }

      if (request.method === 'GET' && route === '/meeting') {
        const meeting = store.getMeeting(url.searchParams.get('id') ?? '')
        json(response, meeting === null ? 404 : 200, meeting === null ? { ok: false, error: '对练不存在' } : { ok: true, meeting })
        return
      }

      if (request.method === 'GET' && route === '/rt/state') {
        json(response, 200, { ok: true, rt: realtime.snapshot(), model: llm.describe(), overlay: overlay.state() })
        return
      }

      if (request.method === 'GET' && route === '/overlay/state') {
        json(response, 200, { ok: true, overlay: overlay.state() })
        return
      }

      if (request.method === 'GET' && route === '/tts/state') {
        json(response, 200, { ok: true, tts: tts.state() })
        return
      }

      if (request.method === 'GET' && route === '/tts/voices') {
        let voices = []
        let error = null
        try {
          voices = await tts.voices()
        } catch (failure) {
          error = failure?.message ?? String(failure)
        }
        json(response, 200, { ok: true, supported: tts.supported, voices, error, tts: tts.state() })
        return
      }

      if (request.method === 'GET' && route === '/captions/sessions') {
        let sessions = []
        let error = null
        try {
          const payload = await captionsGet('/sessions')
          sessions = Array.isArray(payload.sessions) ? payload.sessions : []
        } catch (failure) {
          error = failure?.message ?? String(failure)
        }
        json(response, 200, { ok: true, sessions, error })
        return
      }

      if (request.method === 'GET' && route === '/export') {
        json(response, 200, { ok: true, db: store.data })
        return
      }

      if (request.method === 'POST') {
        const body = await readJson(request)
        switch (route) {
          case '/qa/search': {
            const started = Date.now()
            const matches = store.search(body.query, Number(body.limit ?? 6))
            json(response, 200, {
              ok: true,
              query: String(body.query ?? ''),
              matches,
              tookMs: Date.now() - started,
            })
            return
          }
          case '/qa/save': {
            const item = store.saveQa(body)
            json(response, 200, { ok: true, item })
            return
          }
          case '/qa/delete': {
            json(response, 200, { ok: true, deleted: store.deleteQa(String(body.id ?? '')) })
            return
          }
          case '/qa/import': {
            json(response, 200, { ok: true, ...store.importQa(body.text) })
            return
          }
          case '/qa/seed': {
            json(response, 200, { ok: true, added: store.seed() })
            return
          }
          case '/customer/save': {
            const item = store.saveCustomer(body)
            json(response, 200, { ok: true, item })
            return
          }
          case '/customer/delete': {
            json(response, 200, { ok: true, deleted: store.deleteCustomer(String(body.id ?? '')) })
            return
          }
          /* realtime assist --------------------------------------------- */
          case '/rt/start': {
            const started = realtime.start()
            json(response, 200, { ok: true, rt: realtime.snapshot(), started })
            return
          }
          case '/overlay/open': {
            const result = overlay.open()
            json(response, result.ok ? 200 : 400, { ...result, overlay: overlay.state() })
            return
          }
          case '/overlay/close': {
            json(response, 200, { ok: true, overlay: overlay.close() })
            return
          }
          /* voice: text-to-speech --------------------------------------- */
          case '/tts/speak': {
            const text = String(body.text ?? '').trim()
            if (text === '') {
              json(response, 400, { ok: false, error: '没有可朗读的文本' })
              return
            }
            try {
              const result = await tts.speak({ text, lang: String(body.lang ?? 'en'), rate: Number(body.rate ?? 0) })
              json(response, 200, { ok: true, result, tts: tts.state() })
            } catch (failure) {
              json(response, 400, { ok: false, error: failure?.message ?? String(failure), tts: tts.state() })
            }
            return
          }
          case '/tts/stop': {
            json(response, 200, { ok: true, stopped: tts.stop(), tts: tts.state() })
            return
          }
          case '/rt/stop': {
            const stopped = await realtime.stop()
            json(response, 200, { ok: true, rt: realtime.snapshot(), stopped })
            return
          }
          case '/rt/ai': {
            realtime.setAi(body.enabled === true)
            json(response, 200, { ok: true, rt: realtime.snapshot() })
            return
          }
          case '/rt/reset': {
            json(response, 200, { ok: true, rt: realtime.snapshot(), reset: realtime.reset() })
            return
          }
          case '/rt/ack': {
            realtime.ack()
            json(response, 200, { ok: true, rt: realtime.snapshot() })
            return
          }
          /* roles ------------------------------------------------------- */
          case '/role/save': {
            const item = store.saveRole(body)
            json(response, 200, { ok: true, item })
            return
          }
          case '/role/delete': {
            json(response, 200, { ok: true, deleted: store.deleteRole(String(body.id ?? '')) })
            return
          }
          case '/role/suggest': {
            const drafts = await meetingRunner.suggestRoles({
              brief: String(body.brief ?? ''),
              count: body.count,
              language: String(body.language ?? 'auto'),
            })
            const saved = drafts.map((draft) => store.saveRole(draft))
            json(response, 200, { ok: true, items: saved, model: llm.describe() })
            return
          }
          /* meetings ---------------------------------------------------- */
          case '/meeting/create': {
            const created = store.createMeeting({
              title: String(body.title ?? ''),
              mode: String(body.mode ?? 'ai-customer'),
              customerId: String(body.customerId ?? ''),
              roleIds: Array.isArray(body.roleIds) ? body.roleIds : [],
            })
            json(response, 200, { ok: true, meeting: created })
            return
          }
          case '/meeting/message': {
            const result = store.addMessage(String(body.id ?? ''), {
              speaker: String(body.speaker ?? 'sales'),
              text: String(body.text ?? ''),
              name: String(body.name ?? ''),
            })
            json(response, 200, { ok: true, meeting: result.meeting, message: result.message })
            return
          }
          case '/meeting/turn': {
            const meeting = store.getMeeting(String(body.id ?? ''))
            if (meeting === null) {
              json(response, 404, { ok: false, error: '对练不存在' })
              return
            }
            const turn = await meetingRunner.customerTurn({
              meeting,
              roleId: String(body.roleId ?? ''),
              instruction: String(body.instruction ?? ''),
            })
            const result = store.addMessage(meeting.id, { speaker: 'customer', text: turn.text, name: turn.role.name })
            json(response, 200, { ok: true, role: turn.role, fallback: turn.fallback === true, meeting: result.meeting, message: result.message })
            return
          }
          case '/meeting/summary': {
            const meeting = store.getMeeting(String(body.id ?? ''))
            if (meeting === null) {
              json(response, 404, { ok: false, error: '对练不存在' })
              return
            }
            const summary = await meetingRunner.summarize({ meeting })
            const saved = store.saveMeetingSummary(meeting.id, summary)
            let customer = null
            if (body.applyProfile === true && meeting.customerId !== '') {
              const current = store.data.customers.find((item) => item.id === meeting.customerId) ?? null
              if (current !== null) {
                customer = store.saveCustomer({
                  ...current,
                  stage: summary.profile.stage !== '' ? summary.profile.stage : current.stage,
                  budget: summary.profile.budget !== '' ? summary.profile.budget : current.budget,
                  notes: [current.notes, summary.profile.notes].filter(Boolean).join('\n').slice(0, 2000),
                  tags: [...new Set([...current.tags, ...summary.profile.tags])],
                })
              }
            }
            json(response, 200, { ok: true, meeting: saved, summary, customer })
            return
          }
          /* import a finished call from live-captions ------------------- */
          case '/meeting/from-captions': {
            const requested = String(body.sessionId ?? '').trim()
            let payload
            try {
              payload = await captionsGet(`/records${requested === '' ? '' : `?session=${encodeURIComponent(requested)}`}`)
            } catch (failure) {
              json(response, 400, { ok: false, error: `取不到通话记录：${failure?.message ?? failure}` })
              return
            }
            const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : requested
            const entries = Array.isArray(payload.records?.entries) ? payload.records.entries : []
            const rows = entries
              .map((entry) => ({
                text: String(entry?.text ?? '').trim(),
                time: typeof entry?.time === 'string' ? entry.time : '',
              }))
              .filter((row) => row.text !== '')
              .slice(-200)
            if (rows.length === 0) {
              json(response, 200, { ok: false, error: '这段通话没有可用的字幕记录' })
              return
            }
            const created = store.createMeeting({
              title: String(body.title ?? '').trim() || `通话记录 ${sessionId}`,
              mode: 'call-import',
              customerId: String(body.customerId ?? ''),
              roleIds: [],
            })
            for (const row of rows) {
              store.addMessage(created.id, { speaker: 'customer', text: row.text, name: '客户（通话字幕）', at: row.time })
            }
            let meeting = store.getMeeting(created.id)
            let summary = null
            let customer = null
            if (body.summary !== false) {
              summary = await meetingRunner.summarize({ meeting })
              meeting = store.saveMeetingSummary(meeting.id, summary)
              if (body.applyProfile === true && meeting.customerId !== '') {
                const current = store.data.customers.find((item) => item.id === meeting.customerId) ?? null
                if (current !== null) {
                  customer = store.saveCustomer({
                    ...current,
                    stage: summary.profile.stage !== '' ? summary.profile.stage : current.stage,
                    budget: summary.profile.budget !== '' ? summary.profile.budget : current.budget,
                    notes: [current.notes, summary.profile.notes].filter(Boolean).join('\n').slice(0, 2000),
                    tags: [...new Set([...current.tags, ...summary.profile.tags])],
                  })
                }
              }
            }
            json(response, 200, { ok: true, sessionId, imported: rows.length, meeting, summary, customer })
            return
          }
          /* speak an answer out loud ------------------------------ */
          case '/meeting/voice-turn': {
            const meeting = store.getMeeting(String(body.id ?? ''))
            if (meeting === null) {
              json(response, 404, { ok: false, error: '对练不存在' })
              return
            }
            let live
            try {
              live = (await captionsGet('/state?since=0')).state
            } catch (failure) {
              json(response, 400, { ok: false, error: `取不到字幕状态：${failure?.message ?? failure}` })
              return
            }
            const status = String(live?.status ?? 'idle')
            if (status !== 'idle') {
              json(response, 409, { ok: false, error: '实时字幕正在运行；语音回答要改它的采集设置，请先停止实时辅助再试' })
              return
            }
            const previous = {
              source: live?.settings?.source ?? 'speaker',
              sourceLanguage: live?.settings?.sourceLanguage ?? 'auto',
            }
            const budget = Math.min(Math.max(Number(body.timeoutMs ?? 20000), 6000), 60000)
            const deadline = Date.now() + budget
            let heard = null
            let translation = ''
            try {
              await captionsPost({ action: 'settings', settings: { source: 'mic', sourceLanguage: 'auto' } })
              await captionsPost({ action: 'start' })
              while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 700))
                let snapshot
                try {
                  snapshot = (await captionsGet('/state?since=0')).state
                } catch {
                  continue
                }
                const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
                const final = [...entries].reverse().find((entry) => entry?.draft !== true && String(entry?.text ?? '').trim() !== '')
                if (final !== undefined) {
                  heard = String(final.text).trim()
                  translation = typeof final.translation === 'string' ? final.translation : ''
                  break
                }
              }
            } catch (failure) {
              json(response, 400, { ok: false, error: `语音采集失败：${failure?.message ?? failure}` })
              return
            } finally {
              try {
                await captionsPost({ action: 'stop' })
              } catch {
                // capture already stopped
              }
              try {
                await captionsPost({ action: 'settings', settings: previous })
              } catch (failure) {
                log(`voice-turn: restoring captions settings failed: ${failure?.message ?? failure}`)
              }
            }
            if (heard === null) {
              json(response, 200, { ok: false, error: `没听清（${Math.round(budget / 1000)} 秒内没有说出完整的句子）` })
              return
            }
            const result = store.addMessage(meeting.id, { speaker: 'sales', text: heard, name: '我（语音）' })
            json(response, 200, { ok: true, heard, translation, meeting: result.meeting, message: result.message })
            return
          }
          case '/meeting/delete': {
            json(response, 200, { ok: true, deleted: store.deleteMeeting(String(body.id ?? '')) })
            return
          }
          default:
            json(response, 404, { ok: false, error: `未知接口：${route}` })
            return
        }
      }

      if (request.method === 'GET') {
        json(response, 404, { ok: false, error: `未知接口：${route}` })
        return
      }

      json(response, 405, { ok: false, error: '不支持的请求' })
    } catch (error) {
      log(`api: ${error?.message ?? error}`)
      try {
        json(response, 500, { ok: false, error: error?.message ?? String(error) })
      } catch {
        // response already sent
      }
    }
  }

  try {
    // webServer.register returns a disposer (see dsh-live-captions/lib/api.js).
    return webServer.register({ kind: 'prefix', path: PREFIX, handler })
  } catch (error) {
    log(`api: registration failed: ${error?.message ?? error}`)
    return () => {}
  }
}

/* ------------------------------------------------------------------ */
/* agent tool                                                          */
/* ------------------------------------------------------------------ */

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['search', 'qa_list', 'qa_save', 'qa_import', 'customer_list', 'customer_save', 'stats'],
      description: 'search=按客户原话检索高频问答；qa_list=列问答库；qa_save=新增或更新一条问答；qa_import=粘贴文本批量导入；customer_list/customer_save=客户档案；stats=统计。',
    },
    query: { type: 'string', description: 'search：客户原话（中英皆可）' },
    limit: { type: 'integer', description: 'search：返回条数，默认 5' },
    id: { type: 'string', description: 'qa_save / customer_save：要更新的记录 id' },
    question: { type: 'string' },
    questionEn: { type: 'string' },
    answer: { type: 'string' },
    answerEn: { type: 'string' },
    product: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    text: { type: 'string', description: 'qa_import：粘贴的文本（TSV / Q: A: / 问|答）' },
    name: { type: 'string' },
    company: { type: 'string' },
    language: { type: 'string' },
    stage: { type: 'string' },
    budget: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['action'],
}

function renderTool(args, value) {
  const blocks = [{ type: 'text', text: String(value?.summary ?? '') }]
  if (typeof value?.detail === 'string' && value.detail !== '') {
    blocks.push({ type: 'text', text: value.detail })
  }
  return blocks
}

export function createToolDefinition({ store }) {
  return {
    name: TOOL_NAME,
    description:
      '销售助手：检索/维护双语高频问答库、客户档案与产品价格。search 输入客户原话（中英皆可）返回最匹配的标准答案与命中率；qa_save 保存一条新问答；qa_import 可粘贴多行批量导入。',
    parameters: TOOL_PARAMETERS,
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          detail: { type: 'string' },
          matches: { type: 'array', items: { type: 'object' } },
        },
        required: ['ok', 'summary'],
      },
      render: renderTool,
    },
    execute: async (args) => {
      const input = args ?? {}
      switch (input.action) {
        case 'search': {
          const matches = store.search(input.query, Number(input.limit ?? 5))
          if (matches.length === 0) {
            return { ok: true, summary: `未命中：${input.query ?? ''}`, matches: [] }
          }
          const lines = matches.map((item, index) => {
            const pct = Math.round(item.confidence * 100)
            return `${index + 1}. [${pct}%] ${item.question}\n   中文：${item.answer}\n   EN：${item.answerEn || '(无英文)'}`
          })
          return {
            ok: true,
            summary: `命中 ${matches.length} 条（最高 ${Math.round(matches[0].confidence * 100)}%），首选：${matches[0].answer}`,
            detail: lines.join('\n'),
            matches,
          }
        }
        case 'qa_list': {
          const items = store.listQa()
          return {
            ok: true,
            summary: `问答库共 ${items.length} 条`,
            detail: items
              .slice(0, 50)
              .map((item, index) => `${index + 1}. ${item.question}${item.product ? `（${item.product}）` : ''}`)
              .join('\n'),
          }
        }
        case 'qa_save': {
          const item = store.saveQa(input)
          return { ok: true, summary: `已保存：${item.question}`, detail: item.answer }
        }
        case 'qa_import': {
          const result = store.importQa(input.text)
          return {
            ok: true,
            summary: `导入完成：解析 ${result.parsed} 条，新增 ${result.added} 条，跳过重复 ${result.skipped} 条`,
          }
        }
        case 'customer_list': {
          const items = store.listCustomers()
          return {
            ok: true,
            summary: `客户档案共 ${items.length} 条`,
            detail: items.map((item) => `${item.name}${item.company ? ` · ${item.company}` : ''}（${item.stage || '未标阶段'}）`).join('\n'),
          }
        }
        case 'customer_save': {
          const item = store.saveCustomer(input)
          return { ok: true, summary: `已保存客户：${item.name}` }
        }
        case 'stats': {
          const stats = store.stats()
          return {
            ok: true,
            summary: `问答 ${stats.qa} 条、客户 ${stats.customers} 条、产品 ${stats.products} 条`,
            detail: `数据目录：${stats.dataRoot}`,
          }
        }
        default:
          return { ok: false, summary: `未知操作：${input.action ?? '(空)'}` }
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const dataRoot = resolveDataRoot(config)
  mkdirSync(dataRoot, { recursive: true })
  const log = createLogger(dataRoot)
  const store = new Store(dataRoot, log)
  const llm = createLlm(ctx, log)
  const pluginRoot = dirname(fileURLToPath(import.meta.url))
  const meetingRunner = createMeeting({ store, llm, log })
  const getOrigin = () => {
    try {
      const webServer = ctx.get('webServer')
      return typeof webServer?.getOrigin === 'function' ? webServer.getOrigin() : null
    } catch {
      return null
    }
  }
  const realtime = createRealtime({ store, llm, log, getOrigin })
  const overlay = createOverlay({ root: pluginRoot, log, getOrigin })
  const tts = createTts({ root: pluginRoot, log })
  log(`plugin activated, dataRoot=${dataRoot}, qa=${store.data.qa.length}, customers=${store.data.customers.length}`)

  ctx.effect(() => () => {
    realtime.stop()
    overlay.dispose()
    tts.stop()
    store.flush()
    log('plugin unloading')
  }, 'sales-copilot: store')

  ctx.inject(['webServer'], (scoped) => {
    const dispose = registerApi({ ctx: scoped, store, log, realtime, meetingRunner, llm, overlay, tts })
    scoped.effect(() => dispose, 'sales-copilot: api')
  })

  ctx.inject(['tools'], (scoped) => {
    const dispose = scoped.tools.register(createToolDefinition({ store }), {})
    scoped.effect(() => dispose, 'sales-copilot: tool')
  })
}
