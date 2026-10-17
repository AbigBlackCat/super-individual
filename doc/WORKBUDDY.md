# WorkBuddy → super individual 本地 MCP

本机 WorkBuddy 的「专家·技能·连接器 → 连接器 → 自定义连接器」可添加以下配置。
把 `/Users/YOUR_USERNAME` 替换为安装 si 的用户主目录；此配置只包含应用路径，不含密钥。

```json
{
  "mcpServers": {
    "super-individual": {
      "type": "stdio",
      "command": "/Users/YOUR_USERNAME/Applications/super individual.app/Contents/Resources/payload/bin/node",
      "args": ["/Users/YOUR_USERNAME/Applications/super individual.app/Contents/Resources/payload/si-mcp.mjs"]
    }
  }
}
```

先打开 si，再在 WorkBuddy 当前对话启用此 MCP。si 关闭时工具返回明确错误；重新打开后直接重试即可，不需要重新配置端口。应用启动时生成仅本机用户可读的临时连接信息，退出后撤销。连接信息不进入应用包或 Git。

工具：

- `list_workspaces`：读取工作区名称及 ID。
- `list_tasks`：按工作区读取任务，支持搜索、状态筛选及分页。
- `get_task`：读取需求、计划、进展、讨论和产出。
- `create_task`：创建草稿；必须明确 Claude/Codex 总控和存在的本机绝对工作目录。使用新 UUID 作为 `requestId`，同一请求重试时保持此 ID 和内容。
- `report_result`：回传未审查结果和可选的本机产出文件绝对路径。使用新 UUID 作为 `submissionId`，同一回传重试时保持此 ID 和内容。结果显示在任务详情的「产出」和「讨论」中；仅保存路径，不自动上传或读取文件。

MCP 不提供计划审批、任务执行、状态修改或最终验收工具。回传结果不会解除阻塞、恢复任务、批准计划或完成任务。所有写入保留活动记录，并按工作区与任务 ID 校验范围。重复请求在应用重启后仍可识别。

这条连接仅让 WorkBuddy 操作 si，不会让 si 自动驱动 WorkBuddy。后一方向需要 WorkBuddy 开放平台应用权限，当前个人账号尚不具备。

验证：`node --test desktop/si-mcp.test.mjs`；Vitest 运行 `server/src/routes/super-individual-mcp.test.ts` 与 `server/src/services/super-individual.test.ts`。发布时更新 `desktop/si-mcp.mjs`、桌面主进程、后端和前端，再重新签名应用。

## Windows 便携版

先完整解压 ZIP 并启动 si，然后在 WorkBuddy 的 MCP 设置中添加 stdio 服务。路径替换为实际解压目录，Windows JSON 中反斜杠需双写：

```json
{"mcpServers":{"si":{"command":"C:\\Apps\\si\\resources\\payload\\bin\\node.exe","args":["C:\\Apps\\si\\resources\\payload\\si-mcp.mjs"]}}}
```

连接信息自动读取 `%APPDATA%\super individual\mcp\connection.json`。不要把此文件或其中令牌上传到 GitHub。
