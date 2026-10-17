# super individual · Windows 开发交接

仓库：https://github.com/AbigBlackCat/super-individual （Public）

此交付是完整源码与 Windows 构建流程。**Windows 桌面应用尚未通过首次启动测试，当前没有已验证可用的 Windows 安装包。** 按用户要求，后续改动在 Windows 电脑继续进行。

## 已完成与待修复

- macOS 本机版本已运行，原工作区和数据留在原 Mac。
- Windows x64 前后端编译通过，9 项桌面/MCP 检查及 14 项工作流/连接检查通过。
- Windows 生产依赖部署、Electron 应用打包已成功。
- 打包应用首次启动时，本地后端未就绪，120 秒后测试超时；具体原因尚未取得有效日志，不能认定为某一个数据库或模块错误。
- 已补充 `desktop/windows-backend-check.mjs`，在 Electron 打包前检查生产后端启动并输出日志；已修正跨磁盘导致的失败日志上传问题。这两项改动尚未在 Windows 完整验证。
- 已停止继续等待云端构建；可从 GitHub Actions 手动重新运行，成功后流程会发布 `v0.1.0`。

最后一次完成打包、随后启动失败的记录：
https://github.com/AbigBlackCat/super-individual/actions/runs/39037842818

## Windows 电脑需要准备

1. Windows x64、Git for Windows（含 Git Bash）。
2. Node.js 24；构建环境使用过 **24.19.0**。
3. pnpm **9.15.4**。不要直接升级到 pnpm 11。
4. Claude Code 或 Codex CLI：在 Windows 单独安装并登录。无需迁移 Mac 的令牌或配置。

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
