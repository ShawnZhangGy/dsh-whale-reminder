# dsh-whale-reminder

会话结束后提醒你 —— 不再守着窗口等结果。

## 解决的问题

DeepSeek Harness 桌面版一轮会话跑完后不会主动叫你，你只能自己反复切回来瞄进度。本插件在**任务完成、需要你回答、或出错**时主动提醒，QQ/微信式未读体验。

## 主要功能

- **智能触发**：只有窗口在后台（失焦/隐藏/切到别的会话）时才提醒，正在看的不打扰。
- **双音效**：完成「叮—咚」、待回答「叮叮」，音量可调，支持自定义音效文件。
- **窗口内常驻浮层**：右下角红色数字徽章，显示「N 个会话未读 · 最新：xxx」，点击展开会话列表。
- **任务栏闪烁 + 托盘徽章**：任务栏 `FlashWindowEx` 闪烁；托盘小鲸鱼图标叠加红色数字徽章（1–9，超 9 显示「9+」），悬停缩略文字。
- **六项自定义设置页**：触发条件、提醒类型、音量/音效、浮层会话数、悬停字数、停靠角，一键「测试提醒」。

## 技术要点

- **host 半区**（Electron 主进程）：Windows 原生能力（koffi Win32 API：`FlashWindowEx`、`Shell_NotifyIcon*`）负责任务栏闪烁与托盘徽章；监听 `session/event` 的 `turn/end` / `approval/asked` / `tool/call(ask_user_question)` 触发提醒。
- **client 半区**（浏览器渲染进程）：`shell.overlay` 常驻浮层 + Web Audio 双音效 + `plugins.row.config` 设置页，通过 `__whale-reminder/*` 私有路由与 host 半区通信。
- **配置持久化**：走官方 Config schema（`@deepseek-ai/schemastery`，27 字段全 `.volatile()`）+ `settings.configure({auto:false})` + client 侧 `configForms`。

## 架构参考

复用并改造自 `dsh-tray-flash@0.5.2` 的已验证架构（win32/tray/dots/attention/koffi-loader/selftest-route），在此基础上新增声音、未读徽章、浮层与设置页。

## 限制

- 仅 Windows 桌面版（依赖 Win32 托盘/任务栏 API）。
- 托盘图标定位在 Win11 溢出区可能失败（`Shell_NotifyIconGetRect` 无 rect），此时自动降级为任务栏闪烁兜底。
