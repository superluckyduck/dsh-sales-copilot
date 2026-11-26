/**
 * dsh-sales-copilot — browser panel.
 *
 * Registers a sidebar entry plus a full-screen overlay panel with four tabs:
 * instant lookup, FAQ library, customers, settings (plus the v0.2 roadmap).
 *
 * No build step: this file is loaded as-is by the DSH client module loader.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sales-copilot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useSyncExternalStore } = React

    const API = '/sales-copilot/api'

    const C = {
      bg: 'var(--dsw-alias-bg-base, #f6f7f9)',
      surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      surface2: 'var(--dsw-alias-bg-layer-2, #f1f2f5)',
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      muted: 'color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 66%, transparent)',
      border: 'var(--dsw-alias-border-l2, #c7ccd4)',
      borderSoft: 'color-mix(in srgb, var(--dsw-alias-border-l2, #c7ccd4) 55%, transparent)',
      accent: 'var(--dsw-alias-brand-primary, #3b6ef6)',
      accentSoft: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6ef6) 10%, transparent)',
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
      success: 'var(--dsw-alias-state-success-primary, #30a46c)',
      warn: 'var(--dsw-alias-state-warn-primary, #f5a623)',
      fg: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
    }

    const s = {
      panel: {
        position: 'fixed',
        top: 56,
        right: 14,
        bottom: 14,
        width: 'min(460px, calc(100vw - 28px))',
        zIndex: 300,
        display: 'flex',
        flexDirection: 'column',
        background: C.bg,
        color: C.text,
        pointerEvents: 'auto',
        fontFamily: 'inherit',
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        boxShadow: '0 18px 48px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)',
        overflow: 'hidden',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 52,
        padding: '0 12px',
        background: C.surface,
        borderBottom: `1px solid ${C.border}`,
        flexShrink: 0,
      },
      brand: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
      brandTitle: { fontSize: 15, fontWeight: 600, lineHeight: '20px' },
      brandSub: { fontSize: 11.5, color: C.muted, lineHeight: '15px' },
      grip: (active) => ({
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        width: 10,
        cursor: 'col-resize',
        zIndex: 2,
        borderRadius: '14px 0 0 14px',
        background: active
          ? 'color-mix(in srgb, var(--dsw-alias-brand-primary,#3b6ef6) 22%, transparent)'
          : 'transparent',
        transition: 'background 120ms ease',
      }),
      tabs: { display: 'flex', gap: 2, padding: 3, borderRadius: 10, background: C.surface2, marginLeft: 'auto' },
      tab: {
        padding: '6px 12px',
        fontSize: 13,
        lineHeight: '18px',
        border: 'none',
        borderRadius: 7,
        background: 'transparent',
        color: C.muted,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      tabActive: {
        background: C.surface,
        color: C.text,
        fontWeight: 600,
        boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
      },
      close: {
        width: 30,
        height: 30,
        marginLeft: 4,
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        background: C.surface,
        color: C.muted,
        fontSize: 14,
        cursor: 'pointer',
        lineHeight: '26px',
      },
      main: { flex: 1, overflowY: 'auto', padding: '16px 16px 28px' },
      wrap: { maxWidth: 1020, margin: '0 auto' },
      searchRow: { position: 'relative', marginBottom: 18 },
      search: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '13px 16px',
        fontSize: 16,
        lineHeight: '22px',
        borderRadius: 12,
        border: `1px solid ${C.border}`,
        background: C.surface,
        color: C.text,
        outline: 'none',
        fontFamily: 'inherit',
      },
      hintRow: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 12, color: C.muted },
      card: {
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        background: C.surface,
        padding: '14px 16px',
        marginBottom: 12,
      },
      cardHead: { display: 'flex', alignItems: 'flex-start', gap: 12 },
      cardTitleWrap: { flex: 1, minWidth: 0 },
      cardTitle: { fontSize: 15, fontWeight: 600, lineHeight: '21px', wordBreak: 'break-word' },
      cardSub: { fontSize: 12.5, color: C.muted, marginTop: 3, wordBreak: 'break-word' },
      pill: {
        flexShrink: 0,
        fontSize: 12,
        fontWeight: 600,
        padding: '3px 9px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
      },
      block: { marginTop: 12, padding: '10px 12px', borderRadius: 10, background: C.surface2 },
      blockEn: {
        marginTop: 8,
        padding: '10px 12px',
        borderRadius: 10,
        background: C.accentSoft,
        border: `1px solid color-mix(in srgb, ${C.accent} 22%, transparent)`,
      },
      blockLabel: {
        fontSize: 11,
        letterSpacing: '0.04em',
        color: C.muted,
        marginBottom: 5,
        textTransform: 'uppercase',
      },
      blockText: { fontSize: 14, lineHeight: '21px', wordBreak: 'break-word' },
      blockTextEn: { fontSize: 14, lineHeight: '21px', wordBreak: 'break-word', fontWeight: 500 },
      cardFoot: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' },
      chip: {
        fontSize: 11.5,
        padding: '2px 8px',
        borderRadius: 6,
        background: C.surface2,
        color: C.muted,
        border: `1px solid ${C.borderSoft}`,
      },
      btn: {
        padding: '6px 11px',
        fontSize: 12.5,
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        background: C.surface,
        color: C.text,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      btnPrimary: {
        padding: '8px 14px',
        fontSize: 13,
        borderRadius: 9,
        border: '1px solid transparent',
        background: C.accent,
        color: C.fg,
        cursor: 'pointer',
        fontWeight: 600,
        fontFamily: 'inherit',
      },
      btnDanger: {
        padding: '6px 11px',
        fontSize: 12.5,
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.danger,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      empty: {
        border: `1px dashed ${C.border}`,
        borderRadius: 14,
        padding: '28px 20px',
        textAlign: 'center',
        color: C.muted,
        fontSize: 13.5,
        lineHeight: '21px',
        background: C.surface,
      },
      sectionTitle: { fontSize: 13, fontWeight: 600, margin: '24px 0 10px' },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 240px', minWidth: 0 },
      label: { fontSize: 12, color: C.muted },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '9px 11px',
        fontSize: 13.5,
        borderRadius: 9,
        border: `1px solid ${C.border}`,
        background: C.surface,
        color: C.text,
        outline: 'none',
        fontFamily: 'inherit',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '10px 12px',
        fontSize: 13.5,
        lineHeight: '20px',
        minHeight: 96,
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        background: C.surface,
        color: C.text,
        outline: 'none',
        resize: 'vertical',
        fontFamily: 'inherit',
      },
      banner: {
        marginBottom: 14,
        padding: '9px 12px',
        borderRadius: 9,
        fontSize: 13,
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 9%, transparent)',
        color: C.danger,
      },
      bannerOk: {
        marginBottom: 14,
        padding: '9px 12px',
        borderRadius: 9,
        fontSize: 13,
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 10%, transparent)',
        color: C.success,
      },
      kv: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: '8px 14px', fontSize: 13, lineHeight: '20px' },
      kvKey: { color: C.muted },
      kvVal: { wordBreak: 'break-all', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12.5 },
      roadItem: { display: 'flex', gap: 10, padding: '10px 0', borderBottom: `1px solid ${C.borderSoft}`, fontSize: 13.5, lineHeight: '21px' },
    }

    /* ---------------------------------------------------------------- */
    /* api helper                                                        */
    /* ---------------------------------------------------------------- */

    async function api(path, init) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        throw new Error(`服务端返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (payload === null || payload.ok !== true) {
        throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`)
      }
      return payload
    }

    function confidenceColor(confidence) {
      if (confidence >= 0.75) return { color: C.success, background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 12%, transparent)' }
      if (confidence >= 0.5) return { color: C.warn, background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a623) 14%, transparent)' }
      return { color: C.muted, background: C.surface2 }
    }

    function IconBubble(props) {
      const size = props?.size ?? 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block', flexShrink: 0 } },
        h('path', {
          d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6a.6.6 0 0 1-1-.46V16A2.5 2.5 0 0 1 4 13.5z',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 9, cy: 9, r: 1.05, fill: 'currentColor' }),
        h('circle', { cx: 12.5, cy: 9, r: 1.05, fill: 'currentColor' }),
        h('circle', { cx: 16, cy: 9, r: 1.05, fill: 'currentColor' }),
      )
    }

    /* ---------------------------------------------------------------- */
    /* panel open state                                                  */
    /* ---------------------------------------------------------------- */

    function createPanelStore() {
      let open = false
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) listener()
      }
      return {
        getSnapshot: () => open,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        open() {
          open = true
          emit()
        },
        close() {
          open = false
          emit()
        },
        toggle() {
          open = !open
          emit()
        },
      }
    }

    function SidebarAction(props) {
      const open = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
      const [hovered, setHovered] = useState(false)
      const wide = props.wide !== false
      return h(
        'button',
        {
          type: 'button',
          title: '销售助手 Sales Copilot',
          'aria-label': '销售助手 Sales Copilot',
          onClick: () => props.store.toggle(),
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: wide ? '100%' : 34,
            height: 34,
            justifyContent: wide ? 'flex-start' : 'center',
            padding: wide ? '0 10px' : 0,
            lineHeight: '20px',
            boxSizing: 'border-box',
            border: 'none',
            borderRadius: 8,
            background: open ? C.accentSoft : hovered ? C.surface2 : 'transparent',
            color: open ? C.accent : C.muted,
            cursor: 'pointer',
            fontSize: 13,
            fontFamily: 'inherit',
          },
        },
        h(IconBubble, { size: 18 }),
        wide ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '销售助手') : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /* quick lookup                                                      */
    /* ---------------------------------------------------------------- */

    function MatchCard(props) {
      const match = props.match
      const [copied, setCopied] = useState(false)
      const tone = confidenceColor(match.confidence)

      async function copy() {
        const text = match.answerEn || match.answer
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        } catch {
          setCopied(false)
        }
      }

      return h(
        'div',
        { style: s.card },
        h(
          'div',
          { style: s.cardHead },
          h(
            'div',
            { style: s.cardTitleWrap },
            h('div', { style: s.cardTitle }, match.question),
            match.questionEn ? h('div', { style: s.cardSub }, match.questionEn) : null,
          ),
          h('div', { style: { ...s.pill, ...tone } }, `${Math.round(match.confidence * 100)}%`),
        ),
        match.answer
          ? h('div', { style: s.block }, h('div', { style: s.blockLabel }, '中文要点'), h('div', { style: s.blockText }, match.answer))
          : null,
        match.answerEn
          ? h(
              'div',
              { style: s.blockEn },
              h(
                'div',
                { style: { ...s.blockLabel, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                h('span', null, '英文照读 · read aloud'),
                h(
                  'button',
                  { type: 'button', style: s.btn, onClick: copy },
                  copied ? '已复制' : '复制',
                ),
              ),
              h('div', { style: s.blockTextEn }, match.answerEn),
            )
          : null,
        h(
          'div',
          { style: s.cardFoot },
          match.product ? h('span', { style: s.chip }, match.product) : null,
          match.tags.map((tag) => h('span', { key: tag, style: s.chip }, tag)),
          h('span', { style: { ...s.chip, marginLeft: 'auto' } }, `score ${match.score}`),
        ),
      )
    }

    function QuickTab() {
      const [query, setQuery] = useState('')
      const [matches, setMatches] = useState([])
      const [meta, setMeta] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const timer = useRef(null)
      const seq = useRef(0)

      async function run(text) {
        const id = seq.current + 1
        seq.current = id
        setBusy(true)
        setError('')
        try {
          const data = await api('/qa/search', { method: 'POST', body: JSON.stringify({ query: text, limit: 6 }) })
          if (seq.current !== id) return
          setMatches(data.matches ?? [])
          setMeta({ tookMs: data.tookMs ?? 0 })
        } catch (failure) {
          if (seq.current !== id) return
          setError(failure.message)
          setMatches([])
          setMeta(null)
        } finally {
          if (seq.current === id) setBusy(false)
        }
      }

      useEffect(() => {
        const text = query.trim()
        if (timer.current !== null) window.clearTimeout(timer.current)
        if (text.length < 2) {
          seq.current += 1
          setMatches([])
          setMeta(null)
          setBusy(false)
          return undefined
        }
        timer.current = window.setTimeout(() => {
          timer.current = null
          void run(text)
        }, 220)
        return () => {
          if (timer.current !== null) {
            window.clearTimeout(timer.current)
            timer.current = null
          }
        }
      }, [query])

      return h(
        'div',
        { style: s.wrap },
        h(
          'div',
          { style: s.searchRow },
          h('input', {
            style: s.search,
            value: query,
            autoFocus: true,
            placeholder: '客户刚问了一句什么？中文或英文都行，例如「能打折吗」/「how much」',
            onChange: (event) => setQuery(event.target.value),
            spellCheck: false,
          }),
        ),
        h(
          'div',
          { style: s.hintRow },
          h('span', null, busy ? '检索中…' : meta !== null ? `${meta.tookMs} ms · ${matches.length} 条` : '输入 2 个字以上自动检索'),
          h('span', { style: { marginLeft: 'auto' } }, '命中率越高越接近客户原话'),
        ),
        error !== '' ? h('div', { ...s.banner, marginTop: 12 }, error) : null,
        matches.length === 0 && query.trim().length >= 2 && !busy && error === ''
          ? h('div', { style: { ...s.empty, marginTop: 12 } }, '没有命中。', h('br'), '把客户原话换个说法，或到「问答库」补一条。')
          : null,
        query.trim().length < 2
          ? h(
              'div',
              { style: { ...s.empty, marginTop: 12 } },
              '现场用法：客户说什么，就打什么。',
              h('br'),
              '面板给三行——客户原话、中文要点、英文照读句，照着念即可。',
            )
          : null,
        h('div', { style: { marginTop: 14 } }, matches.map((match) => h(MatchCard, { key: match.id, match }))),
      )
    }

    /* ---------------------------------------------------------------- */
    /* library                                                           */
    /* ---------------------------------------------------------------- */

    const EMPTY_FORM = { id: '', question: '', questionEn: '', answer: '', answerEn: '', product: '', tags: '' }

    function LibraryTab() {
      const [items, setItems] = useState([])
      const [filter, setFilter] = useState('')
      const [form, setForm] = useState(EMPTY_FORM)
      const [showForm, setShowForm] = useState(false)
      const [importOpen, setImportOpen] = useState(false)
      const [importText, setImportText] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')

      async function reload() {
        try {
          const data = await api('/qa')
          setItems(data.items ?? [])
        } catch (failure) {
          setError(failure.message)
        }
      }

      useEffect(() => {
        void reload()
      }, [])

      const needle = filter.trim().toLowerCase()
      const visible = needle === ''
        ? items
        : items.filter((item) =>
            `${item.question} ${item.questionEn} ${item.answer} ${item.product} ${item.tags.join(' ')}`.toLowerCase().includes(needle),
          )

      function edit(item) {
        setForm({
          id: item.id,
          question: item.question,
          questionEn: item.questionEn,
          answer: item.answer,
          answerEn: item.answerEn,
          product: item.product,
          tags: item.tags.join(', '),
        })
        setShowForm(true)
        setNotice('')
        setError('')
      }

      async function save() {
        if (form.question.trim() === '') {
          setError('「客户可能问的问题」不能为空')
          return
        }
        setBusy(true)
        setError('')
        try {
          await api('/qa/save', {
            method: 'POST',
            body: JSON.stringify({
              id: form.id || undefined,
              question: form.question,
              questionEn: form.questionEn,
              answer: form.answer,
              answerEn: form.answerEn,
              product: form.product,
              tags: form.tags.split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean),
            }),
          })
          setNotice(form.id === '' ? '已新增 1 条' : '已保存修改')
          setForm(EMPTY_FORM)
          setShowForm(false)
          await reload()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      async function remove(item) {
        if (!window.confirm(`删除「${item.question}」？`)) return
        try {
          await api('/qa/delete', { method: 'POST', body: JSON.stringify({ id: item.id }) })
          setNotice('已删除 1 条')
          await reload()
        } catch (failure) {
          setError(failure.message)
        }
      }

      async function runImport() {
        setBusy(true)
        setError('')
        try {
          const data = await api('/qa/import', { method: 'POST', body: JSON.stringify({ text: importText }) })
          setNotice(`解析 ${data.parsed} 条，新增 ${data.added} 条，跳过重复 ${data.skipped} 条`)
          setImportText('')
          setImportOpen(false)
          await reload()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      async function seed() {
        try {
          const data = await api('/qa/seed', { method: 'POST', body: '{}' })
          setNotice(`补入示例 ${data.added} 条`)
          await reload()
        } catch (failure) {
          setError(failure.message)
        }
      }

      return h(
        'div',
        { style: s.wrap },
        error !== '' ? h('div', { style: s.banner }, error) : null,
        notice !== '' ? h('div', { style: s.bannerOk }, notice) : null,
        h(
          'div',
          { style: s.row },
          h('input', {
            style: { ...s.input, flex: '1 1 280px' },
            value: filter,
            placeholder: '筛选问答库（问题、答案、标签）',
            onChange: (event) => setFilter(event.target.value),
          }),
          h('button', { type: 'button', style: s.btnPrimary, onClick: () => { setForm(EMPTY_FORM); setShowForm(!showForm); setNotice(''); setError('') } }, showForm ? '收起' : '新增一条'),
          h('button', { type: 'button', style: s.btn, onClick: () => { setImportOpen(!importOpen); setNotice(''); setError('') } }, importOpen ? '收起导入' : '批量导入'),
          h('button', { type: 'button', style: s.btn, onClick: seed }, '补示例'),
        ),

        showForm
          ? h(
              'div',
              { style: { ...s.card, marginTop: 14 } },
              h(
                'div',
                { style: s.row },
                h('div', { style: s.field }, h('div', { style: s.label }, '客户可能问的问题（中文）'), h('input', { style: s.input, value: form.question, onChange: (e) => setForm({ ...form, question: e.target.value }) })),
                h('div', { style: s.field }, h('div', { style: s.label }, '同一句的英文（可选，用于英文客户）'), h('input', { style: s.input, value: form.questionEn, onChange: (e) => setForm({ ...form, questionEn: e.target.value }) })),
              ),
              h(
                'div',
                { style: { ...s.row, marginTop: 10 } },
                h('div', { style: s.field }, h('div', { style: s.label }, '中文要点'), h('textarea', { style: s.textarea, value: form.answer, onChange: (e) => setForm({ ...form, answer: e.target.value }) })),
                h('div', { style: s.field }, h('div', { style: s.label }, '英文照读句（≤25 词最好念）'), h('textarea', { style: s.textarea, value: form.answerEn, onChange: (e) => setForm({ ...form, answerEn: e.target.value }) })),
              ),
              h(
                'div',
                { style: { ...s.row, marginTop: 10 } },
                h('div', { style: s.field }, h('div', { style: s.label }, '产品 / 主题'), h('input', { style: s.input, value: form.product, onChange: (e) => setForm({ ...form, product: e.target.value }) })),
                h('div', { style: s.field }, h('div', { style: s.label }, '标签（逗号分隔）'), h('input', { style: s.input, value: form.tags, onChange: (e) => setForm({ ...form, tags: e.target.value }) })),
                h('div', { style: { ...s.field, flex: '0 0 auto', alignSelf: 'flex-end' } }, h('button', { type: 'button', style: s.btnPrimary, disabled: busy, onClick: save }, busy ? '保存中…' : form.id === '' ? '保存新增' : '保存修改')),
              ),
            )
          : null,

        importOpen
          ? h(
              'div',
              { style: { ...s.card, marginTop: 14 } },
              h('div', { style: s.label }, '一行一条：TSV（问题<TAB>答案）、「Q: / A:」成对、或「问 | 答」。重复问题会自动跳过。'),
              h('textarea', {
                style: { ...s.textarea, minHeight: 140, marginTop: 8 },
                value: importText,
                placeholder: '标准版多少钱？\t标准版年费 ¥68,000。\nQ: 上线要多久？\nA: 标准版 2 周、专业版 4–6 周。',
                onChange: (event) => setImportText(event.target.value),
              }),
              h('div', { style: { ...s.row, marginTop: 10 } }, h('button', { type: 'button', style: s.btnPrimary, disabled: busy || importText.trim() === '', onClick: runImport }, busy ? '导入中…' : '开始导入')),
            )
          : null,

        h('div', { style: s.sectionTitle }, `问答库 · ${visible.length} 条`),
        visible.length === 0
          ? h('div', { style: s.empty }, '还没有内容。点「新增一条」，或「补示例」载入 21 条常用话术。')
          : visible.map((item) =>
              h(
                'div',
                { key: item.id, style: s.card },
                h(
                  'div',
                  { style: s.cardHead },
                  h(
                    'div',
                    { style: s.cardTitleWrap },
                    h('div', { style: s.cardTitle }, item.question),
                    item.questionEn ? h('div', { style: s.cardSub }, item.questionEn) : null,
                    h('div', { style: { ...s.cardSub, marginTop: 6, color: C.text, opacity: 0.85 } }, item.answer || '（还没有中文答案）'),
                    item.tags.length > 0 ? h('div', { style: { ...s.cardFoot, marginTop: 8 } }, item.tags.map((tag) => h('span', { key: tag, style: s.chip }, tag))) : null,
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                    h('button', { type: 'button', style: s.btn, onClick: () => edit(item) }, '编辑'),
                    h('button', { type: 'button', style: s.btnDanger, onClick: () => remove(item) }, '删除'),
                  ),
                ),
              ),
            ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* customers                                                         */
    /* ---------------------------------------------------------------- */

    const EMPTY_CUSTOMER = { id: '', name: '', company: '', language: 'zh', stage: '', budget: '', tags: '', notes: '' }

    function CustomersTab() {
      const [items, setItems] = useState([])
      const [form, setForm] = useState(EMPTY_CUSTOMER)
      const [showForm, setShowForm] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')

      async function reload() {
        try {
          const data = await api('/customers')
          setItems(data.items ?? [])
        } catch (failure) {
          setError(failure.message)
        }
      }

      useEffect(() => {
        void reload()
      }, [])

      async function save() {
        if (form.name.trim() === '') {
          setError('客户称呼不能为空')
          return
        }
        try {
          await api('/customer/save', {
            method: 'POST',
            body: JSON.stringify({
              id: form.id || undefined,
              name: form.name,
              company: form.company,
              language: form.language,
              stage: form.stage,
              budget: form.budget,
              tags: form.tags.split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean),
              notes: form.notes,
            }),
          })
          setNotice(form.id === '' ? '已新增客户' : '已保存客户')
          setForm(EMPTY_CUSTOMER)
          setShowForm(false)
          setError('')
          await reload()
        } catch (failure) {
          setError(failure.message)
        }
      }

      return h(
        'div',
        { style: s.wrap },
        error !== '' ? h('div', { style: s.banner }, error) : null,
        notice !== '' ? h('div', { style: s.bannerOk }, notice) : null,
        h(
          'div',
          { style: s.row },
          h('div', { style: { fontSize: 13, color: C.muted, flex: 1 } }, '客户档案：阶段、预算、关注点。会后用来沉淀画像。'),
          h('button', { type: 'button', style: s.btnPrimary, onClick: () => { setForm(EMPTY_CUSTOMER); setShowForm(!showForm); setNotice(''); setError('') } }, showForm ? '收起' : '新增客户'),
        ),
        showForm
          ? h(
              'div',
              { style: { ...s.card, marginTop: 14 } },
              h(
                'div',
                { style: s.row },
                h('div', { style: s.field }, h('div', { style: s.label }, '称呼'), h('input', { style: s.input, value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) })),
                h('div', { style: s.field }, h('div', { style: s.label }, '公司'), h('input', { style: s.input, value: form.company, onChange: (e) => setForm({ ...form, company: e.target.value }) })),
                h('div', { style: { ...s.field, flex: '0 0 130px' } }, h('div', { style: s.label }, '语言'), h('select', { style: s.input, value: form.language, onChange: (e) => setForm({ ...form, language: e.target.value }) }, h('option', { value: 'zh' }, '中文'), h('option', { value: 'en' }, 'English'))),
              ),
              h(
                'div',
                { style: { ...s.row, marginTop: 10 } },
                h('div', { style: s.field }, h('div', { style: s.label }, '阶段'), h('input', { style: s.input, value: form.stage, placeholder: '初访 / 需求确认 / 报价 / 谈判', onChange: (e) => setForm({ ...form, stage: e.target.value }) })),
                h('div', { style: s.field }, h('div', { style: s.label }, '意向版本 / 预算'), h('input', { style: s.input, value: form.budget, placeholder: '专业版 / ¥128,000', onChange: (e) => setForm({ ...form, budget: e.target.value }) })),
                h('div', { style: s.field }, h('div', { style: s.label }, '标签'), h('input', { style: s.input, value: form.tags, placeholder: '冷链, 3 仓', onChange: (e) => setForm({ ...form, tags: e.target.value }) })),
              ),
              h('div', { style: { ...s.field, marginTop: 10 } }, h('div', { style: s.label }, '备注 / 关注点'), h('textarea', { style: s.textarea, value: form.notes, onChange: (e) => setForm({ ...form, notes: e.target.value }) })),
              h('div', { style: { ...s.row, marginTop: 10 } }, h('button', { type: 'button', style: s.btnPrimary, onClick: save }, form.id === '' ? '保存新增' : '保存修改')),
            )
          : null,
        h('div', { style: s.sectionTitle }, `客户 · ${items.length} 位`),
        items.length === 0
          ? h('div', { style: s.empty }, '还没有客户档案。')
          : items.map((item) =>
              h(
                'div',
                { key: item.id, style: s.card },
                h(
                  'div',
                  { style: s.cardHead },
                  h(
                    'div',
                    { style: s.cardTitleWrap },
                    h('div', { style: s.cardTitle }, `${item.name}${item.company ? ` · ${item.company}` : ''}`),
                    h('div', { style: s.cardSub }, [item.stage || '未标阶段', item.budget, item.language === 'en' ? 'English' : '中文'].filter(Boolean).join(' · ')),
                    item.notes ? h('div', { style: { ...s.cardSub, marginTop: 6, color: C.text, opacity: 0.85 } }, item.notes) : null,
                    item.tags.length > 0 ? h('div', { style: { ...s.cardFoot, marginTop: 8 } }, item.tags.map((tag) => h('span', { key: tag, style: s.chip }, tag))) : null,
                  ),
                  h('button', {
                    type: 'button',
                    style: s.btn,
                    onClick: () => {
                      setForm({ ...EMPTY_CUSTOMER, ...item, tags: item.tags.join(', ') })
                      setShowForm(true)
                      setNotice('')
                      setError('')
                    },
                  }, '编辑'),
                ),
              ),
            ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* settings + roadmap                                                */
    /* ---------------------------------------------------------------- */

    function SettingsTab() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')

      useEffect(() => {
        api('/state')
          .then((data) => setState(data.state))
          .catch((failure) => setError(failure.message))
      }, [])

      async function exportAll() {
        try {
          const data = await api('/export')
          const blob = new Blob([JSON.stringify(data.db, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `sales-copilot-${new Date().toISOString().slice(0, 10)}.json`
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          window.setTimeout(() => URL.revokeObjectURL(url), 4000)
        } catch (failure) {
          setError(failure.message)
        }
      }

      return h(
        'div',
        { style: s.wrap },
        error !== '' ? h('div', { style: s.banner }, error) : null,
        h('div', { style: s.sectionTitle }, '数据'),
        state === null
          ? h('div', { style: s.empty }, '读取中…')
          : h(
              'div',
              { style: { ...s.card } },
              h(
                'div',
                { style: s.kv },
                h('div', { style: s.kvKey }, '数据目录'),
                h('div', { style: s.kvVal }, state.dataRoot),
                h('div', { style: s.kvKey }, '主体文件'),
                h('div', { style: s.kvVal }, state.file),
                h('div', { style: s.kvKey }, '问答 / 客户 / 产品'),
                h('div', { style: { ...s.kvVal, fontFamily: 'inherit' } }, `${state.qa} / ${state.customers} / ${state.products}`),
              ),
              h('div', { style: { ...s.row, marginTop: 14 } },
                h('button', { type: 'button', style: s.btnPrimary, onClick: exportAll }, '导出全部 JSON'),
                h('span', { style: { fontSize: 12, color: C.muted } }, '备份就是把这份 JSON 拷走；换机器直接放回同名目录。'),
              ),
              state.topHits.length > 0
                ? h(
                    'div',
                    { style: { marginTop: 18 } },
                    h('div', { style: s.label }, '被查最多的 8 条'),
                    state.topHits.map((item) =>
                      h('div', { key: item.id, style: { display: 'flex', gap: 10, fontSize: 13, padding: '5px 0', borderBottom: `1px solid ${C.borderSoft}` } },
                        h('span', { style: { color: C.muted, minWidth: 34 } }, `${item.hits}×`),
                        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.question),
                      ),
                    ),
                  )
                : null,
            ),
        h('div', { style: s.sectionTitle }, 'v0.2 路线'),
        h('div', { style: s.card },
          [
            ['实时通话辅助', '常驻浮层 + 双流采集（系统声音/麦克风），命中问答库给三行答案；开口即用，不占屏。'],
            ['会议室对练', '你扮客户或 AI 扮客户，多角色；角色提示词可自己写，也可让模型起草。'],
            ['AI 精答', '命中率低于阈值时，用当前 DSH 模型现场组织答案，不写回库。'],
            ['会后总结', '从转写里抽需求、异议、下一步，自动补客户画像。'],
          ].map(([title, detail]) =>
            h('div', { key: title, style: s.roadItem },
              h('div', { style: { width: 96, flexShrink: 0, fontWeight: 600 } }, title),
              h('div', { style: { flex: 1, minWidth: 0, color: C.muted } }, detail),
            ),
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* realtime tab                                                      */
    /* ---------------------------------------------------------------- */

    const LIVE = {
      bar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
      dot: (on) => ({
        width: 8,
        height: 8,
        borderRadius: 999,
        background: on ? C.success : C.borderStrong,
        boxShadow: on ? '0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary,#30a46c) 18%, transparent)' : 'none',
        flexShrink: 0,
      }),
      hint: { color: C.muted, fontSize: 12.5, lineHeight: '19px' },
      card: { border: `1px solid ${C.border}`, borderRadius: 12, padding: '10px 12px', marginBottom: 10, background: C.surface },
      heard: { fontSize: 13.5, lineHeight: '21px', color: C.muted, wordBreak: 'break-word' },
      trans: { fontSize: 15, lineHeight: '23px', marginTop: 4, wordBreak: 'break-word' },
      badge: (hit) => ({
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11.5,
        marginLeft: 6,
        color: hit ? C.success : C.muted,
        background: hit ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary,#30a46c) 12%, transparent)' : C.surface2,
      }),
      answer: { marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${C.border}` },
      en: { fontSize: 13.5, lineHeight: '21px', color: C.accent, marginTop: 4, wordBreak: 'break-word' },
      cardTitle: { fontSize: 12.5, color: C.muted, marginBottom: 2 },
      empty: { color: C.muted, fontSize: 13.5, padding: '18px 0', textAlign: 'center', lineHeight: '21px' },
      notice: {
        border: `1px solid ${C.accent}`,
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary,#3b6ef6) 8%, transparent)',
        borderRadius: 12,
        padding: '10px 12px',
        marginBottom: 12,
      },
    }

    function LiveTab(props) {
      const [rt, setRt] = useState(null)
      const [overlay, setOverlay] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const payload = await api('/rt/state', { method: 'GET' })
            if (!alive) return
            setRt(payload.rt)
            setOverlay(payload.overlay ?? null)
            setError('')
          } catch (failure) {
            if (alive) setError(failure?.message ?? String(failure))
          }
        }
        void load()
        const id = setInterval(load, 1200)
        return () => {
          alive = false
          clearInterval(id)
        }
      }, [])

      const act = async (path, body) => {
        setBusy(path)
        try {
          const payload = await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
          if (payload.rt) setRt(payload.rt)
          if (payload.overlay) setOverlay(payload.overlay)
          setError('')
        } catch (failure) {
          setError(failure?.message ?? String(failure))
        } finally {
          setBusy('')
        }
      }

      const running = rt?.running === true
      const items = Array.isArray(rt?.items) ? [...rt.items].reverse() : []

      const finishCall = async () => {
        const sessionId = typeof rt?.callEnded?.sessionId === 'string' ? rt.callEnded.sessionId : ''
        setBusy('/meeting/from-captions')
        try {
          const payload = await api('/meeting/from-captions', {
            method: 'POST',
            body: JSON.stringify(sessionId === '' ? {} : { sessionId }),
          })
          await api('/rt/ack', { method: 'POST', body: '{}' })
          if (payload.ok === false) setError(payload.error ?? '生成纪要失败')
          else if (typeof props?.onOpenRoom === 'function') props.onOpenRoom()
        } catch (failure) {
          setError(failure?.message ?? String(failure))
        } finally {
          setBusy('')
        }
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: LIVE.bar },
          h('span', { style: LIVE.dot(running) }),
          h('strong', { style: { fontSize: 13.5 } }, running ? '正在听' : '未开始'),
          rt?.captions ? h('span', { style: LIVE.hint }, `字幕状态：${rt.captions}`) : null,
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              style: running ? s.btn : s.btnPrimary,
              disabled: busy !== '',
              onClick: () => act(running ? '/rt/stop' : '/rt/start'),
            },
            running ? '停止' : '开始听',
          ),
          h(
            'button',
            {
              type: 'button',
              style: rt?.aiAssist ? s.btnPrimary : s.btn,
              disabled: busy !== '',
              title: '命中问答后，再让模型给一句更贴合的英文',
              onClick: () => act('/rt/ai', { enabled: rt?.aiAssist !== true }),
            },
            rt?.aiAssist ? 'AI 精确回答：开' : 'AI 精确回答：关',
          ),
          h(
            'button',
            {
              type: 'button',
              style: overlay?.open ? s.btnPrimary : s.btn,
              disabled: busy !== '' || overlay?.supported === false,
              title:
                overlay?.supported === false
                  ? '当前系统不支持系统置顶窗口'
                  : '开一个始终置顶的小卡片，Zoom/Teams/微信挡住 DSH 时也能看答案',
              onClick: () => act(overlay?.open ? '/overlay/close' : '/overlay/open'),
            },
            overlay?.open ? '收起浮层' : '置顶浮层',
          ),
        ),
        h(
          'div',
          { style: LIVE.hint },
          rt?.lastError
            ? `⚠️ ${rt.lastError}`
            : running
              ? '听系统声音和麦克风（依赖 dsh-live-captions）。每说完一句，这里出现一张卡片：客户原话 → 中文要点 → 照着念的英文。'
              : '点「开始听」后，把客户的声音放出来（会议 / 通话 / 现场），这里会逐句出卡片。',
        ),
        error !== '' ? h('div', { style: { ...LIVE.hint, color: C.danger, marginTop: 6 } }, error) : null,
        overlay?.failure
          ? h('div', { style: { ...LIVE.hint, color: C.danger, marginTop: 6 } }, `浮层：${overlay.failure}`)
          : null,
        rt?.callEnded
          ? h(
              'div',
              { style: LIVE.notice },
              h('div', { style: { fontSize: 13.5, marginBottom: 8 } }, `这段通话结束了 · 共 ${rt.callEnded.entries} 句，要生成纪要吗？`),
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h(
                  'button',
                  { type: 'button', style: s.btnPrimary, disabled: busy !== '', onClick: finishCall },
                  busy === '/meeting/from-captions' ? '生成中…' : '生成纪要并写画像',
                ),
                h('button', { type: 'button', style: s.btn, disabled: busy !== '', onClick: () => act('/rt/ack') }, '先不要'),
              ),
            )
          : null,
        h('div', { style: { height: 12 } }),
        items.length === 0
          ? h('div', { style: LIVE.empty }, running ? '在听，等客户说话…' : '还没有内容')
          : items.map((item) =>
              h(
                'div',
                { key: `rt-${item.seq}`, style: LIVE.card },
                h('div', { style: LIVE.heard }, item.heard),
                item.translation ? h('div', { style: LIVE.trans }, item.translation) : null,
                h(
                  'div',
                  { style: { marginTop: 6 } },
                  h('span', { style: { fontSize: 12.5, color: C.muted } }, item.matched ? '问答库命中' : '问答库未命中'),
                  h('span', { style: LIVE.badge(item.matched) }, item.matched ? `${Math.round((item.faq?.confidence ?? 0) * 100)}%` : '—'),
                  item.faq ? h('span', { style: { ...LIVE.hint, marginLeft: 8 } }, item.faq.question) : null,
                ),
                item.faq
                  ? h(
                      'div',
                      { style: LIVE.answer },
                      h('div', { style: LIVE.cardTitle }, '中文要点'),
                      h('div', { style: { fontSize: 14, lineHeight: '22px' } }, item.faq.zh),
                      h('div', { style: { ...LIVE.cardTitle, marginTop: 8 } }, '照着念（英文）'),
                      h('div', { style: LIVE.en }, item.faq.en),
                    )
                  : null,
                item.ai
                  ? h(
                      'div',
                      { style: LIVE.answer },
                      h('div', { style: LIVE.cardTitle }, 'AI 精确回答'),
                      h('div', { style: { fontSize: 14, lineHeight: '22px' } }, item.ai.zh),
                      h('div', { style: LIVE.en }, item.ai.en),
                    )
                  : item.aiState === 'pending'
                    ? h('div', { style: { ...LIVE.hint, marginTop: 8 } }, 'AI 正在想…')
                    : null,
              ),
            ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* meeting room tab                                                  */
    /* ---------------------------------------------------------------- */

    const ROOM = {
      section: { border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 12, background: C.surface },
      sectionTitle: { fontSize: 13, fontWeight: 600, marginBottom: 8 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 },
      chip: (active) => ({
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: 12.5,
        cursor: 'pointer',
        border: `1px solid ${active ? C.accent : C.border}`,
        background: active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary,#3b6ef6) 12%, transparent)' : C.surface,
        color: active ? C.accent : C.text,
      }),
      msgs: { maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' },
      msg: (speaker) => ({
        alignSelf: speaker === 'sales' ? 'flex-end' : 'flex-start',
        maxWidth: '86%',
        padding: '8px 11px',
        borderRadius: 12,
        fontSize: 13.5,
        lineHeight: '21px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        background: speaker === 'sales' ? 'color-mix(in srgb, var(--dsw-alias-brand-primary,#3b6ef6) 14%, transparent)' : C.surface2,
        border: `1px solid ${C.borderSoft}`,
      }),
      msgName: { fontSize: 11.5, color: C.muted, marginBottom: 2 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 32,
        padding: '7px 10px',
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        background: C.surface,
        color: C.text,
        fontSize: 13.5,
        lineHeight: '20px',
        fontFamily: 'inherit',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 64,
        resize: 'vertical',
        padding: '8px 10px',
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        background: C.surface,
        color: C.text,
        fontSize: 13.5,
        lineHeight: '20px',
        fontFamily: 'inherit',
      },
    }

    function RoomTab() {
      const [roles, setRoles] = useState([])
      const [customers, setCustomers] = useState([])
      const [meetings, setMeetings] = useState([])
      const [meeting, setMeeting] = useState(null)
      const [selected, setSelected] = useState([])
      const [mode, setMode] = useState('ai-customer')
      const [customerId, setCustomerId] = useState('')
      const [title, setTitle] = useState('')
      const [brief, setBrief] = useState('')
      const [draft, setDraft] = useState('')
      const [speaker, setSpeaker] = useState('sales')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [sessions, setSessions] = useState([])
      const [sessionId, setSessionId] = useState('')
      const [autoSpeak, setAutoSpeak] = useState(true)
      const [speakBusy, setSpeakBusy] = useState(false)
      const [voiceBusy, setVoiceBusy] = useState(false)

      const loadLists = async () => {
        try {
          const [rolePayload, customerPayload, meetingPayload] = await Promise.all([
            api('/roles', { method: 'GET' }),
            api('/customers', { method: 'GET' }),
            api('/meetings', { method: 'GET' }),
          ])
          setRoles(rolePayload.items ?? [])
          setCustomers(customerPayload.items ?? [])
          setMeetings(meetingPayload.items ?? [])
          setError('')
        } catch (failure) {
          setError(failure?.message ?? String(failure))
        }
      }

      useEffect(() => {
        void loadLists()
      }, [])

      const run = async (label, fn) => {
        setBusy(label)
        try {
          await fn()
          setError('')
        } catch (failure) {
          setError(failure?.message ?? String(failure))
        } finally {
          setBusy('')
        }
      }

      const suggest = () =>
        run('suggest', async () => {
          await api('/role/suggest', { method: 'POST', body: JSON.stringify({ brief, count: 2, language: 'auto' }) })
          setBrief('')
          await loadLists()
        })

      const createMeeting = () =>
        run('create', async () => {
          const payload = await api('/meeting/create', {
            method: 'POST',
            body: JSON.stringify({ title, mode, customerId, roleIds: selected }),
          })
          setMeeting(payload.meeting)
          setTitle('')
          await loadLists()
        })

      const openMeeting = (id) =>
        run('open', async () => {
          const payload = await api(`/meeting?id=${encodeURIComponent(id)}`, { method: 'GET' })
          setMeeting(payload.meeting)
        })

      const send = () =>
        run('send', async () => {
          const text = draft.trim()
          if (text === '' || meeting === null) return
          const payload = await api('/meeting/message', {
            method: 'POST',
            body: JSON.stringify({ id: meeting.id, speaker, text }),
          })
          setMeeting(payload.meeting)
          setDraft('')
        })

      const speakText = async (text) => {
        const line = String(text ?? '').trim()
        if (line === '') return
        setSpeakBusy(true)
        try {
          await api('/tts/speak', { method: 'POST', body: JSON.stringify({ text: line.slice(0, 600) }) })
          setError('')
        } catch (failure) {
          setError(failure?.message ?? String(failure))
        } finally {
          setSpeakBusy(false)
        }
      }

      const voiceTurn = async () => {
        if (meeting === null) return
        setVoiceBusy(true)
        try {
          const payload = await api('/meeting/voice-turn', { method: 'POST', body: JSON.stringify({ id: meeting.id }) })
          setMeeting(payload.meeting)
          setError('')
        } catch (failure) {
          setError(failure?.message ?? String(failure))
        } finally {
          setVoiceBusy(false)
        }
      }

      const loadSessions = () =>
        run('sessions', async () => {
          const payload = await api('/captions/sessions', { method: 'GET' })
          const items = payload.sessions ?? []
          setSessions(items)
          setSessionId(items[0]?.id ?? '')
        })

      const importCall = () =>
        run('import', async () => {
          if (sessionId === '') return
          const payload = await api('/meeting/from-captions', { method: 'POST', body: JSON.stringify({ sessionId }) })
          setMeeting(payload.meeting)
          await loadLists()
        })

      const turn = () =>
        run('turn', async () => {
          if (meeting === null) return
          const payload = await api('/meeting/turn', { method: 'POST', body: JSON.stringify({ id: meeting.id }) })
          setMeeting(payload.meeting)
          if (autoSpeak) void speakText(payload.message?.text)
        })

      const summarize = () =>
        run('summary', async () => {
          if (meeting === null) return
          const payload = await api('/meeting/summary', { method: 'POST', body: JSON.stringify({ id: meeting.id, applyProfile: true }) })
          setMeeting(payload.meeting)
          await loadLists()
        })

      const removeRole = (id) =>
        run('role', async () => {
          await api('/role/delete', { method: 'POST', body: JSON.stringify({ id }) })
          setSelected((current) => current.filter((item) => item !== id))
          await loadLists()
        })

      if (meeting !== null) {
        const messages = meeting.messages ?? []
        const summary = meeting.summary
        return h(
          'div',
          null,
          h(
            'div',
            { style: ROOM.row },
            h('button', { type: 'button', style: s.btn, onClick: () => setMeeting(null) }, '← 返回列表'),
            h('strong', { style: { fontSize: 13.5 } }, meeting.title),
            h('span', { style: LIVE.hint }, meeting.mode === 'ai-customer' ? 'AI 扮演客户' : meeting.mode === 'call-import' ? '通话记录' : '你扮演客户'),
            h('span', { style: { flex: 1 } }),
            h(
              'button',
              {
                type: 'button',
                style: s.btn,
                disabled: speakBusy,
                title: '用这台电脑的语音把客户最后一句话念出来，方便跟读',
                onClick: () => {
                  const lastCustomer = [...messages].reverse().find((item) => item.speaker === 'customer')
                  void speakText(lastCustomer?.text ?? '')
                },
              },
              speakBusy ? '朗读中…' : '朗读客户台词',
            ),
            h(
              'button',
              { type: 'button', style: autoSpeak ? s.btnPrimary : s.btn, onClick: () => setAutoSpeak((value) => !value) },
              autoSpeak ? '自动朗读：开' : '自动朗读：关',
            ),
            h('button', { type: 'button', style: s.btnPrimary, disabled: busy !== '', onClick: turn }, busy === 'turn' ? '客户想说…' : '客户接着说'),
            h(
              'button',
              { type: 'button', style: s.btn, disabled: voiceBusy || busy !== '', title: '用麦克风说一句英文，识别后作为你的回答', onClick: voiceTurn },
              voiceBusy ? '听你说…' : '语音回答',
            ),
            h('button', { type: 'button', style: s.btn, disabled: busy !== '', onClick: summarize }, busy === 'summary' ? '总结中…' : '总结并写入画像'),
          ),
          h(
            'div',
            { style: ROOM.msgs },
            messages.length === 0 ? h('div', { style: LIVE.empty }, '还没有对话，先说一句，或者点「客户接着说」') : null,
            messages.map((message) =>
              h(
                'div',
                { key: message.id, style: ROOM.msg(message.speaker) },
                h('div', { style: ROOM.msgName }, `${message.speaker === 'sales' ? '我（销售）' : message.name || '客户'} · ${String(message.at).slice(11, 16)}`),
                message.text,
              ),
            ),
          ),
          summary
            ? h(
                'div',
                { style: { ...ROOM.section, marginTop: 12 } },
                h('div', { style: ROOM.sectionTitle }, '会议总结'),
                h('div', { style: { fontSize: 13.5, lineHeight: '22px' } }, summary.summary),
                (summary.needs ?? []).length > 0 ? h('div', { style: { ...LIVE.hint, marginTop: 8 } }, `客户需求：${summary.needs.join('；')}`) : null,
                (summary.nextSteps ?? []).length > 0 ? h('div', { style: { ...LIVE.hint, marginTop: 4 } }, `下一步：${summary.nextSteps.join('；')}`) : null,
                summary.profile?.stage || summary.profile?.budget
                  ? h('div', { style: { ...LIVE.hint, marginTop: 4 } }, `画像更新：${[summary.profile.stage, summary.profile.budget].filter(Boolean).join(' · ')}`)
                  : null,
              )
            : null,
          h(
            'div',
            { style: { ...ROOM.section, marginTop: 12 } },
            h(
              'div',
              { style: ROOM.row },
              h('button', { type: 'button', style: speaker === 'sales' ? s.btnPrimary : s.btn, onClick: () => setSpeaker('sales') }, '我演销售'),
              h('button', { type: 'button', style: speaker === 'customer' ? s.btnPrimary : s.btn, onClick: () => setSpeaker('customer') }, '我演客户'),
              h('span', { style: { flex: 1 } }),
              h('button', { type: 'button', style: s.btnPrimary, disabled: busy !== '', onClick: send }, busy === 'send' ? '发送中…' : '发送'),
            ),
            h('textarea', {
              style: ROOM.textarea,
              value: draft,
              placeholder: speaker === 'sales' ? '你说的话（中文英文都行）…' : '你替客户说话（练习用）…',
              onChange: (event) => setDraft(event.target.value),
            }),
          ),
          error !== '' ? h('div', { style: { ...LIVE.hint, color: C.danger, marginTop: 6 } }, error) : null,
        )
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: ROOM.section },
          h('div', { style: ROOM.sectionTitle }, '① 选角色（客户由谁扮演）'),
          roles.length === 0 ? h('div', { style: LIVE.hint }, '还没有角色，下面用 AI 生成两个') : null,
          h(
            'div',
            { style: ROOM.row },
            roles.map((role) =>
              h(
                'span',
                {
                  key: role.id,
                  style: ROOM.chip(selected.includes(role.id)),
                  onClick: () =>
                    setSelected((current) => (current.includes(role.id) ? current.filter((item) => item !== role.id) : [...current, role.id])),
                },
                role.name,
                h(
                  'span',
                  {
                    style: { marginLeft: 6, opacity: 0.6, cursor: 'pointer' },
                    onClick: (event) => {
                      event.stopPropagation()
                      void removeRole(role.id)
                    },
                  },
                  '✕',
                ),
              ),
            ),
          ),
          h(
            'div',
            { style: ROOM.row },
            h('input', {
              style: { ...ROOM.input, flex: 1 },
              value: brief,
              placeholder: '角色背景（可留空，例如：德国汽配采购、东南亚电商）',
              onChange: (event) => setBrief(event.target.value),
            }),
            h('button', { type: 'button', style: s.btnPrimary, disabled: busy !== '', onClick: suggest }, busy === 'suggest' ? 'AI 生成中…' : 'AI 生成角色'),
          ),
        ),
        h(
          'div',
          { style: ROOM.section },
          h('div', { style: ROOM.sectionTitle }, '② 开始一场对练'),
          h(
            'div',
            { style: ROOM.row },
            h('input', {
              style: { ...ROOM.input, flex: 1 },
              value: title,
              placeholder: '这场对练叫什么（可留空）',
              onChange: (event) => setTitle(event.target.value),
            }),
            h(
              'select',
              {
                style: { ...ROOM.input, width: 148, flex: '0 0 auto' },
                value: mode,
                onChange: (event) => setMode(event.target.value),
              },
              h('option', { value: 'ai-customer' }, 'AI 扮演客户'),
              h('option', { value: 'user-customer' }, '我扮演客户'),
            ),
            h(
              'select',
              {
                style: { ...ROOM.input, width: 148, flex: '0 0 auto' },
                value: customerId,
                onChange: (event) => setCustomerId(event.target.value),
              },
              h('option', { value: '' }, '不关联客户'),
              customers.map((customer) => h('option', { key: customer.id, value: customer.id }, customer.name)),
            ),
            h('button', { type: 'button', style: s.btnPrimary, disabled: busy !== '', onClick: createMeeting }, busy === 'create' ? '创建中…' : '开始'),
          ),
          h('div', { style: LIVE.hint }, '对练结束后点「总结并写入画像」，客户的需求、预算、阶段会自动补进客户档案。'),
        ),
        h(
          'div',
          { style: ROOM.section },
          h('div', { style: ROOM.sectionTitle }, '③ 从通话记录生成纪要'),
          h('div', { style: LIVE.hint }, '把刚才和客户视频或电话的字幕（dsh-live-captions 存下的记录）导进来，自动总结需求并写进客户画像。'),
          h(
            'div',
            { style: ROOM.row, marginTop: 8 },
            h('button', { type: 'button', style: s.btn, disabled: busy !== '', onClick: loadSessions }, busy === 'sessions' ? '读取中…' : '读取通话记录'),
            sessions.length === 0
              ? null
              : h(
                  'select',
                  {
                    style: { ...ROOM.input, flex: 1 },
                    value: sessionId,
                    onChange: (event) => setSessionId(event.target.value),
                  },
                  sessions.map((session) =>
                    h(
                      'option',
                      { key: session.id, value: session.id },
                      `${String(session.id).slice(0, 17)} · ${session.entries ?? 0} 句 · ${Math.round((session.durationMs ?? 0) / 1000)} 秒`,
                    ),
                  ),
                ),
            sessions.length === 0
              ? null
              : h('button', { type: 'button', style: s.btnPrimary, disabled: busy !== '', onClick: importCall }, busy === 'import' ? '导入并总结…' : '导入并总结'),
          ),
        ),
        h(
          'div',
          { style: ROOM.section },
          h('div', { style: ROOM.sectionTitle }, '④ 历史对练'),
          meetings.length === 0
            ? h('div', { style: LIVE.hint }, '还没有对练记录')
            : meetings.map((item) =>
                h(
                  'div',
                  { key: item.id, style: { ...ROOM.row, marginBottom: 4 } },
                  h('span', { style: { flex: 1, fontSize: 13.5 } }, `${item.title}（${item.messages} 句${item.summarized ? ' · 已总结' : ''}）`),
                  h('button', { type: 'button', style: s.btn, onClick: () => openMeeting(item.id) }, '打开'),
                ),
              ),
        ),
        error !== '' ? h('div', { style: { ...LIVE.hint, color: C.danger, marginTop: 6 } }, error) : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /* panel shell                                                       */
    /* ---------------------------------------------------------------- */

    const TABS = [
      ['quick', '快查'],
      ['live', '实时'],
      ['room', '对练'],
      ['library', '问答库'],
      ['customers', '客户'],
      ['settings', '设置'],
    ]

    const PANEL_MIN_WIDTH = 360
    const PANEL_MAX_WIDTH = 1200
    const PANEL_WIDTH_KEY = 'sales-copilot.panelWidth'

    function clampPanelWidth(value) {
      const available = Math.max(PANEL_MIN_WIDTH, window.innerWidth - 28)
      return Math.max(PANEL_MIN_WIDTH, Math.min(Math.round(value), Math.min(PANEL_MAX_WIDTH, available)))
    }

    function storedPanelWidth() {
      try {
        const value = Number(window.localStorage.getItem(PANEL_WIDTH_KEY))
        return Number.isFinite(value) && value >= PANEL_MIN_WIDTH ? clampPanelWidth(value) : 0
      } catch {
        return 0
      }
    }

    function defaultPanelWidth(wide) {
      return clampPanelWidth(wide ? 720 : 460)
    }

    function Panel(props) {
      const open = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
      const [tab, setTab] = useState(props.initialTab || 'quick')
      const [width, setWidth] = useState(storedPanelWidth)
      const [resizing, setResizing] = useState(false)
      const drag = useRef(null)

      useEffect(
        () => () => {
          if (drag.current !== null) {
            window.removeEventListener('pointermove', drag.current.move)
            window.removeEventListener('pointerup', drag.current.up)
          }
        },
        [],
      )

      // Keep the panel inside the viewport when the window is resized.
      useEffect(() => {
        if (!open) return undefined
        const onResize = () => setWidth((value) => (value > 0 ? clampPanelWidth(value) : 0))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [open])

      const beginResize = (event) => {
        if (event.button !== undefined && event.button !== 0) return
        event.preventDefault()
        const startX = event.clientX
        const box = event.currentTarget.parentElement?.getBoundingClientRect()
        const startWidth = box ? box.width : defaultPanelWidth(true)
        let latest = startWidth
        const move = (moveEvent) => {
          latest = clampPanelWidth(startWidth + (startX - moveEvent.clientX))
          setWidth(latest)
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          drag.current = null
          setResizing(false)
          try {
            window.localStorage.setItem(PANEL_WIDTH_KEY, String(latest))
          } catch {
            /* 隐私模式下写不进去，这次会话照常可拖 */
          }
        }
        drag.current = { move, up }
        setResizing(true)
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      const resetWidth = () => {
        setWidth(0)
        try {
          window.localStorage.removeItem(PANEL_WIDTH_KEY)
        } catch {
          /* ignore */
        }
      }

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') props.store.close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, props.store])

      if (!open) return null

      const wide = tab === 'live' || tab === 'room' || tab === 'library'
      const panelWidth = width > 0 ? clampPanelWidth(width) : defaultPanelWidth(wide)

      return h(
        'div',
        { style: { ...s.panel, width: `${panelWidth}px` }, role: 'dialog', 'aria-label': '销售助手' },
        h('div', {
          style: s.grip(resizing),
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '拖动调整面板宽度，双击恢复默认',
          title: '拖动调整宽度 · 双击恢复默认',
          onPointerDown: beginResize,
          onDoubleClick: resetWidth,
        }),
        h(
          'div',
          { style: s.header },
          h('div', { style: { color: C.accent, flexShrink: 0 } }, h(IconBubble, { size: 20 })),
          h(
            'div',
            { style: { ...s.brand, flexShrink: 0 } },
            h('div', { style: s.brandTitle, title: '中英双语 · 客户说什么就打什么' }, '销售助手'),
          ),
          h(
            'div',
            { style: s.tabs, role: 'tablist' },
            TABS.map(([id, label]) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tab === id,
                  style: tab === id ? { ...s.tab, ...s.tabActive } : s.tab,
                  onClick: () => setTab(id),
                },
                label,
              ),
            ),
          ),
          h('button', { type: 'button', style: s.close, title: '关闭 (Esc)', 'aria-label': '关闭', onClick: () => props.store.close() }, '✕'),
        ),
        h(
          'div',
          { style: s.main },
          tab === 'quick' ? h(QuickTab) : null,
          tab === 'live' ? h(LiveTab, { onOpenRoom: () => setTab('room') }) : null,
          tab === 'room' ? h(RoomTab) : null,
          tab === 'library' ? h(LibraryTab) : null,
          tab === 'customers' ? h(CustomersTab) : null,
          tab === 'settings' ? h(SettingsTab) : null,
        ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* plugin entry                                                      */
    /* ---------------------------------------------------------------- */

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      const store = createPanelStore()

      slots.inject('sidebar.footer.action', () =>
        slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'sales-copilot',
            order: 12,
            label: () => '销售助手',
            inject: () => ({ store }),
          },
          SidebarAction,
        ),
      )

      slots.inject('shell.overlay', () =>
        slots.register(
          {
            name: 'shell.overlay',
            id: 'sales-copilot',
            order: 12,
            inject: () => ({ store }),
          },
          Panel,
        ),
      )
    }

    return { inject, apply }
  },
})
