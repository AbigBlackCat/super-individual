# super individual (si)

个人任务与智能体协作工作台，基于 [Paperclip](https://github.com/paperclipai/paperclip) 改造，保留 MIT 许可证与原作者署名。

**创建任务 → 选择 Claude / Codex 总控 → 生成计划 → 人工确认 → 执行与独立审查 → 人工验收。**

## 下载

Windows x64 便携包发布于 [Releases](https://github.com/AbigBlackCat/super-individual/releases)。解压完整文件夹后双击 `super individual.exe`，不需要安装 Node、pnpm 或 Rust。下载包内不含任何用户数据、密钥或 CLI 登录凭据。

Windows 首次启动创建自己的工作区；数据保存在 `%APPDATA%\super individual`。Claude Code 与 Codex CLI 需要在本机安装、登录，模型服务仍需联网。Mac 本机版本的开发说明见 [desktop/README.md](desktop/README.md)。

## 功能

- 中文任务看板、项目、智能体角色、讨论与产出。
- Claude / Codex 总控、计划审批、依赖交接、独立审查及最终验收。
- WorkBuddy 本地 MCP：读取任务、创建草稿、回传未审查结果。见 [使用说明](doc/WORKBUDDY.md)。
- 关闭窗口后后台运行；托盘重新打开，退出时停止并保存。
- Windows 首版复用现有 CLI 执行通道，不包含上游只支持 Unix 的原生 Runner。

## 构建与验证

[Windows 发布流程](.github/workflows/si-windows.yml) 在 Windows x64 上安装原生依赖、构建生产界面与后端、打包 Electron、运行本机 PostgreSQL 与 MCP 冒烟测试，再生成 ZIP 和 SHA256。

冒烟测试使用模拟 CLI，不包含个人账号凭据；真实 Claude / Codex 模型的 Windows 端执行需要用户登录后验证。当前版本未配置商业代码签名。

## 开源与隐私

本仓库不包含个人工作区、数据库、登录令牌、Mac 本机代理配置或执行日志。运行数据只保存在用户本机。使用模型和其他连接器时，相关数据由所选服务处理。

许可证：[MIT](LICENSE)。原项目说明保存在 [README-Paperclip.md](README-Paperclip.md)。
