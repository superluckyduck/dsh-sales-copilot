/**
 * Meeting-room logic: role prompts, in-character customer turns, and the
 * post-meeting summary that feeds the customer profile.
 *
 * Everything that needs a model goes through `lib/llm.js`, which resolves the
 * provider/model from the host's current selection. When no model is available
 * the module degrades to deterministic behaviour so the UI still works.
 */

const MAX_CONTEXT_MESSAGES = 14

/**
 * The buyer's behaviour contract. Earlier versions let the model "not know the
 * product", which made hard roles answer `Sorry — what exactly do you mean?` to
 * perfectly clear questions. A believable buyer is an expert on their OWN
 * operation and pushes on price, proof and risk instead of playing dumb.
 */
const BUYER_STYLE = [
  '你是一位真实的 B2B 买家，在自己的公司里有决策权。对话规则：',
  '- 你非常熟悉自己的业务：几个仓、什么品类、日均单量、现在用什么系统、哪里最痛、预算范围，你会主动说出具体数字或具体场景。',
  '- 你绝不装听不懂：对方问得合理就直接给信息，然后立刻反问一个对你真正重要的点。',
  '- 你对价格、上线周期、实施风险、同行案例都敏感，会用自己的判断压价、要求证据，或拿别家方案做比较。',
  '- 每次只说 1–3 句，像真人口语，不用列表、不用 Markdown、不解释产品（那是销售的事）、不替销售总结。',
  '- 不复述对方的话，不复述自己的开场白，紧接对方刚才那句回应。',
  '- 除非对方的话确实含混到无法理解，否则禁止用「你是什么意思」「能再说一遍吗」这类敷衍句。',
].join('\n')

const PRESSURE = {
  easy: '你的态度偏友善，愿意听介绍，主要关心基本功能、大致报价和上线要多久；问题直接，但不会刻意为难。',
  normal:
    '你在同时评估 2–3 家供应商，会拿同业案例、上线周期和报价做比较，会要求 ROI 测算或客户见证；价格上会试探，但讲道理。',
  hard: '你高度怀疑，习惯用竞品报价压价、追问交付细节和失败案例，会质疑对方说法的可信度；语气客气但寸步不让，必要时打断。',
}

/** Pure: the system prompt for one in-character customer turn. */
export function buildCustomerSystem(role) {
  const difficulty = ['easy', 'normal', 'hard'].includes(role?.difficulty) ? role.difficulty : 'normal'
  return [
    String(role?.persona ?? '').trim(),
    BUYER_STYLE,
    `本轮施压程度：${PRESSURE[difficulty]}`,
    '你正在一场销售对话中扮演客户。你只能以客户身份说话，绝不能替销售回答、不能评价自己的表演、也不能跳出角色。',
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

function trim(text, max) {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function transcriptOf(messages) {
  const recent = messages.slice(-MAX_CONTEXT_MESSAGES)
  return recent
    .map((message) => {
      const who = message.speaker === 'sales' ? 'SALES (me)' : message.speaker === 'note' ? 'NOTE' : `CUSTOMER${message.name ? ` (${message.name})` : ''}`
      return `${who}: ${message.text}`
    })
    .join('\n')
}

function factsOf(store, limit = 6) {
  const entries = [...store.data.qa].slice(0, limit)
  return entries.map((entry) => `- Q: ${entry.question} | A: ${entry.answer}`).join('\n')
}

export function createMeeting({ store, llm, log }) {
  async function suggestRoles({ brief = '', count = 3, language = 'auto' } = {}) {
    const wanted = Math.min(5, Math.max(1, Number(count) || 3))
    const fallback = () => [
      {
        name: '新客户 · 采购负责人',
        persona: `你是${brief || '一位正在评估仓储管理系统的客户'}。你务实、时间紧，会直接问价格、上线周期和风险。每次回复不超过 60 字并追问一个细节。`,
        language: language === 'en' ? 'en' : 'zh',
        difficulty: 'normal',
        company: '',
      },
    ]
    if (!llm.available()) return fallback()
    try {
      const raw = await llm.ask({
        system:
          '你是一名 B2B SaaS 销售培训教练。你为销售对练设计真实的客户角色提示词，角色要有具体身份、痛点、说话风格和施压方式。只输出 JSON 数组。',
        prompt: [
          `产品：智仓 WMS（仓储管理系统，标准版 6.8 万/年、专业版 12.8 万/年、旗舰版 23.8 万/年，实施 2–12 周）。`,
          `请生成 ${wanted} 个客户角色${brief ? `，背景提示：${brief}` : '，覆盖不同国家/行业/性格'}。`,
          language === 'en' ? '每个角色的 language 必须是 "en"。' : language === 'zh' ? '每个角色的 language 必须是 "zh"。' : 'language 用 "en" 或 "zh"，中英文角色都要有。',
          '输出格式：[{"name":"姓名 · 身份","persona":"第二人称的角色提示词，含身份/痛点/说话风格/会怎么压价或质疑/回复长度限制","language":"en","difficulty":"easy|normal|hard","company":"公司名"}]',
          'persona 要写成可以直接喂给模型的系统提示词，150 字以内。只输出 JSON。',
        ].join('\n'),
        maxTokens: 1200,
        temperature: 0.8,
        timeoutMs: 40000,
      })
      const parsed = llm.parseJson(raw)
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.roles) ? parsed.roles : []
      const roles = list
        .filter((item) => item !== null && typeof item === 'object')
        .map((item) => ({
          name: trim(item.name ?? '新客户', 40) || '新客户',
          persona: trim(item.persona ?? '', 1600),
          language: item.language === 'en' ? 'en' : item.language === 'zh' ? 'zh' : language === 'en' ? 'en' : 'zh',
          difficulty: ['easy', 'normal', 'hard'].includes(item.difficulty) ? item.difficulty : 'normal',
          company: trim(item.company ?? '', 60),
        }))
        .filter((item) => item.persona !== '')
      return roles.length > 0 ? roles.slice(0, wanted) : fallback()
    } catch (error) {
      log(`meeting: suggestRoles failed: ${error?.message ?? error}`)
      return fallback()
    }
  }

  function pickRole(meeting, roleId) {
    const id = typeof roleId === 'string' && roleId !== '' ? roleId : meeting.roleIds[0]
    const role = store.data.roles.find((item) => item.id === id) ?? null
    if (role !== null) return role
    return (
      store.data.roles.find((item) => item.kind === 'customer') ?? {
        id: 'fallback',
        name: '客户',
        persona: '你是一位正在评估仓储管理系统的客户，务实、时间紧，会直接问价格和上线周期。',
        language: 'zh',
      }
    )
  }

  /**
   * One in-character customer reply. `mode: 'user-customer'` means the user
   * plays the customer themselves, so we only speak when explicitly asked.
   */
  async function customerTurn({ meeting, roleId = '', instruction = '' }) {
    const role = pickRole(meeting, roleId)
    const language = role.language === 'en' ? 'en' : 'zh'
    const product = factsOf(store)
    if (!llm.available()) {
      const line =
        language === 'en'
          ? 'Sorry, can you say that again? And what would that cost us in the first year?'
          : '不好意思，你能再说一遍吗？第一年我们大概要花多少钱？'
      return { role, text: line, fallback: true }
    }
    const transcript = transcriptOf(meeting.messages)
    try {
      const raw = await llm.ask({
        system: buildCustomerSystem(role),
        prompt: [
          product ? `（以下是销售方的产品资料，只用来判断对方的说法是否可信，不要照念，也不要主动报价）\n${product}` : '',
          transcript ? `当前对话记录：\n${transcript}` : '对话刚刚开始，你是第一次和这位销售交谈。先简短说明你的身份和当前情况，不要问「你有什么事」。',
          instruction ? `本轮的额外指令（必须遵守）：${instruction}` : '',
          language === 'en' ? 'Reply in English only, as the customer. No narration, no quotes.' : '只用中文、以客户身份回复。不要旁白、不要加引号。',
          '直接输出你要说的那句话。',
        ]
          .filter(Boolean)
          .join('\n\n'),
        maxTokens: 300,
        temperature: 0.85,
        timeoutMs: 40000,
      })
      const text = String(raw ?? '').trim().replace(/^["“]|["”]$/g, '')
      if (text === '') throw new Error('模型返回空回复')
      return { role, text, fallback: false }
    } catch (error) {
      log(`meeting: customerTurn failed: ${error?.message ?? error}`)
      return { role, text: language === 'en' ? 'Sorry — what exactly do you mean by that?' : '不好意思，你这句话具体是什么意思？', fallback: true }
    }
  }

  async function summarize({ meeting }) {
    const transcript = meeting.messages.map((message) => `${message.speaker === 'sales' ? '销售' : message.speaker === 'note' ? '备注' : '客户'}: ${message.text}`).join('\n')
    const customer = store.data.customers.find((item) => item.id === meeting.customerId) ?? null
    const base = {
      summary: '',
      needs: [],
      nextSteps: [],
      profile: { stage: '', budget: '', notes: '', tags: [] },
      at: new Date().toISOString(),
      model: llm.describe(),
    }
    if (!llm.available() || transcript.trim() === '') {
      base.summary = '（未配置模型或对话为空，未生成总结）'
      return base
    }
    try {
      const raw = await llm.ask({
        system:
          '你是 B2B SaaS 销售的会议纪要助手。你从销售与客户的对话里提取事实，不编造。只输出 JSON。',
        prompt: [
          `产品：智仓 WMS。${customer ? `客户档案：${customer.name} / ${customer.company}，阶段 ${customer.stage}，预算 ${customer.budget}，备注 ${customer.notes}` : '尚无客户档案。'}`,
          `对话记录：\n${transcript}`,
          '请输出 JSON：{',
          '  "summary": "3–5 句中文总结：客户是谁、关心什么、双方谈到哪一步",',
          '  "needs": ["客户明确表达的需求，最多 6 条，每条不超过 20 字"],',
          '  "nextSteps": ["下一步动作，最多 4 条，含负责人和时间"],',
          '  "profile": {',
          '    "stage": "需求确认|方案沟通|报价|谈判|赢单|搁置",',
          '    "budget": "客户提到的预算或版本，没有就空字符串",',
          '    "notes": "补充画像：决策链、时间点、顾虑、竞争信息，200 字以内",',
          '    "tags": ["3–6 个关键词"]',
          '  }',
          '}',
          '只输出 JSON。',
        ].join('\n'),
        maxTokens: 900,
        temperature: 0.3,
        timeoutMs: 60000,
      })
      const parsed = llm.parseJson(raw)
      const needs = Array.isArray(parsed?.needs) ? parsed.needs.map((item) => trim(item, 80)).filter(Boolean).slice(0, 6) : []
      const nextSteps = Array.isArray(parsed?.nextSteps) ? parsed.nextSteps.map((item) => trim(item, 100)).filter(Boolean).slice(0, 4) : []
      const tags = Array.isArray(parsed?.profile?.tags) ? parsed.profile.tags.map((item) => trim(item, 20)).filter(Boolean).slice(0, 6) : []
      return {
        ...base,
        summary: trim(parsed?.summary ?? '', 1200),
        needs,
        nextSteps,
        profile: {
          stage: trim(parsed?.profile?.stage ?? '', 20),
          budget: trim(parsed?.profile?.budget ?? '', 40),
          notes: trim(parsed?.profile?.notes ?? '', 600),
          tags,
        },
      }
    } catch (error) {
      log(`meeting: summarize failed: ${error?.message ?? error}`)
      base.summary = `生成总结失败：${error?.message ?? error}`
      return base
    }
  }

  return { suggestRoles, customerTurn, summarize }
}
