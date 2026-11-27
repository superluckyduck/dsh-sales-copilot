/**
 * Meeting-room logic: role prompts, in-character customer turns, and the
 * post-meeting summary that feeds the customer profile.
 *
 * Everything that needs a model goes through `lib/llm.js`, which resolves the
 * provider/model from the host's current selection. When no model is available
 * the module degrades to deterministic behaviour so the UI still works.
 */

const MAX_CONTEXT_MESSAGES = 14

/** How the AI salesperson is expected to sell — product facts live in the FAQ library. */
const SALES_STYLE = [
  '你是一位资深 B2B SaaS 销售，正在和一位客户做一对一演练。对话规则：',
  '- 你是销售方，绝不能替客户说话、不能编造客户会怎么回答、不能跳出角色点评这场演练。',
  '- 输出只能是你当场要说的那句话本身：不要写内心思考、分析、判断过程、引号、旁白、标题或任何解释性文字。',
  '- 只在客户刚说的那句话上继续：先回应他的关注点或异议，再推进到下一步（问需求、给证据、谈方案、约下一步）。',
  '- 用产品资料里的事实说话：报价、版本、实施周期、部署方式、案例只能取自资料，不确定的就说「我确认后给你准确数字」，绝不瞎编。',
  '- 每次只说 1–3 句口语，像真人销售，不用列表、不用 Markdown、不自我介绍、不说「作为销售」。',
  '- 不复述客户刚说的话，也不复述自己的开场白；客户没开口前不要长篇介绍。',
  '- 如果客户始终不说话，才用一句开放式问题把话题打开。',
].join('\n')

/**
 * The buyer's behaviour contract. Earlier versions let the model "not know the
 * product", which made hard roles answer `Sorry — what exactly do you mean?` to
 * perfectly clear questions. A believable buyer is an expert on their OWN
 * operation and pushes on price, proof and risk instead of playing dumb.
 */
const BUYER_STYLE = [
  '你是一位真实的 B2B 买家，在自己的公司里有决策权。对话规则：',
  '- 输出只能是你当场要说的那句话本身：不要写内心思考、分析、判断过程、引号、旁白或任何角色外的文字。',
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

/** Pure: the system prompt for one in-character seller (AI plays the salesperson) turn. */
export function buildSalesSystem() {
  return SALES_STYLE
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

/**
 * Some reasoning models stream their analysis as ordinary text even with
 * reasoningEffort='off'. The analysis ends with the actual line, usually
 * drafted in quotes after a marker such as 可说：/可以说：/回复：. Extract
 * that spoken line so the roleplay never "speaks" the model's thinking.
 * Short, clean replies are returned untouched.
 */
function extractSpokenLine(text) {
  let value = String(text ?? '').trim()
  if (value === '') return value
  value = value.replace(/```[\s\S]*?```/g, '').trim()

  // The model drafts the final line in quotes after a "say this" marker.
  const drafts = [...value.matchAll(/(?:可说|可以说|可回答|回复|应说|回答)[：:]?\s*[“"]([^”"]{6,500})[”"]/g)]
  if (drafts.length > 0) {
    const last = drafts[drafts.length - 1][1].trim()
    if (last !== '') return last
  }

  // Long output with no marker: prefer the longest quoted span, which is the
  // drafted answer, over the surrounding reasoning.
  if (value.length > 180) {
    const quotes = [...value.matchAll(/[“"]([^”"]{8,500})[”"]/g)]
      .map((match) => match[1].trim())
      .filter((item) => item !== '')
    if (quotes.length > 0) return quotes.sort((a, b) => b.length - a.length)[0]
  }

  return value
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
  return entries.map((entry) => `- Q: ${entry.question} | A: ${entry.answer}${entry.answerEn ? ` / ${entry.answerEn}` : ''}`).join('\n')
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
   * One in-character reply from the AI SALESPERSON (mode 'user-customer'): the
   * user plays the customer, the model plays the sales rep. This is the missing
   * half of the second practice mode — without it "我扮客户" was just a label.
   */
  async function salesTurn({ meeting, instruction = '', language = 'auto' } = {}) {
    const lang = language === 'en' || language === 'zh' ? language : 'zh'
    const product = factsOf(store)
    if (!llm.available()) {
      const line = lang === 'en'
        ? "Sure — what's your current setup, and what are you looking to improve?"
        : '好的，方便说说您现在用的是什么系统、最想解决哪一块吗？'
      return { text: line, fallback: true }
    }
    const transcript = transcriptOf(meeting.messages)
    try {
      const raw = await llm.ask({
        system: buildSalesSystem(),
        prompt: [
          product ? `（产品资料，只能引用这里的事实，不要照念、不要编造）\n${product}` : '',
          transcript ? `当前对话记录：\n${transcript}` : '对话刚刚开始，客户还没开口。用一句简短的开放式问题开场。',
          instruction ? `本轮的额外指令（必须遵守）：${instruction}` : '',
          lang === 'en' ? 'Reply in English only, as the salesperson. Output ONLY the line you would say — no reasoning, no analysis, no narration, no quotes.' : '只用中文、以销售身份回复。只输出你当场要说的那句话，不要思考过程、分析、旁白或引号。',
          '直接输出你要说的那句话。',
        ]
          .filter(Boolean)
          .join('\n\n'),
        // Reasoning-heavy models need room for their analysis before the
        // drafted line; extractSpokenLine keeps only the final spoken line.
        maxTokens: 1200,
        temperature: 0.75,
        timeoutMs: 40000,
      })
      const text = extractSpokenLine(raw)
      if (text === '') throw new Error('模型返回空回复')
      return { text, fallback: false }
    } catch (error) {
      log(`meeting: salesTurn failed: ${error?.message ?? error}`)
      return { text: lang === 'en' ? 'Let me confirm that and get back to you with exact numbers.' : '这个我确认一下，稍后给您准确数字。', fallback: true }
    }
  }

  /**
   * One in-character customer reply. `mode: 'user-customer'` means the user
   * plays the customer themselves, so we only speak when explicitly asked.
   */
  async function customerTurn({ meeting, roleId = '', instruction = '', language: languageHint = '' }) {
    const role = pickRole(meeting, roleId)
    // Voice practice can override the role's default language with the
    // language the user actually spoke; normal practice keeps the role setting.
    const language = languageHint === 'en' || languageHint === 'zh' ? languageHint : (role.language === 'en' ? 'en' : 'zh')
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
          language === 'en' ? 'Reply in English only, as the customer. Output ONLY the line you would say — no reasoning, no analysis, no narration, no quotes.' : '只用中文、以客户身份回复。只输出你当场要说的那句话，不要思考过程、分析、旁白或引号。',
          '直接输出你要说的那句话。',
        ]
          .filter(Boolean)
          .join('\n\n'),
        // Reasoning-heavy models need room for their analysis before the
        // drafted line; extractSpokenLine keeps only the final spoken line.
        maxTokens: 1200,
        temperature: 0.85,
        timeoutMs: 40000,
      })
      const text = extractSpokenLine(raw)
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

  return { suggestRoles, customerTurn, salesTurn, summarize }
}
