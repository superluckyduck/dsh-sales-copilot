/**
 * live-captions 提示词解析（从 server.mjs 拆出来，便于单测时不被 HTTP 监听拖累）。
 *
 * 真实形态见 dsh-live-captions/lib/llm.js:391-397（local 引擎只发单句）与
 * 257-265（批量 [n] 标记，云端专用，这里防御性支持）。
 */

/** messages 里的 content 可能是字符串，也可能是 [{type:'text',text}] 数组 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 从提示词里抽出「目标语言 + 待翻译文本」 */
export function parsePrompt(messages) {
  const list = Array.isArray(messages) ? messages : []
  const system = list
    .filter((message) => message.role === 'system')
    .map((message) => textOf(message.content))
    .join('\n')
  const userMessages = list.filter((message) => message.role === 'user')
  const user = textOf(userMessages[userMessages.length - 1]?.content ?? '')

  const target =
    /翻译成\s*([^：:\n，,。]+)/.exec(user)?.[1]?.trim() ||
    /只输出\s*(.+?)\s*译文/.exec(system)?.[1]?.trim() ||
    '简体中文'

  // 1) 单句：把下面这句话翻译成X：\n原文（可能带「上文（仅供理解，不要翻译）：…」前缀）
  const single = /把下面这句话翻译成[^：:\n]*[：:]\s*([\s\S]+)$/.exec(user)
  if (single !== null) return { kind: 'single', target, text: single[1].trim() }

  // 2) 批量：[1] 原句 / [2] 原句 …
  if (/待翻译[：:]/.test(user)) {
    const body = user.slice(user.indexOf('待翻译：') + 4)
    const lines = []
    for (const line of body.split(/\r?\n/)) {
      const match = /^\s*(?:[-*]\s*)?\[(\d+)\]\s*(.+)$/.exec(line)
      if (match !== null) lines.push({ seq: Number(match[1]), text: match[2].trim() })
    }
    if (lines.length > 0) return { kind: 'batch', target, lines }
  }

  // 3) 兜底：取最后一个全角冒号之后的内容
  const fallback = user.slice(user.lastIndexOf('：') + 1).trim() || user.trim()
  return { kind: 'single', target, text: fallback }
}
