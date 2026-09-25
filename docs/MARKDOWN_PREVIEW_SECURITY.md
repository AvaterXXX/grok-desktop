# Markdown 文件预览的安全边界

预览面向不可信的本地文件。文件读取仍经过主进程已有的路径授权检查；渲染不会增加文件权限。

## 渲染

- 先使用现有 Markdown 子集渲染器转义原始 HTML，再在惰性 template 中解析结果。
- 不把解析结果直接挂到页面。使用 createElement/createTextNode 重建固定白名单中的静态节点。
- 只允许段落、标题、表格、列表、引用与代码等排版标签，以及固定的排版 class。
- 不保留事件、style、id、name、data-*、URL 或其他属性。SVG、MathML、脚本、表单、嵌入内容等节点丢弃。
- 链接只显示文字，不触发导航或文件操作；图片不渲染，不加载远程/本地资源。工具栏的“用默认程序打开”等操作仍由用户单独点击。
- 正式界面的 CSP、contextIsolation、sandbox 保持启用。没有为 Markdown 增加新的 IPC 接口。

## 资源限制

读取最多 512 KiB。渲染超过 128 Ki 个 UTF-16 字符、4,000 行或单行 8,192 字符时退回源码；解析结果最多 1 Mi 个字符、20,000 个节点、60 层嵌套。源码通过 textContent 展示。

## 验证与限制

`npm run check:markdown` 在 Electron 中验证标题/表格/代码、源码切换和恶意载荷。测试分别检查原始 Markdown 与故意注入的危险解析器输出，检查残留标签/属性、脚本执行、外部请求和特权操作。测试宿主页故意不设置 CSP，避免把 CSP 的拦截误认为净化成功；生产 CSP 不受影响。

这是一组明确的防护与回归检查，不代表对所有未知漏洞的绝对保证。后续若开放 HTML、图片、交互组件或可点击链接，需要重新评估边界并扩展安全测试。

参考：[OWASP DOM XSS 防护](https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html)、[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)。
