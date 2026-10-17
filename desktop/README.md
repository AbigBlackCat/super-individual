# super individual · macOS 本机版

安装位置：`~/Applications/super individual.app`。双击应用即可打开看板；原 Paperclip 启动入口也会打开这个应用。

数据保存在 `~/Library/Application Support/super individual`。首次安装保留了原来的 `paperclip-data` 冷副本，迁移标记记录在 `.migration-complete.json`。请勿手动用旧源码服务启动原数据目录，避免混用两个数据副本。

创建任务时选择 Claude 或 Codex 总控和本机工作目录。先检查计划并确认，智能体才开始实施。通过独立审查后，在任务详情中验收或退回。关闭窗口会继续后台执行；菜单栏图标可重新打开。退出时运行任务会暂停保存，重启后手动恢复。首版不自动开机启动。

在“设置”中检查 CLI 登录状态。Claude 使用 `claude auth login`，Codex 使用 `codex login`。应用复用本机 CLI，模型连接仍需要网络；只有一种可用时会使用同一引擎的独立会话。

Claude 若因 SOCKS 代理而持续报 `Connection error`，可在本机实例 `.env` 中配置 `SUPER_INDIVIDUAL_CLAUDE_PROXY` 为已验证可用的 HTTP/HTTPS 代理地址。该配置仅注入 si 的 Claude 执行角色；不修改系统代理或 Codex。重启应用后生效，移除该项并重启即可撤销。登录状态只证明凭据有效，网络可用性须以实际调用验证。

## 从源码重新打包

需要 Node 24、pnpm 9、Rust 和 Xcode 命令行工具；这些只在开发和打包时需要。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @paperclipai/server deploy --prod desktop/payload/server
npm install --prefix desktop
node desktop/package.mjs
```

Electron 44.9.0 的官方 darwin-arm64 ZIP 需放在 `desktop/electron-cache/electron-v44.9.0-darwin-arm64.zip`，并按 Electron 发布的 SHA256 校验。打包输出位于 `desktop/out/super individual-darwin-arm64/super individual.app`；脚本会整理生产依赖、将链接改为包内相对链接并执行本机临时签名。当前包适用于本机 Apple Silicon Mac，未做面向其他机器的公证分发。

包内包含生产界面、编译后端、Node、PostgreSQL、Runner 和 Paperclip MIT 许可证。用户数据、CLI 登录凭据和源码运行环境不进入应用包。

## 验证

```sh
pnpm typecheck
pnpm test:run
pnpm check:tokens
pnpm check:token-gates
node --test desktop/runtime.test.mjs
```

新增工作流接口仍挂在 `/api/individual`，保留既有任务 ID、状态、companyId、父子任务、审批、文档和心跳执行机制。工作流版本及审批摘要存于根任务 metadata；重启不会自动恢复中断执行。

## Windows x64

从 GitHub Releases 下载便携 ZIP，完整解压后双击 `super individual.exe`。数据位于 `%APPDATA%\super individual`。首次使用需在 Windows 安装 Claude Code 或 Codex CLI 并登录。应用退出和重新打开后保留任务与产出。

工作流 `.github/workflows/si-windows.yml` 在 Windows 上构建、打包并测试实际桌面应用。Windows 版使用现有 CLI 执行通道，不包含仅支持 Unix 的原生 Runner。冒烟测试使用隔离的模拟 CLI，不代表真实模型账户端到端验证。
