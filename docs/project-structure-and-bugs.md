# OpenCode History Browser Next

## 项目结构

```text
opencode-history-browser/
├─ README.md
├─ package.json
├─ standalone.js
├─ tui.js
├─ log.js
├─ install-redirect.js
├─ lib/
│  ├─ cleanup.js
│  ├─ identity.js
│  ├─ opencode-cli.js
│  ├─ process-tree.js
│  ├─ redirect.js
│  ├─ static-files.js
│  └─ write-queue.js
├─ public/
│  ├─ app.js
│  ├─ index.html
│  └─ styles.css
├─ scripts/
│  ├─ browser-smoke.mjs
│  └─ startup-failure-smoke.mjs
└─ test/
   ├─ cleanup.test.js
   ├─ identity.test.js
   ├─ opencode-cli.test.js
   ├─ process-tree.test.js
   ├─ redirect.test.js
   ├─ static-files.test.js
   └─ write-queue.test.js
```

## 模块职责

### 入口层

- [`standalone.js`](../standalone.js) - 启动隐藏的 OpenCode 服务进程，管理锁文件、退出清理和浏览器宿主。
- [`tui.js`](../tui.js) - OpenCode TUI 插件入口，负责注册命令、安装/卸载 Windows 重定向、以及启动本地浏览器界面。

### 公共能力

- [`lib/identity.js`](../lib/identity.js) - 统一插件身份、路径、锁文件、日志文件和重定向常量。
- [`lib/opencode-cli.js`](../lib/opencode-cli.js) - OpenCode 命令定位与跨平台启动封装。
- [`lib/process-tree.js`](../lib/process-tree.js) - 进程树停止逻辑，包含 Windows `taskkill` 和 POSIX 进程组清理。
- [`lib/redirect.js`](../lib/redirect.js) - Windows 重定向归属识别与恢复判断。
- [`lib/static-files.js`](../lib/static-files.js) - 仅允许从 `public/` 目录读取静态资源。
- [`lib/write-queue.js`](../lib/write-queue.js) - 顺序写入队列，避免 KV 文件并发覆盖。
- [`lib/cleanup.js`](../lib/cleanup.js) - 幂等清理包装器。

### 前端

- [`public/index.html`](../public/index.html) - 浏览器主界面骨架。
- [`public/app.js`](../public/app.js) - 前端状态、会话列表、消息流、权限/问题处理、设置等逻辑。
- [`public/styles.css`](../public/styles.css) - 整体视觉样式。

### 脚本与测试

- [`scripts/browser-smoke.mjs`](../scripts/browser-smoke.mjs) - 自举浏览器烟测。
- [`scripts/startup-failure-smoke.mjs`](../scripts/startup-failure-smoke.mjs) - 启动后故障注入清理烟测。
- [`test/*.test.js`](../test) - 单元与集成测试。

## 主要问题

### 已确认并修复过的问题

1. 启动失败时，早期版本会留下后台进程或锁文件。
2. Windows 重定向在备份丢失时可能指向不存在的原始命令。
3. macOS / Linux 的 Open CLI 启动路径曾经不一致。
4. 写入 KV 文件时，一次失败可能影响后续写入。
5. POSIX 进程树退出只检查主 PID，可能漏掉子进程。

### 当前仍需关注的风险

1. Windows 重定向依赖 `opencode.cmd` / `opencode.ps1` 的本地布局，若外部安装器再次改写这些文件，卸载恢复仍要重新验证。
2. 浏览器宿主依赖 OpenCode 本体可用；如果 `opencode` 命令本身损坏，浏览器只能报错，不能自愈。
3. `scripts/browser-smoke.mjs` 和 `scripts/startup-failure-smoke.mjs` 都依赖本机可执行环境，CI 通过不等于所有第三方终端都可用。
4. 浏览器继续对话现在直接走 session API，稳定性比早期的 TUI 桥接更高，但如果 OpenCode 的异步 prompt 协议继续演进，这条链路仍需要优先回归。

## 现有测试覆盖

- 命令识别与平台启动逻辑
- 重定向检测与恢复
- 静态资源路径安全
- KV 写入重试
- 进程树清理
- 浏览器自举烟测
- 启动失败清理烟测

## 现在已有功能清单

- 打开浏览器历史会话列表
- 查看单条聊天内容和工具输出
- 继续已有聊天
- 新建聊天
- 固定、重命名、删除、批量删除会话
- 搜索会话
- 回复 OpenCode 的提问、选择项和权限请求
- 查看 reasoning、tool call、tool result、task progress
- 发送和显示图片附件
- 模型搜索与切换
- Balanced 上下文快照
- `skills`、`mcp`、`logs`、`uninstall` 浏览器命令
- skills 面板显示 plugin / scope
- MCP 面板显示连接状态、工具数、命令、工作目录和来源
- 内联识别并打开本地路径
- 打开文件、文件夹和系统默认程序
- Windows 侧的 OpenCode 命令重定向与桌面启动器
- 独立 CLI 打开与浏览器关闭互不干扰
- 浏览器发送消息直接使用 session prompt API，而不是依赖可见 TUI 输入框
- 启动失败、退出、异常时清理锁和后台进程

## 已实现清单

- `standalone.js`：隐藏启动 OpenCode host，写锁文件，退出时清理进程树和锁
- `tui.js`：注册浏览器命令、安装/恢复 Windows redirect、启动本地 Web 界面
- `lib/cleanup.js`：并发调用共用同一条清理链
- `lib/identity.js`：统一插件身份、文件名、路径和常量
- `lib/opencode-cli.js`：解析 OpenCode 命令、兼容 Windows/macOS/Linux
- `lib/process-tree.js`：跨平台停止进程树，带等待和兜底
- `lib/redirect.js`：识别 next/legacy redirect 归属，避免误覆盖
- `lib/static-files.js`：限制静态资源只能从 `public/` 读
- `lib/write-queue.js`：KV 按顺序落盘，失败后可继续写
- `public/app.js`：前端主交互逻辑
- `public/index.html`：前端结构
- `public/styles.css`：前端样式
- `scripts/browser-smoke.mjs`：一键浏览器烟测
- `scripts/startup-failure-smoke.mjs`：启动失败清理烟测
- `test/*.test.js`：对上述模块的回归测试

## 结论

这个版本的结构已经拆成了清晰的入口层、共享能力层、前端层和测试层，适合继续维护。
当前最值得盯住的是 Windows 重定向恢复和跨平台 CLI 启动兼容性，它们是安装/卸载最容易出问题的地方。
