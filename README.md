# dsh-sales-copilot

开箱即用的 DSH 中英双语销售助手插件。

## 在 DSH 中安装

将本仓库作为插件包安装，或在 DSH 的插件市场中搜索 `dsh-sales-copilot` 并点击安装。安装包会自动挂载 Host、侧边栏面板和 `sales_copilot` 工具，不需要手动编辑配置文件或填写 API Key。

安装后刷新 DSH 页面，侧边栏会出现「销售助手」。插件自带 FAQ、产品价格、客户角色和示例数据，数据保存在当前用户的 `%USERPROFILE%\\.dsh\\sales-copilot\\db.json`。

## 已包含

- FAQ 快查、中文要点和英文照读句
- 实时通话辅助与置顶浮层
- AI 客户角色对练、多角色预留
- Windows SAPI 语音朗读和麦克风语音回答
- 通话字幕导入、自动纪要和客户画像回写
- 可拖拽宽度的 DSH 原生适配面板

## 运行条件

- Windows + DSH Desktop（Node.js >= 20，DSH >= 0.2.0）
- 实时字幕和语音回答会自动复用 `dsh-live-captions`；没有安装时 FAQ、客户和文本对练仍可用，实时页会明确提示缺少依赖
- 模型自动跟随 DSH 当前默认模型，不需要单独配置厂商或 API Key
- ChatGPT Plus 账号不会被当作 API Key 使用

## 本地开发

```powershell
node plugins/dsh-sales-copilot/scripts/selftest.mjs
node plugins/dsh-sales-copilot/scripts/integration.mjs
node plugins/dsh-sales-copilot/scripts/client-check.mjs
```

详细功能说明见 [插件详情](plugins/dsh-sales-copilot/docs/DETAIL.md)。
