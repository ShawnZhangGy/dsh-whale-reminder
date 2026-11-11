# dsh-whale-reminder

会话结束后提醒你 —— 不再守着窗口等结果。

DeepSeek Harness 桌面版（Windows）插件：一轮会话跑完后，**声音 + 窗口内浮层 + 任务栏闪烁 + 托盘徽章**四路提醒，QQ/微信式未读体验。

## 解决的问题

DeepSeek Harness 桌面版一轮会话跑完后不会主动叫你，你只能自己反复切回来瞄进度。本插件在**任务完成、需要你回答、或出错**时主动提醒，QQ/微信式未读体验。

## 安装

本插件只支持 **Windows 桌面端**（依赖 Win32 任务栏/托盘 API）。

桌面端读的是 `desktop` profile，而 `dsh plugin` 命令行按设计拒绝碰它，所以**不要用命令行装**。正确方式是在桌面端会话里让宿主内置的 `plugin_manager` 装：

> 请使用当前桌面端内置的 `plugin_manager` 安装 `dsh-whale-reminder`，装完告诉我结果以及是否需要重启。

- **首次安装**：工具可能返回 `"application":"applied"`，但这不保证当前窗口已经生效。若装完没出现浮层，**完全退出客户端（含系统托盘）后重新打开**。
- **升级**：改的是 client 半区则刷新页面（`Ctrl+F5`）即可；改了 host 半区（`lib/*.mjs`）必须完全退出重开。
- **卸载**：同一工具执行 `remove_bundle`。

## 主要功能

- **智能触发**：只有窗口在后台（失焦/隐藏/切到别的会话）时才出声提醒，正在看的不打扰；三个「什么时候算需要提醒」的开关可独立关闭。
- **双音效**：完成「叮—咚」、待回答「叮叮」，音量可调。
- **窗口内常驻浮层**：角落红色数字徽章，显示「N 个会话未读」，点击展开会话名列表，**点会话名直接跳转到该会话**，停靠角可切换四角。
- **任务栏闪烁 + 托盘徽章**：任务栏 `FlashWindowEx` 闪烁；托盘小鲸鱼图标叠加红色数字徽章（1–9，超 9 显示「9+」），悬停显示未读缩略文字。
- **七项自定义设置页**：界面语言（中文/English，默认中文）、总开关、触发条件、提醒类型、音量、浮层会话数、悬停字数、停靠角，一键「测试提醒」。
- **只提醒你看得见的会话**：已归档、子代理、空白会话一律不计入未读，与侧栏可见性规则保持一致。

## 技术要点

- **host 半区**（Electron 主进程）：Windows 原生能力（koffi Win32 API：`FlashWindowEx`、`Shell_NotifyIcon*`）负责任务栏闪烁与托盘徽章；监听 `session/event` 的 `turn/end` / `approval/asked` / `tool/call(ask_user_question)` 触发提醒。
- **client 半区**（浏览器渲染进程）：`shell.overlay` 常驻浮层 + Web Audio 双音效 + `plugins.row.config` 设置页，通过 `__whale-reminder/*` 私有路由与 host 半区通信。
- **配置持久化**：走官方 Config schema（`@deepseek-ai/schemastery`，27 字段全 `.volatile()`）+ `settings.configure({auto:false})` + client 侧 `configForms`。
- **语言**：插件自带中文/English 切换（默认中文），浮层、设置页、托盘 tooltip 三处一致，不跟随应用语言。

## 设置页在哪

插件管理器 → 找到 `dsh-whale-reminder` 这一行 → 右侧「配置」控件，打开就是完整的设置表单。

## 架构参考

复用并改造自 `dsh-tray-flash@0.5.2` 的已验证架构（win32/tray/dots/attention/koffi-loader/selftest-route），在此基础上新增声音、未读徽章、浮层与设置页。

## 限制

- 仅 Windows 桌面版（依赖 Win32 托盘/任务栏 API）。macOS/Linux 上 host 半区会安静降级，只有窗口内浮层与声音可用。
- 托盘图标定位在 Win11 溢出区可能失败（`Shell_NotifyIconGetRect` 无 rect），此时自动降级为任务栏闪烁兜底。

## 许可证

[MIT](LICENSE) © 2026 shawn
