# Grok Desktop

**本地改版 0.1.0** — 基于官方 Grok CLI 的桌面工作区。

改自社区项目 [xiaokaige1130-maker/grok-desktop](https://github.com/xiaokaige1130-maker/grok-desktop)（上游约 0.8.10 / 0.8.11）。本叉从 0.1.0 重新计版。

> 这是社区改版，不是 xAI 官方产品。账号、模型和额度仍由本机官方 grok CLI 管理。

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-22C55E?style=flat-square" alt="0.1.0" />
  <img src="https://img.shields.io/badge/fork-xiaokaige1130--maker-334155?style=flat-square" alt="fork" />
  <img src="https://img.shields.io/badge/backend-official%20Grok%20CLI-111827?style=flat-square" alt="CLI" />
</p>


---

## 这版相对上游改了什么

面向日常使用：浅色纸面、代理、官方斜杠、额度顶栏。请用源码启动，不要跑旧的便携包。

### 外观

| 项 | 说明 |
|---|---|
| 主题 | 暖纸浅色，去冷灰、紫边和彩虹图标；可选纸 / 石 / 墨 / Sage / 暮 / 陶 |
| 顶栏 | 名称 + 周限额 / 刷新 / 当日消耗 + 设置 |
| 侧栏 | 纯文字：对话 / 记忆 / 技能 / 插件；新对话是细边加号 |
| 聊天 | 接近 Codex：助手通栏、用户靠右；悬停操作单独一行，不盖字、不跳动 |
| Markdown | 按行解析围栏，支持带行号和路径的代码块 |
| 输入栏 | 去掉重复目录芯片；上下文改小圆环；左侧改权限（审批 / 智能 / 完全访问） |
| 设置 | 浅色统一；插件安装钮和名字同一行；自动化改列表 |
| 新对话 | 可在项目上用加号或右键打开，不必每次选目录 |

### 代理与稳定性

| 项 | 说明 |
|---|---|
| 代理 | 设置里一行开关 + 地址，同时写入 http 和 https 代理，重启保留 |
| 打开会话 | 自己兜底设代理，避免缺函数打不开 |
| 日志 | Windows 启动用 UTF-8，中文路径不再乱码 |
| 启动 | 就绪读本机模型缓存；带启动耗时日志 |
| 回放 | 重开会话会回放思考和工具调用 |

### 额度与斜杠

官方没有 usage 子命令，终端里的 usage（别名 cost）是界面自己拦的。

- 桌面处理 usage / cost / context / session-info / help / docs，出卡片，不当聊天发出去
- 周限额走助手协议账单接口，失败则读本地日志和缓存
- 顶栏每轮刷新；助手回复下显示本轮消耗
- compact / model / effort / plan / goal 仍交给 CLI

## 运行

需要本机已安装并登录官方 Grok CLI。

先安装依赖，再启动桌面。改过主进程后整退再开。

国内网络请在设置里填本地代理，并打开系统代理或 TUN。

兼容接口写在 CLI 配置文件里，本应用不另写客户端。

## 明确没做

- 不内置账号，不替代官方 CLI
- 旧便携构建不是本版
- 仓库不含安装包和依赖目录

## 已知问题

- 账单接口在部分 CLI 通道上可能不可用，顶栏会空一阵
- 每轮刷新账单偶发偏慢
- CLI 关闭记忆时，记忆页是空的
- 插件市场依赖 GitHub，网络不到会一直转

## 致谢

核心框架来自上游 grok-desktop 社区项目。Grok 与 xAI 是其权利人的商标。本改版只做桌面壳，不提供模型服务。

