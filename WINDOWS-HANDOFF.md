# super individual · Windows 开发交接

仓库：https://github.com/AbigBlackCat/super-individual （Public）

2026-10-18 交付更新：[Windows x64 v0.1.1 已发布](https://github.com/AbigBlackCat/super-individual/releases/tag/v0.1.1)。云端和下载 ZIP 解压后的本机软件均通过 15 项桌面验收，覆盖独立目录启动、界面任务创建与编辑、退出暂停保存和重启持久化。正式下载包的真实 Codex 全流程通过，耗时 163 秒，包含规划、界面批准、文件产出、独立审查、界面最终验收和正常退出。模拟 CLI 和真实模型报告分别附在 Release 中。

已依据日志修复配置元数据枚举、中文软件目录下 PostgreSQL 原生路径、Windows 普通账户 Codex 登录文件链接、后端端口归属确认和退出过程。PostgreSQL 改用 pg_ctl 正常停止，包内附带所需 Microsoft CRT，校验进程实际加载包内 DLL。Windows Codex 在现有只读或 workspace-write 沙箱内优先 MXC，修复旧版下载包真实执行阻塞。首次冷启动的导入耗时可能超过原先的 120 秒，现显示准备界面并最多等待 5 分钟。云端 Windows runner 使用管理员令牌，发布检查另以同用户受限令牌执行，保留 PostgreSQL 拒绝管理员的安全限制。未改动任务 API、状态枚举、companyId 或调度审批边界。

详细使用限制见 `desktop/WINDOWS-使用说明.md`，验证记录见 `desktop/WINDOWS-验证报告.md`。下文“已完成与待修复”保留原始交接状态供追溯，不能作为当前版本验证结果。

## 原始交接状态（历史记录）

- macOS 本机版本已运行，原工作区和数据留在原 Mac。
- Windows x64 前后端编译通过，9 项桌面/MCP 检查及 14 项工作流/连接检查通过。
- Windows 生产依赖部署、Electron 应用打包已成功。
- 打包应用首次启动时，本地后端未就绪，120 秒后测试超时；具体原因尚未取得有效日志，不能认定为某一个数据库或模块错误。
- 已补充 `desktop/windows-backend-check.mjs`，在 Electron 打包前检查生产后端启动并输出日志；已修正跨磁盘导致的失败日志上传问题。这两项改动尚未在 Windows 完整验证。
- 已停止继续等待云端构建；可从 GitHub Actions 手动重新运行，成功后流程会发布 `v0.1.0`。

最后一次完成打包、随后启动失败的记录：
https://github.com/AbigBlackCat/super-individual/actions/runs/39037842818

## Windows 电脑需要准备

1. Windows x64、[Git for Windows](https://gitforwindows.org/)（含 Git Bash）。
2. [Node.js 24](https://nodejs.org/en/download)；构建环境使用过 **24.19.0**。
3. pnpm **9.15.4**。不要直接升级到 pnpm 11。
4. Claude Code 或 Codex CLI：在 Windows 单独安装并登录。无需迁移 Mac 的令牌或配置。
5. 仅构建机需要已授权的 Visual Studio C++ Build Tools，供打包程序从 `VC/Redist/MSVC/<version>/x64/Microsoft.VC*.CRT` 提取原始签名运行库；也可用 `SI_VC_RUNTIME_DIRECTORY` 指向同类已授权的 x64 CRT redist 目录。日常使用者无需安装 Build Tools 或系统级 VC++ 运行库。

本地 SI 首版使用现有 CLI 执行通道。上游原生 Runner 仅支持 Unix，Windows 构建跳过 Rust 二进制；无需为本次 Windows 构建安装 Rust。

## 获取代码

在 Git Bash 中运行（后面的构建命令同样使用 Git Bash）：

```bash
git clone https://github.com/AbigBlackCat/super-individual.git
cd super-individual
npm install --global pnpm@9.15.4
node --version
pnpm --version
```

也可以下载本次发布的 `si-windows-source.zip`，完整解压后在该目录打开 Git Bash。

## 构建与检查

默认 Git 安装目录如下；若安装在其他位置，修改第一行：

```bash
export NPM_CONFIG_SCRIPT_SHELL='C:\Program Files\Git\bin\bash.exe'
pnpm install --frozen-lockfile
pnpm -r --workspace-concurrency=1 --filter '@paperclipai/server...' --filter '@paperclipai/ui...' exec node "$PWD/desktop/compile-package.mjs"
node --test desktop/platform.test.mjs desktop/runtime.test.mjs desktop/si-mcp.test.mjs
pnpm exec vitest run server/src/services/super-individual.test.ts server/src/routes/super-individual-mcp.test.ts packages/adapters/claude-local/src/server/probe-env.test.ts
```

生产依赖部署时，先暂时移除仅开发依赖使用的 acpx 0.12 补丁。其他生产补丁继续校验；部署完恢复原清单：

```bash
cp package.json package.json.si-build-backup
node --input-type=module -e 'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json","utf8")); delete p.pnpm.patchedDependencies["acpx@0.12.0"]; fs.writeFileSync("package.json",JSON.stringify(p,null,2));'
pnpm --filter @paperclipai/server --config.node-linker=hoisted deploy --prod desktop/payload/server
mv package.json.si-build-backup package.json
npm ci --prefix desktop
node desktop/package-windows.mjs
```

先解决此处生产后端检查报告的真实错误，之后再执行：

```bash
node desktop/windows-smoke.mjs
```

成功后的应用目录：`desktop/out/super individual-win32-x64/`。必须携带整个目录，入口为 `super individual.exe`。

完整的自动流程见 `.github/workflows/si-windows.yml`。进入 GitHub 仓库 → Actions → SI Windows release → Run workflow 即可重新构建；需要代码修复后再把改动推送至仓库。

## 直接排查生产后端

`package-windows.mjs` 会先准备好 `desktop/payload`，再检查后端。若检查失败，可在 Git Bash 前台启动同一份后端，读取完整错误：

```bash
export PAPERCLIP_HOME="$(cygpath -m "$APPDATA")/super individual-dev"
export PAPERCLIP_CONFIG="$PAPERCLIP_HOME/instances/default/config.json"
export PAPERCLIP_INSTANCE_ID=default
export SUPER_INDIVIDUAL=true
export HOST=127.0.0.1
export PORT=3100
export SERVE_UI=true
export PAPERCLIP_UI_DEV_MIDDLEWARE=false
node desktop/payload/launch.mjs
```

使用独立的开发数据目录；此方法用于诊断后端，桌面 MCP 连接发现文件由 Electron 主进程生成。

## 关键位置与数据约束

- `desktop/main.cjs`：窗口、托盘、后端进程、退出保存。
- `desktop/runtime.mjs`、`desktop/launch.mjs`：跨平台路径、端口、配置、数据库启动。
- `desktop/package-windows.mjs`：Windows Node/依赖/界面/Electron 打包。
- `desktop/windows-backend-check.mjs`、`desktop/windows-smoke.mjs`：生产后端及桌面启动检查。
- `ui/src/pages/SuperIndividual.tsx`：中文任务工作台。
- `server/src/services/super-individual.ts`：规划、审批、派发、审查及人工验收。
- `desktop/si-mcp.mjs`：WorkBuddy 接入；配置示例见 `doc/WORKBUDDY.md`。

保持 `/api`、任务 ID、状态枚举和内部 `companyId` 模型。计划必须由人批准，根任务必须由人验收；MCP 仅支持读任务、创建草稿和回传未审查结果。

正式桌面数据位于 `%APPDATA%\super individual`。不要把数据库、`.env`、`secrets`、`mcp/connection.json` 或 CLI 凭据提交到 GitHub。Git 仓库和本次 ZIP 均不包含这些个人数据；原 Paperclip MIT 许可证与署名保留。

## 给 Windows 编程助手的接手提示

> 请先阅读 WINDOWS-HANDOFF.md、desktop/WINDOWS-验证报告.md 和对应 Release 的验证报告。Windows 构建仅编译 SI 使用的 React、后端与 CLI 通道；不要求移植 Unix Runner。复现时使用独立的 SI_DATA_DIRECTORY，运行生产后端检查、针对性检查和便携包桌面冒烟测试。保留现有 API、审批与人工验收边界，不迁移或上传任何个人凭据和数据库，不重写调度系统。
