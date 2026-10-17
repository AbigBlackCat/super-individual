# super individual · Windows x64

下载 Release 中的 `si-windows-x64-v*.zip`，完整解压到可写文件夹，以普通用户双击 `super individual.exe`。请勿选择“以管理员身份运行”：内置 PostgreSQL 会拒绝管理员进程。请保留同目录的全部文件。日常启动无需终端、Node、pnpm、Rust 或源码。

首次启动可能需要几分钟，准备界面会在本机服务就绪后自动进入看板；后续启动通常更快。中文软件目录已做兼容处理。当前已验证英文 Windows 用户目录，含非 ASCII 字符的用户或数据目录仍有限制。

包内包含 PostgreSQL 所需的 Microsoft x64 Visual C++ 运行库，采用应用目录内加载，不运行系统级运行库安装器。Microsoft 组件的署名、许可参考和 DLL 校验值见包内 `LICENSE-Microsoft-VC-Runtime.txt` 与 `Microsoft-VC-Runtime.json`。

首次打开创建个人工作区，再创建任务并选择 Claude 或 Codex 总控及工作目录。计划需要你确认后才执行；结果经过独立审查后仍须你最终验收。WorkBuddy MCP 只能读取任务、创建草稿、回传未审查结果。

任务、数据库和桌面设置保存在 `%APPDATA%\super individual`。更新软件时退出旧版本，再解压新版本；用户数据与软件目录分开保存。关闭窗口会继续后台运行，单击托盘图标可恢复窗口；使用托盘菜单“退出”会暂停运行任务并保存。重启后需要手动恢复暂停任务。

Claude Code 或 Codex CLI 需要在这台 Windows 电脑上另行安装并完成官方登录。应用复用用户本机 CLI 及已有登录，不携带或迁移任何凭据。CLI 安装和登录入口见应用“设置”及仓库 README。模型调用仍需网络和对应账户权限。普通 Windows 账户使用 Codex 时，CLI 登录目录与 SI 数据目录需位于同一磁盘卷；应用以硬链接复用登录文件，不复制刷新凭据。跨卷且没有文件符号链接权限的配置会报错。

可以用 PowerShell 验证下载完整性：

```powershell
Get-FileHash .\si-windows-x64-v0.1.0.zip -Algorithm SHA256
```

将结果与 Release 附带的 `SHA256SUMS.txt` 比较。

本版未配置代码签名证书，Windows 可能显示未知发布者。确认下载来自本仓库且校验和一致后再决定是否运行。仅支持 Windows x64；未包含上游仅支持 Unix 的原生 Runner。保留 Paperclip MIT 许可证和署名。

自动验收使用临时数据目录及模拟 Claude/Codex CLI，覆盖独立路径启动、生产界面、创建与编辑任务、重启持久化、MCP、人工审批与验收边界、端口冲突、重复启动、托盘和退出。模拟 CLI 通过不等于真实模型调用通过；真实模型验证结果以 Release 附带说明为准。

若无法启动，可检查 `%APPDATA%\super individual\logs\desktop-backend.log`。分享日志前请移除凭据、令牌和个人任务内容，不要上传数据库、`.env`、`secrets` 或 `mcp/connection.json`。
