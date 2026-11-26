# 销售助手 · Sales Copilot（v0.3）

一个面向**中英双语销售**的 DSH 插件：客户说一句话（中文或英文），面板立刻给出
「客户原话 / 中文要点 / 英文照读句」，并标出命中率；还能开会议室跟 AI 扮的客户对练，
练完自动总结、把需求写回客户画像。

## 这一版有什么

| 能力 | 状态 |
|---|---|
| 高频问答库（新增 / 编辑 / 删除 / 批量导入 / 一键示例） | ✅ |
| 客户档案（阶段、预算、标签、备注） | ✅ |
| 产品价格表（标准版 / 专业版 / 旗舰版） | ✅ |
| 关键词检索（BM25 + 中文二元组 + 英文词），显示命中率 | ✅ |
| 侧边栏入口 + 浮动面板（快查 / 实时 / 对练 / 问答库 / 客户 / 设置） | ✅ |
| 面板宽度可拖拽（左边缘拖动、双击复位、自动记住） | ✅ |
| 实时通话辅助（复用 dsh-live-captions 的字幕，命中即给三行答案） | ✅ |
| AI 精确回答（可选，跟随 DSH 当前默认模型） | ✅ |
| 会议室对练（角色提示词 / AI 扮客户 / 我扮客户 / 多角色） | ✅ |
| 会后总结 + 客户画像回写 | ✅ |
| 通话时置顶浮层（Zoom / Teams / 微信挡住 DSH 也能看答案） | ✅ |
| 语音实时对练（TTS 念客户台词 + 麦克风回答） | ✅ |
| 从通话记录生成纪要（导 live-captions 记录 → 总结 → 写画像） | ✅ |
| 语义（向量）召回 | 规划中 |

## 实时辅助是怎么接的

不重复造轮子：采音、STT、翻译全部交给已装的 `dsh-live-captions`（它已经在用
WASAPI 采系统声音 + 麦克风、SenseVoice 识别、免费翻译桥翻中文）。
本插件每秒拉一次它的增量字幕，把 `text` 拿去检索问答库，命中就渲染三行卡片。

第一次点「开始听」会自动 `POST /live-captions/api/command {action:'start'}`；
没装 `dsh-live-captions` 时卡片会提示，而不是静默失败。点「停止」时如果字幕是本插件拉起来的，
会顺手把它也停掉（否则麦克风一直被占着，「语音回答」拿不回来）。

通话结束后（字幕自己停，或你点了「停止」），「实时」页签顶部会弹一条提示：
**这段通话结束了 · 共 N 句，要生成纪要吗？** 点「生成纪要并写画像」直接导入这场通话并总结，点「先不要」收起。

## 置顶浮层怎么用

通话时 DSH 窗口往往被 Zoom / Teams / 微信挡住，所以提供一个小浮层：

1. 「实时」页签里点「置顶浮层」——屏幕右下角出现一个 470px 宽的深色卡片；
2. 它每 0.9 秒读一次 `/rt/state`，把最新一句的「客户原话 / 中文要点 / 英文照读 / 命中率」显示出来；
3. 拖标题栏可移动；点「锁定」后鼠标会穿透（`WS_EX_TRANSPARENT`），不挡你点后面的会议软件；点「解锁」恢复；
4. 点「×」或面板上的「收起浮层」关闭。

实现是 `native/overlay.ps1`（WPF，无边框、`Topmost`，Win32 `GetWindowLong/SetWindowLong` 切穿透），
由 `lib/overlay.js` 用 `powershell.exe -STA -File` 拉起。**这个 .ps1 必须存为 UTF-8 带 BOM**，
否则 Windows PowerShell 5.1 会把中文读成乱码；改完可以这样自测：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File native\overlay.ps1 -ApiUrl http://127.0.0.1:54525/sales-copilot/api -SelfTest
```

## 对练怎么用

1. 「对练」页签里选客户角色（内置 3 个，可改可删，也可输入背景让模型生成 3 个）；
2. 新建对练：选「AI 扮客户」或「我扮客户」，关联客户档案；
3. 对话：点「客户接着说」让模型以客户身份回一句，或自己切到「我演客户」手打；
4. 点「总结并写入画像」：模型输出结论 / 客户需求 / 下一步 / 画像四块，
   勾选后把阶段、预算、备注、标签合并回客户档案。

客户角色的行为约束写在 `lib/meeting.js` 的 `BUYER_STYLE` + `PRESSURE` 里：买家熟悉自己的仓库
（几个仓、日均单量、现在用什么系统），**绝不装听不懂**，一轮只回 1–3 句，并且会拿竞品报价压价、
追问交付细节和失败案例；难度只改施压强度，不改身份。换角色提示词时不用改这里。

## 语音对练怎么用

不想只靠眼睛看，就用电脑自带语音（Windows SAPI，零下载）：

1. 对练里点「客户接着说」——客户台词回来后会**自动念出来**（默认开），想关就点「自动朗读：开」；
2. 只想念最后一句、不想让模型再回一轮，点「朗读客户台词」；
3. 你不想打字时点「语音回答」：插件借 `dsh-live-captions` 切到麦克风、听你说一句英文/中文，
   说完自动停、把识别结果作为「我（语音）」记进对话。

语音走 `native/speak.ps1` + `lib/tts.js`：按句子语言自动挑中/英文嗓音（本机是
`Microsoft Huihui Desktop` 和 `Microsoft Zira Desktop`），一次只念一句，可以打断。
`/tts/voices` 能看本机有哪些嗓音；设环境变量 `DSH_SALES_COPILOT_TTS=off` 可整体静音（测试用）。

「语音回答」开始前会检查实时字幕没在跑（两者抢麦克风），跑着会返回 409 并提示先停掉。

## 从通话记录生成纪要

客户电话/视频完了，字幕已经存在 `dsh-live-captions` 里：

1. 「对练」页签 →「③ 从通话记录生成纪要」→「读取通话记录」；
2. 下拉里选那一段（显示句数和时长）→「导入并总结」；
3. 插件会把整段字幕导成一场 `call-import` 对练，并立刻用模型总结「结论 / 客户需求 / 下一步 / 画像」，
   需求与画像部分可直接写回客户档案。

## 为什么检索是关键词而不是向量

销售现场要的是**50 毫秒内出结果**，而且话术是标准化的（价格、周期、折扣、异议应答），
关键词 + 二元组匹配在这种「短问句 → 少数标准答案」的场景里，命中率不比向量差，
但零下载、零索引、零依赖。等问答库超过 300 条、或客户提问变得很长时，再接语义召回。

## 数据放哪

默认 `%USERPROFILE%\.dsh\sales-copilot\db.json`（遵循 `DSH_HOME`）。
想换目录，在 `cordis.patch.yml` 的 `config.dataRoot` 里写绝对路径。
面板「设置」里能看到真实路径，也能一键导出整个库。

## 导入格式

三种都认，一次可粘很多行：

```
标准版多少钱？	标准版年费 ¥68,000。
Q: 上线要多久？
A: 标准版 2 周、专业版 4–6 周。
能对接 ERP 吗？ | 标准 API 加预置连接器。
```

第 2 列是中文答案；英文答案可以之后在面板里补，或直接用 agent 工具
`qa_save` 带上 `answerEn`。

## 安装

```
plugin_manager { action: "install_bundle", target: "E:\\apps\\project\\dsh-test\\sales\\plugins\\dsh-sales-copilot" }
```

安装后侧边栏底部出现「销售助手」按钮；Host 代码（index.js、lib/*）改动需要重启 DSH 才生效，
面板（client.js）改动刷新页面即可。

## 测试

```
node scripts/selftest.mjs      # 34 项：检索、解析、持久化、客户角色提示词
node scripts/integration.mjs   # 76 项：路由、agent 工具、实时、通话结束提示、浮层、语音、通话导入、角色、对练、总结
node scripts/client-check.mjs  # 33 项：客户端模块、槽位、布局、页签深渲染、语音 UI、纪要提示、宽度拖拽
node scripts/smoke.mjs http://127.0.0.1:54525/sales-copilot/api   # 10 项：对运行中的宿主真跑（会花 2 次模型调用）
```

## 改了 Host 代码怎么生效

除了重启 DSH，还有一个更快的办法：用 `plugin_manager` 先禁用再启用这个插件

```
plugin_manager { action: "set_plugin", target: "include:sales-copilot", enabled: false }
plugin_manager { action: "set_plugin", target: "include:sales-copilot", enabled: true }
```

Cordis 会重新 import 包，Host 的新路由立刻可用（实测 `/sales-copilot/api/rt/state` 从 404 变 200）。

