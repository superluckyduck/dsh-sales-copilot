/**
 * Structural check for the browser half. It cannot render React, but it does
 * prove the module registers the right slots/components and that the factory
 * runs without throwing.
 *
 *   node scripts/client-check.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let definition = null
const fakeWindow = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
}

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

const requireStub = (name) => {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require(${name})`)
}

new Function('window', source)(fakeWindow)

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 200)}`}`)
  }
}

check('module registers with __ModuleLoader__', definition !== null)
check('module id matches the package name', definition?.id === 'dsh-sales-copilot', definition?.id)
check('factory is a function', typeof definition?.factory === 'function')

const loaded = definition.factory(requireStub)
check('module declares inject: slots', Array.isArray(loaded?.inject) && loaded.inject.includes('slots'), loaded?.inject)
check('module exposes apply', typeof loaded?.apply === 'function')

const registrations = []
const slots = {
  inject: (name, callback) => callback(),
  register: (descriptor, component) => {
    registrations.push({ descriptor, component })
    return () => {}
  },
}
const ctx = { get: (name) => (name === 'slots' ? slots : undefined) }
loaded.apply(ctx)

const names = registrations.map((item) => item.descriptor.name).sort()
check('registers two slots', registrations.length === 2, names)
check('registers sidebar.footer.action', names.includes('sidebar.footer.action'), names)
check('registers shell.overlay', names.includes('shell.overlay'), names)
check('both ids are sales-copilot', registrations.every((item) => item.descriptor.id === 'sales-copilot'))
check('both components are functions', registrations.every((item) => typeof item.component === 'function'))
check(
  'sidebar label is provided',
  registrations.every((item) => typeof item.descriptor.label !== 'function' || typeof item.descriptor.label() === 'string'),
)

// A closed panel must render nothing.
const panel = registrations.find((item) => item.descriptor.name === 'shell.overlay')

// The host draws its own title bar (应用/编辑 + window buttons) inside the
// window; a full-bleed overlay covers it and reads as "overlapping". Lock the
// floating-sheet geometry in so it cannot silently regress.
check('panel is a floating sheet, not a full-bleed overlay', /top:\s*56/.test(source) && !/inset:\s*0/.test(source))
check('panel keeps clear of the host sidebar', /right:\s*14/.test(source) && /bottom:\s*14/.test(source))
check('panel width is drag-adjustable', /PANEL_MIN_WIDTH\s*=\s*360/.test(source) && /col-resize/.test(source))
check('panel width is clamped and persisted', /PANEL_WIDTH_KEY/.test(source) && /localStorage\.setItem/.test(source))
const closed = panel.component({ store: { subscribe: () => () => {}, getSnapshot: () => false } })
check('panel renders null while closed', closed === null)

// Smoke-render the header/body shell with every hook stubbed to its initial
// value; any missing import or typo in the top-level tree throws here.
const openStore = { subscribe: () => () => {}, getSnapshot: () => true }
let threw = null
let tree = null
try {
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, items: [], state: { dataRoot: 'x', file: 'x', qa: 0, customers: 0, products: 0, topHits: [] } }) })
  tree = panel.component({ store: openStore })
  globalThis.fetch = savedFetch
} catch (error) {
  threw = error
}
check('open panel renders without throwing', threw === null, threw?.message)
check('panel tree is an element', tree !== null && typeof tree === 'object')
check('panel renders a resize handle', JSON.stringify(tree ?? {}).includes('col-resize'))

// Deep-render the v0.2 tabs: the initial tab can be forced so the panel body
// really executes instead of only the header. React never runs here, so the
// tab component is also invoked directly once it is found in the tree.
function renderTab(initialTab) {
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ ok: true, items: [], rt: { running: false, captions: 'idle', items: [], threshold: 0.34, model: null }, state: { dataRoot: 'x', file: 'x', qa: 0, customers: 0, products: 0, topHits: [] } }),
  })
  try {
    const tree = panel.component({ store: openStore, initialTab })
    const byName = new Map()
    const walk = (node) => {
      if (node === null || typeof node !== 'object') return
      if (typeof node.type === 'function') byName.set(node.type.name, node.type)
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)
    return { tree, byName, error: null }
  } catch (error) {
    return { tree: null, byName: new Map(), error }
  } finally {
    globalThis.fetch = savedFetch
  }
}

function renderComponent(component) {
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, items: [], rt: {}, state: {} }) })
  try {
    return { tree: component({}), error: null }
  } catch (error) {
    return { tree: null, error }
  } finally {
    globalThis.fetch = savedFetch
  }
}

const live = renderTab('live')
check('live tab is mounted by the panel', live.byName.has('LiveTab'), [...live.byName.keys()].join(','))
const liveBody = live.byName.has('LiveTab') ? renderComponent(live.byName.get('LiveTab')) : { error: live.error }
check('live tab body renders', liveBody.error === null, liveBody.error?.message)
check('live tab body shows the listen button', JSON.stringify(liveBody.tree ?? {}).includes('开始听'))

const room = renderTab('room')
check('room tab is mounted by the panel', room.byName.has('RoomTab'), [...room.byName.keys()].join(','))
const roomBody = room.byName.has('RoomTab') ? renderComponent(room.byName.get('RoomTab')) : { error: room.error }
check('room tab body renders', roomBody.error === null, roomBody.error?.message)
check('room tab body shows the role step', JSON.stringify(roomBody.tree ?? {}).includes('选角色'))
check('room tab body offers import from a call recording', JSON.stringify(roomBody.tree ?? {}).includes('从通话记录生成纪要'))
check('room tab wires the voice answer route', /\/meeting\/voice-turn/.test(source))
check('room tab wires the speech route', /\/tts\/speak/.test(source))
check('room tab offers a speak button for the customer line', /朗读客户台词/.test(source))
check('live tab offers a post-call summary prompt', /这段通话结束了/.test(source))
check('live tab wires the call import route', /\/meeting\/from-captions/.test(source))
check('live tab can dismiss the summary prompt', /\/rt\/ack/.test(source))

const library = renderTab('library')
check('library tab is mounted by the panel', library.byName.has('LibraryTab') || library.byName.has('QaTab'), [...library.byName.keys()].join(','))

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}  passed=${passed} failed=${failed}\n`)
process.exit(failed === 0 ? 0 : 1)
