# Grok Desktop 架构与维护约定

## 运行边界

- `main.js`：Electron 主进程、窗口生命周期和 IPC 路由。所有渲染进程请求必须先经过 `src/security.js` 的来源与参数校验。
- `preload.js`：唯一的渲染进程能力桥。页面保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- `renderer/app.js`：当前 UI 编排层。新逻辑优先放到可独立测试的模块，避免继续扩大这个文件。
- `src/`：会话、搜索、ACP、持久化、用量、记忆、技能和平台能力。

## 会话事件流

```text
ACP 原始事件
  → src/acp-events.js（统一事件名称）
  → renderer/session-store.js（每会话 reducer）
  → renderer/stream-model.js（保留流式片段顺序）
  → renderer/app.js（增量渲染）
```

必须维持以下顺序不变量：

- 只合并相邻且同类型的流片段。
- 工具开始或助手正文出现时，结束并折叠当前思考段。
- 工具之后的新思考必须创建在工具下方，不能回填到本轮第一个思考框。
- 工具结束状态不能被迟到的非终态更新降级。
- 后台会话只更新自己的 `SessionStore` 和 DOM 面板。

历史预览在 `src/sessions.js` 中按相同规则恢复顺序；思考只与紧邻的思考记录合并。`renderer/history-model.js` 负责分页、恢复文本去重与图片定位。

## 数据与性能

- 会话目录索引由 `src/sessions.js` 缓存；全文搜索在 `src/search.js` 中异步执行，并可淘汰过期请求。
- 历史图片先返回元数据，缩略图和原图按需读取，避免通过 IPC 一次传输大量 Base64。
- `src/file-store.js` 使用临时文件加原子替换；草稿和流式恢复数据在内存中合并后批量落盘，退出时强制刷新。
- `desktop-ui.json` 与设置文件都有版本字段和迁移函数。修改结构时必须增加迁移测试。
- `src/diagnostics.js` 仅保存有界、脱敏的事件元数据，不记录消息正文或凭据。

## 展示层

样式加载顺序是 `vendor → legacy → polish`。`scripts/css-audit.js` 阻止新增无约束的 `!important` 和退役样式回流。思考、过程说明、工具步骤和最终答复必须依赖事件语义分类，不能按 DOM 位置猜测。

窄窗口、125%/150% DPI、键盘焦点、弹窗焦点恢复和 `prefers-reduced-motion` 都属于发布前回归范围。

## 验证命令

```text
npm run check          # lint、格式、类型、语法、单元、UI、CSS、性能
npm run check:audit    # 锁文件依赖漏洞
npm run check:electron # 沙箱与 preload 能力边界
npm run check:visual   # 125%/150% DPI 截图回归
npm run check:win      # Windows 与 Grok CLI 环境
npm run smoke          # 会话历史与 ACP 恢复
npm run check:memory   # 记忆读写
```

CI 在 Node.js 22 上同时运行 Windows 与 Linux 检查，Windows 额外执行 Electron 沙箱和截图回归。
