# Changelog

Installers: https://github.com/AvaterXXX/grok-desktop/releases

This repo ships **Windows portable exe** only. Linux / macOS: build from source (see README).

---

## [0.1.6] - 2026-08-19

Privacy: no collection, no upload, no telemetry. Login uses the local official grok CLI only.

| Fix | Note |
|------|------|
| 子代理面板 | 挪到右上角，点开常驻，点别处不收，再点收回 |
| 和目标叠放 | 两个都开时在对话右侧上下堆叠，不再盖住顶栏 |
| 工具卡箭头 | 右侧展开箭头再加大 |
| 压缩状态 | 只有真 `/compact` 才显示，不再锁死「正在压缩上下文」 |

Download: `Grok-Desktop-0.1.6-Windows-Portable-x64.exe`

---

## [0.1.5] - 2026-08-19

Privacy: no collection, no upload, no telemetry. Login uses the local official grok CLI only.

| Fix | Note |
|------|------|
| 周限额 | 启动立刻画缓存额度；空数据不再把数字刷成 — |
| 上下文环 | 按真实占用涨，不再卡在第一次估算 |
| 子代理 | 只认官方 spawn / finish，grep、权限、Kill task 不再开卡 |
| 目标续跑 | 清单全勾完不再自动「继续目标」；点暂停 / 停止也不会再发一次 |
| 侧栏 | 对话和工程可拖拽排序，运行中的置顶 |
| 压缩 | 跑 compact 时显示「正在压缩上下文」 |
| 工具卡箭头 | 更大、好点；收起朝右，展开朝下 |
| 排队编辑 | 不再出现 Windows 黑框按钮 |

Download: `Grok-Desktop-0.1.5-Windows-Portable-x64.exe`

---

## [0.1.4] - 2026-08-19

Privacy: no collection, no upload, no telemetry. Login uses the local official grok CLI only.

| Fix | Note |
|------|------|
| 会话 ID | 正文里的 UUID 原样发出；只有单独贴 ID，或 `/call <id> 消息`，才切会话 |
| 排队可编辑 | 点文字或「编辑」，回车保存，Esc 取消；生成中一打字变发送 |
| 子代理 | 输入框上方各占一行；点开看一整段工作记录；主任务结束不再卡在进行中 |
| 斜杠菜单 | 按第一段过滤，空格后收起；未入表命令不再显示无匹配 |
| 目标 / 计划 | 输入框上方纸卡片：目标全文、计划步骤；不要紫条 |
| 侧栏 | 项目 / 对话字号和行距加大 |
| 顶栏用量 | 周限额和周 Token 留下，后面加真·当日（上海时区） |
| 个人信息 | 点设置默认进这一页；居中、可读宽度；今年 1–12 月 Token 热力图 |
| 助手气泡 | 不再贴复制 / 分叉 / 记记忆 |

Source: tag `v0.1.4`. Windows portable exe 本版未重打。

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
