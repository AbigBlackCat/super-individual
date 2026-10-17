# Windows x64 验证记录

## 本机验证

环境：Windows 11 x64、Node.js 24.19.0、pnpm 9.15.4、Electron 44.9.0、Git for Windows。测试数据使用独立临时目录，未访问或修改正式 `%APPDATA%\super individual` 数据。

- 21 项桌面路径、运行时、MCP、验证隔离及开发链接检查通过。
- 14 项任务工作流、MCP 路由及 Claude 探测环境检查通过。
- 6 项 Windows Codex 登录硬链接和目录 junction 检查通过，包含主账户凭据原子替换、退出登录、独立公司凭据保留、API key 覆盖隔离和跨卷失败关闭。
- Codex adapter 编译与类型检查通过；SI 前后端依赖图编译通过。
- 便携应用在源码目录外、含中文和空格的软件目录运行，限制 PATH 后使用包内 Node 与 PostgreSQL。生产界面实际显示，UI 创建、编辑和保存任务，重启后任务及配置仍存在。
- MCP 五个工具的读任务、草稿创建、幂等写入、未审查结果回传通过；MCP 无计划批准能力，提前最终验收被拒绝。计划批准前无执行工作进程。
- 端口占用时自动选择其他端口，并核验本实例的就绪令牌和子进程实际绑定端口。重复启动复用原进程。关闭窗口隐藏到托盘，实际托盘点击恢复窗口。
- 有任务运行时通过退出确认暂停并保存；重启后保持暂停，无自动继续执行。退出后撤销 MCP 连接发现文件。
- 完整模拟 CLI 冒烟 15 项通过，增加了 PostgreSQL 实际加载包内 CRT 的校验。对 GitHub 公开 ZIP 下载、校验并解压后，本机测得首次启动 49 秒、重启 37 秒；另一次全新复制的冷启动为 239 秒。测量取决于磁盘、缓存和安全软件。
- PostgreSQL 原生检查在独立临时数据库连续执行三次启动、正常停止及 SQL 磁盘持久化验证，通过后才进入生产后端和桌面打包检查。

`windows-smoke.json` 是自动模拟 CLI 报告，不使用用户登录或真实模型。

## 真实 CLI 和模型

本机安装并登录的 `codex-cli 0.163.0-alpha.10.2` 已真实调用模型。早期本机软件的完整复测退出码为 0，耗时 679 秒；随后 v0.1.0 下载包的追加测试出现终端等待和文件工具 EPERM，执行角色未产出文件，已单独记录为失败，不能用早期记录代替下载包结果。

依据 [OpenAI Windows 沙箱文档](https://learn.chatgpt.com/docs/windows/windows-sandbox) 完成兼容性探测，本机支持 MXC，受限 workspace-write 下真实 CLI 文件写入通过。Windows SI 调用现增加 `features.prefer_mxc=true` 与 CLI `approval_policy="never"`，规划及审查仍为只读，执行仍为 workspace-write，计划批准和最终验收仍由 SI 界面控制。没有关闭沙箱或启用 bypass。兼容副本的完整真实规划、UI 批准、工作目录文件产出、独立审查、UI 人工最终验收及正常退出全部通过，退出码 0，耗时 380 秒。该修复进入 v0.1.1 发布流程。

真实模型报告不包含凭据、个人任务或 CLI 配置；失败尝试与通过记录分开保存。

本机没有安装 Claude CLI，真实 Claude 模型调用未验证。模拟 Claude/Codex CLI 通过不能替代对应真实模型的验证。CLI 需要用户在 Windows 本机自行安装并按官方流程登录；发布包不包含 CLI 凭据。

## 云端发布验证

Windows 发布流程在干净检出环境编译、生产依赖部署、生产后端检查、Electron 打包后，复制软件到源码外的新目录，运行完整桌面冒烟；全部通过后才允许发布 ZIP。独立 Ubuntu job 验证现有 50 项 Codex 账户隔离检查，已通过。

[最终发布流程](https://github.com/AbigBlackCat/super-individual/actions/runs/39063080392) 全部成功，云端 15 项桌面验收测得首次启动 32 秒、重启 13 秒。

[v0.1.0 下载](https://github.com/AbigBlackCat/super-individual/releases/tag/v0.1.0) 的 ZIP 为 830,979,808 字节，SHA256：

`22f7d87eb43c4296e824805ac5b027e8922253b24acaeda15f95f0d877a9c500`

本机实际下载此 ZIP 并在源码外完整解压，15 项桌面验收再次通过。文件检查确认 Node 24.19.0、PostgreSQL 18.1、x64 可执行文件、10 个 Microsoft CRT 原始校验值及 Paperclip MIT 许可证均正确；未发现个人数据库、凭据配置文件名或包外链接。应用程序 Authenticode 状态为 `NotSigned`。完整文件与运行报告分别为 `windows-package-audit.json`、`windows-smoke.json`（云端）和 `windows-downloaded-smoke.json`（下载包）。

早期发布机失败日志已明确显示 PostgreSQL 拒绝管理员令牌。CI 使用 `windows-ci-check.ps1` 和 Win32 `CreateRestrictedToken` 启动同用户检查，禁用管理员组、移除高权限；子进程断言已去除管理员组权限。针对 runner 的桌面和工作目录，仅给当前 runner 用户显式添加所需权限。没有修改 PostgreSQL 的拒绝管理员行为。本机普通账户另行完成桌面验收。

## 修复依据

另外检查 Windows PE 导入表发现，PostgreSQL 原生组件依赖三个未随旧包附带的 VC++ DLL。打包现从已授权 Visual Studio 的 x64 redist 目录复制原始 Microsoft 签名 CRT 文件到 PostgreSQL、Node 和桌面程序目录，并附带独立署名和 SHA256 清单。生产后端检查及桌面冒烟还核验 PostgreSQL 实际加载的是包内 CRT，避免本机已安装的运行库掩盖遗漏。

1. 生成配置的 `$meta.source` 不在配置 schema 枚举内；改为 `configure`，并仅修复已知旧值。
2. PostgreSQL 原生工具从中文安装路径运行时，initdb 报非法 UTF-8 字节；通过英文运行目录的 junction 加载同一份原生文件，并保留完整 stderr。
3. 后端大依赖图首次导入耗时超过旧超时；提供立即显示的准备界面及 Windows 5 分钟上限，不再将等待误报为缺少模块。
4. 普通 Windows 账户不能创建 Codex 登录文件符号链接，出现 EPERM；同卷采用硬链接，记录文件身份以处理主账户更换凭据或登出，不复制刷新凭据。
5. 健康检查可能误认端口上的其他实例；等待本子进程报告实际端口，再核验随机 MCP 能力令牌。早到的退出消息在后端初始化后处理。
6. 云端重启测试发现原依赖在 Windows 使用 `taskkill /F /T` 停止 PostgreSQL，可能残留共享内存工作进程，导致再次启动报 `pre-existing shared memory block is still in use`。仅在打包副本的 Windows 分支改用 `pg_ctl stop -m fast -w` 等待数据库正常停止，并让桌面退出检查确认本数据库进程已经退出。

## 范围与限制

- 应用未做 Authenticode 签名，可能触发 Windows 未知发布者提示。
- 验证 Windows x64 普通账户；不要以管理员身份运行。中文软件目录可用，但非 ASCII Windows 用户目录或数据目录仍有限制。
- 普通账户 Codex 登录硬链接要求相同磁盘卷；没有符号链接权限时跨卷配置会失败。
- 首次冷启动可能需要几分钟；真实模型需要网络和对应账户权限，耗时不受本机启动时间约束。
- Windows 首版使用现有 CLI 通道，未移植 Unix 原生 Rust Runner。保留 Paperclip MIT 许可证与署名。
- 仓库全量 `pnpm build` 在 Unix Runner 的 Windows ESM 路径检查失败；全量 `pnpm -r typecheck` 到 Runner 的 Rust 阶段因未安装 cargo 终止；全量 `pnpm test:run` 的上游稳定测试启动器在 Windows 报 `spawn pnpm ENOENT`。这些检查未宣称通过，Windows 交付以本报告列出的针对性检查、实际便携软件冒烟及真实 Codex 验证为依据。
