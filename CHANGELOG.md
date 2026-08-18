# Changelog

Installers: https://github.com/AvaterXXX/grok-desktop/releases

This repo ships **Windows portable exe** only. Linux / macOS: build from source (see README).

---

## [0.1.3] - 2026-08-19

Privacy: no collection, no upload, no telemetry. Login uses the local official grok CLI only.

| Fix | Note |
|------|------|
| 当日 API 标价 | 当日 Token 后显示估算金额，随用量更新 |
| 悬停拆 4.5 / 4.6 | 鼠标放在金额上可看 Grok 4.5 与 Grok 4.6 各花多少（缓存价不同） |
| 每轮用量 | 助手气泡按本轮实际模型展示入 / 出 / 缓存和估算 |
| 含未发布的 0.1.2 桌面修复 | 默认 4.6 + Extra High、主题对比度、壁纸、加载更早、用户图片、滚动跟随、重开看全最后一轮 |

Download: `Grok-Desktop-0.1.3-Windows-Portable-x64.exe`

---

## [0.1.2] - 2026-08-19

Privacy: no collection, no upload, no telemetry. Login uses the local official grok CLI only.

| Fix | Note |
|------|------|
| 启动 / 新对话 / 恢复会话 | 默认 Grok 4.6 + Extra High（xhigh），不再停在 High |
| 深色主题对比度 | 主按钮、周限额条、顶栏图标、命令完成卡跟暗色 token |
| 浅色聊天背景 | 保存后对话区能看见壁纸，不再被不透明底盖住 |
| 加载更早消息 | 停在刚加载的一段，不再跳回最新 |
| 用户发送的图片 | 跟在用户消息下，不贴到助手回复末尾 |
| 滚动跟随 | 在底部才跟随输出；上翻出现回到最新箭头 |
| 重开会话 | 看全最后一轮（含长回复），滚到真正底部 |

Download: `Grok-Desktop-0.1.2-Windows-Portable-x64.exe`

---

## [0.1.1] - 2026-08-19

Privacy: no collection, no upload, no telemetry. Login uses the local official grok CLI only.

| Fix | Note |
|------|------|
| 新对话默认任务模式 | 不再残留 /goal |
| 最后一条用户消息 | 可编辑 / 撤回 |
| /effort /model /usage | 斜杠走本地，不当聊天任务 |
| 生成中可排队 | Codex 细条；插队 / 删除 |
| 删会话只清本地 | 不卡 CLI |
| 重启恢复 | 思考/工具卡/目标条 |
| 贴图立刻可见 | paste image shows immediately |
| Diff / 计划条跟主题 | spinner follows system theme |
| 同一轮不重复展示 Grok | 设置可改昵称/头像 |
| 代理回填 | 空保存不覆盖 |
| 长气泡可滚 | 流式不再三重滚动 |

Download: `Grok-Desktop-0.1.1-Windows-Portable-x64.exe`

---

## [0.1.0]

Community fork baseline. Desktop shell over official grok CLI.

喜欢就点一颗 Star: https://github.com/AvaterXXX/grok-desktop
