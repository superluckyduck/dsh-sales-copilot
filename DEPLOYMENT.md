# Sales Copilot deployment notes

Repository: <https://github.com/superluckyduck/dsh-sales-copilot>
Local clone: `D:\APPS\project\dsh-project\dsh-sales-copilot`
Profile: `C:\Users\86135\.dsh\profiles\desktop`

## One-click install

Installing only `dsh-sales-copilot` activates the sales plugin, the live-captions
host plugin **and its browser panel**, plus the speech-recognition rows:
`cordis.patch.yml` inserts four rows and the live-captions package ships complete
(host + client) at `node_modules/dsh-live-captions`, addressed by its package name
so DSH discovers `./client`.

The vendored copy has to sit under `node_modules` so the bare specifier resolves
and the package name matches the row; `.gitignore` keeps the rest of
`node_modules` out of git while tracking that package.

## Captions UI restored

A earlier revision vendored only the host half, which removed the caption
capsule/panel and with it three choices the user needs:

| Choice | Where it lives now |
|---|---|
| Translation upstream | Caption panel → 更多设置 → 翻译引擎 (云端 `provider·model` / 内置离线模型 / 本地 OpenAI 兼容服务) |
| Audio source | Caption panel → 音频来源 (系统声音 + 麦克风 / 仅系统声音 / 仅麦克风) |
| Output format | Caption panel → 翻译字幕开关、目标语言、字幕桌面浮层、原文显示、字号/透明度 |

Sales Copilot no longer overwrites those settings on every boot. It only seeds
the free translation bridge once, and only while
`~/.dsh/live-captions/settings.json` does not exist, so any choice made in the
panel persists.

## Speech-service ownership

Only one plugin may register `speechToText`. This bundle therefore never adds
its own copy: it configures the stock rows shipped by the "Voice input" bundle
(`speech-to-text` → `defaultProvider: sensevoice-local`, and
`speech-to-text-sensevoice` → data dir/threads/segment length). One registration
in every state, so dictation keeps working and no install shows duplicate-service
failures.

Two designs were rejected after testing:

- Inserting our own `speech-to-text` rows: whichever side mounted second failed
  with `service "speechToText" has been registered`, and a remove/install cycle
  could leave *no* provider at all (`语音识别服务未加载`) because the old instance
  still held the service during hot reload.
- Disabling the other bundle's rows with `disabled: true` (or a `!!js`
  expression): the expression on `disabled` did not take effect, and the literal
  disable removed the only provider when our rows lost the race.

## Verified 2026-11-28

- `install_bundle` of this directory alone: `application: applied`, `warnings: []`.
- `GET /live-captions/api/state`: `asr=standby`, provider `sensevoice-local`
  (SenseVoiceSmall INT8), engine `local`/`free-google-microsoft`,
  `source=both`, `targetLanguage=zh`, `lyricShowSource=true`, `lyricVisible=true`.
- Live run: `POST /live-captions/api/command {action:'start'}` → `status=running`,
  `asr=ready`, session created, overlay window started, capture `both`; stopped again.
- Vendored package exports `./client` and declares `dsh.client` with
  `inject: [@deepseek-ai/dsh-client-ui-conversation, @deepseek-ai/dsh-api-session-controller]`.
- Tests: selftest 34/34, integration 84/84, client-check 33/33.

## Not verified

- No browser control in this session, so the rendered caption capsule and panel
  were not observed. Refresh the DSH page and confirm: the caption capsule under
  the composer, 音频来源 with three options, and 翻译引擎 with cloud/offline/local.

## Requirements

- The stock "Voice input" bundle must stay selected: it supplies the speech
  service the captions consume. If it is turned off, captions report
  `语音识别服务未加载` until it is re-enabled.

## Overlay close fix (2026-11-28)

Root causes for 「收起浮层」 not working:
1. The overlay is a separate PowerShell/WPF process. After a DSH restart the
   plugin's in-memory `child` handle was lost while the old window survived as
   an orphan; close only killed the stale handle.
2. `overlay.ps1` was UTF-8 without BOM; Windows PowerShell 5.1 read it as GBK,
   mangling the Chinese UI strings into a parse error so the window never opened
   (`failure` showed mojibake).
3. During quick disable/enable cycles POST briefly returned 405 (half-active
   plugin), so the button click failed silently.

Fixes in `lib/overlay.js` / `native/overlay.ps1`:
- The window writes its own PID to `<DSH_HOME>/sales-copilot/overlay.pid` on
  start and deletes it on close. `state()` uses that PID file as the source of
  truth (correct across restarts); `close()` kills exactly that PID and removes
  the file — no in-memory-only handle, no wildcard process matching.
- Launch via `-EncodedCommand` (UTF-16LE) instead of `-File`, eliminating the
  BOM/GBK problem entirely: variables are injected and the original `param()`
  block stripped before encoding.
- A `closing` flag stops intentional kills (nonzero exit / CLIXML stderr) from
  being recorded as a failure.
- The panel's `act()` stamps `actAt` and suppresses `/rt/state` polling for 1.5s
  so a stale GET cannot flip 「收起浮层」 back to 「置顶浮层」.

Verified after a clean remove+install: `open` → window alive + PID file written;
`close` → process gone + PID file removed + `state {open:false, failure:null}`.
Tests 34/84/33 all pass. A global Ctrl+Alt+Q hotkey also closes the overlay even
when locked (click-through).
