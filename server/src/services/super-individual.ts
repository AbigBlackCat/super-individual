import path from "node:path";
import os from "node:os";
import { realpath, mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { individualPlanSchema, readIndividualWorkflow, readyIndividualSteps, type IndividualEngine, type IndividualWorkflow, type IndividualStage } from "@paperclipai/shared";
import { individualStageOverrides, individualClaudeEnvironment, individualCodexArguments } from "./super-individual-policy.js";
import { issueService } from "./issues.js";
import { documentService } from "./documents.js";
import { approvalService } from "./approvals.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

const executeFile = promisify(execFile);
async function executeIndividualCommand(command: string, args: string[]) {
  if (process.platform !== "win32") return executeFile(command, args, { timeout: 8000, maxBuffer: 65536 });
  const result = await runChildProcess(`si-detect-${randomUUID()}`, command, args, { cwd: os.homedir(), env: {}, timeoutSec: 8, graceSec: 1, onLog: async () => {} });
  if (result.exitCode !== 0 || result.timedOut) throw new Error("CLI probe failed");
  return { stdout: result.stdout, stderr: result.stderr };
}
const ORIGIN = "plugin:super-individual";
const STAGE_ORIGIN = "plugin:super-individual-stage";
const activePhases = ["planning", "executing", "reviewing"];
const instances = new WeakMap<Db, ReturnType<typeof createService>>();
const planFormat = '只输出一个 JSON 代码块，格式为 {"summary":"计划说明","acceptance":"验收标准","steps":[{"key":"step1","title":"标题","description":"完整执行要求与交付文件","kind":"coding或research或writing或document","dependsOn":[]}]}。最多12个步骤，依赖必须使用已定义的key且无循环。';

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const raw = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try { return JSON.parse(raw); } catch { throw unprocessable("智能体没有返回有效的结构化结果，请重试或修改计划。"); }
}
export function individualPlanDigest(plan: unknown) { return createHash("sha256").update(JSON.stringify(plan)).digest("hex"); }

export async function findIndividualCommand(engine: IndividualEngine) {
  if (process.platform === "win32") {
    const configured = engine === "claude" ? process.env.SUPER_INDIVIDUAL_CLAUDE : process.env.SUPER_INDIVIDUAL_CODEX;
    const native = path.join(os.homedir(), ".local/bin", `${engine}.exe`);
    const found = await executeFile("where.exe", [engine], { timeout: 8000 }).then(result => result.stdout.trim().split(/\r?\n/)).catch(() => []);
    for (const command of [configured, native, ...found].filter(Boolean) as string[]) {
      try { await executeIndividualCommand(command, ["--version"]); return command; } catch {}
    }
    return null;
  }
  const candidates = engine === "claude"
    ? [process.env.SUPER_INDIVIDUAL_CLAUDE, path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "claude"]
    : [process.env.SUPER_INDIVIDUAL_CODEX, "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "/opt/homebrew/bin/codex", path.join(os.homedir(), ".local/bin/codex"), "codex"];
  for (const command of candidates.filter(Boolean) as string[]) {
    try { await executeIndividualCommand(command, ["--version"]); return command; } catch { /* Try the next installed location. */ }
  }
  return null;
}

function createService(db: Db) {
  const tasks = issueService(db);
  const docs = documentService(db);
  const approval = approvalService(db);
  const heartbeat = heartbeatService(db);
  const lifecycle = createAgentLifecycle(db);
  let ticking = false;
  let initialized = false;
  let engineCache: { at: number; value: Awaited<ReturnType<typeof probeEngines>> } | null = null;
  const operations = new Map<string, Promise<unknown>>();

  async function probeEngines() {
    return Promise.all((["claude", "codex"] as const).map(async engine => {
      const command = await findIndividualCommand(engine);
      if (!command) return { engine, available: false, loggedIn: false };
      try {
        const response = await executeIndividualCommand(command, engine === "claude" ? ["auth", "status"] : ["login", "status"]);
        const loggedIn = engine === "claude" ? JSON.parse(response.stdout).loggedIn === true : /logged in/i.test(response.stdout + response.stderr);
        return { engine, available: true, loggedIn };
      } catch { return { engine, available: true, loggedIn: false }; }
    }));
  }
  async function engines(refresh = false) {
    if (!refresh && engineCache && Date.now() - engineCache.at < 60000) return engineCache.value;
    const value = await probeEngines(); engineCache = { at: Date.now(), value }; return value;
  }
  async function serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = operations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    operations.set(id, next);
    try { return await next; } finally { if (operations.get(id) === next) operations.delete(id); }
  }
  async function load(id: string, companyId?: string) {
    const row = await db.select().from(issues).where(and(eq(issues.id, id), ...(companyId ? [eq(issues.companyId, companyId)] : []))).then(rows => rows[0]);
    const workflow = readIndividualWorkflow(row?.assigneeAdapterOverrides);
    if (!row || !workflow || row.originKind !== ORIGIN) throw notFound("任务不存在");
    return { row, workflow };
  }
  async function save(id: string, workflow: IndividualWorkflow, status?: string) {
    const { row } = await load(id);
    await tasks.update(id, { assigneeAdapterOverrides: { ...row.assigneeAdapterOverrides, superIndividual: workflow }, ...(status ? { status } : {}), companyGuard: row.companyId });
  }
  async function record(companyId: string, id: string, action: string, userId = "local-board", details?: Record<string, unknown>) {
    await logActivity(db, { companyId, actorType: "user", actorId: userId, action: `super_individual.${action}`, entityType: "issue", entityId: id, issueId: id, details });
  }
  async function ensureAgent(companyId: string, engine: IndividualEngine, role: IndividualStage["role"], directory: string) {
    const name = `SI ${engine} ${role} · ${createHash("sha256").update(directory).digest("hex").slice(0, 8)}`;
    let agent = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, name))).then(rows => rows[0]);
    const command = await findIndividualCommand(engine);
    if (!command) throw unprocessable(`${engine} CLI 尚未安装`);
    const config = {
      ...agent?.adapterConfig,
      cwd: directory, engine: "cli", command,
      env: engine === "claude" ? individualClaudeEnvironment(process.env.SUPER_INDIVIDUAL_CLAUDE_PROXY) : { CODEX_HOME: path.join(os.homedir(), ".codex") },
      timeoutSec: 1800,
      ...(engine === "claude"
        ? { dangerouslySkipPermissions: false, extraArgs: ["--permission-mode", role === "worker" ? "acceptEdits" : "plan", "--allowedTools", role === "worker" ? "Read,Write,Edit,Glob,Grep,Bash" : "Read,Glob,Grep", ...(role === "worker" ? [] : ["--tools", "Read,Glob,Grep"])] }
        : { dangerouslyBypassApprovalsAndSandbox: false, extraArgs: individualCodexArguments(role) }),
      promptTemplate: "{{instructions}}\n{{context.superIndividualPrompt}}",
    };
    if (!agent) {
      const created = await lifecycle.requestHire(companyId, { name, role: role === "reviewer" ? "qa" : role === "planner" ? "pm" : "general", adapterType: `${engine}_local`, runner: "legacy", adapterConfig: config, runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 2 } }, metadata: { superIndividual: true }, permissions: { canCreateAgents: false } }, { createdByUserId: "local-board" });
      agent = created as typeof agent;
    } else if (JSON.stringify(agent.adapterConfig) !== JSON.stringify(config)) {
      await lifecycle.updateConfiguration(agent.id, { adapterType: `${engine}_local`, adapterConfig: config });
    }
    if (!agent) throw unprocessable("智能体创建失败");
    if (agent.lifecycleError) await lifecycle.retry(agent.id);
    return agent;
  }
  async function availableEngine(preferred: IndividualEngine) {
    const list = await engines();
    if (list.some(item => item.engine === preferred && item.loggedIn)) return preferred;
    const fallback = list.find(item => item.loggedIn);
    if (!fallback) throw unprocessable("请先在设置中连接 Claude 或 Codex");
    return fallback.engine;
  }
  async function startStage(root: typeof issues.$inferSelect, workflow: IndividualWorkflow, role: IndividualStage["role"], key: string, preferred: IndividualEngine, prompt: string) {
    const engine = role === "planner" ? ((await engines()).some(item => item.engine === preferred && item.loggedIn) ? preferred : null) : await availableEngine(preferred);
    if (!engine) throw unprocessable(`你选择的 ${preferred} 总控尚未连接，请先在设置中登录后生成计划`);
    const agent = await ensureAgent(root.companyId, engine, role, workflow.directory);
    const roleInstructions = typeof agent.metadata?.superIndividualRoleInstructions === "string" ? agent.metadata.superIndividualRoleInstructions : "";
    prompt = `${roleInstructions ? `角色补充要求：${roleInstructions}\n` : ""}工作目录（本步骤唯一产出位置）：${workflow.directory}\n${prompt}`;
    const child = await tasks.create(root.companyId, { title: `${role === "planner" ? "规划" : role === "reviewer" ? "审查" : "执行"} · ${key}`, description: prompt, parentId: root.id, projectId: root.projectId, assigneeAgentId: agent.id, responsibleUserId: root.responsibleUserId ?? "local-board", status: "todo", priority: root.priority, workMode: role === "worker" ? "standard" : "planning", originKind: STAGE_ORIGIN, originId: root.id, assigneeAdapterOverrides: individualStageOverrides(workflow.directory), idempotencyKey: `si-stage:${root.id}:${randomUUID()}` });
    const stage: IndividualStage = { issueId: child.id, key, role, engine, agentId: agent.id, status: "pending" };
    workflow.stages.push(stage);
    await save(root.id, workflow, "in_progress");
    await record(root.companyId, root.id, "stage.created", "local-board", { childId: child.id, role, engine });
    try {
      const run = await heartbeat.wakeup(agent.id, { source: "on_demand", triggerDetail: "manual", reason: "super_individual", payload: { issueId: child.id }, idempotencyKey: `si:${child.id}`, requestedByActorType: "user", requestedByActorId: "local-board", contextSnapshot: { issueId: child.id, taskId: child.id, responsibleUserId: root.responsibleUserId ?? "local-board", superIndividualPrompt: prompt } });
      stage.runId = run?.id; stage.status = "running";
      if (!run) throw new Error("执行器暂未就绪，请稍后重试");
    } catch (error) { stage.status = "failed"; workflow.phase = "blocked"; workflow.error = error instanceof Error ? error.message : String(error); }
    await save(root.id, workflow, workflow.phase === "blocked" ? "blocked" : "in_progress");
  }
  async function stopTree(rootId: string, reason: string) {
    const children = await db.select({ id: issues.id }).from(issues).where(eq(issues.parentId, rootId));
    if (!children.length) return;
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(inArray(heartbeatRuns.issueId, children.map(child => child.id)), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])));
    for (const run of runs) await heartbeat.cancelRun(run.id, reason);
  }
  async function stageResult(stage: IndividualStage) {
    if (!stage.runId) return null;
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stage.runId)).then(rows => rows[0]);
    if (!run) return null;
    if (run.status === "queued") {
      const agent = await db.select().from(agents).where(eq(agents.id, run.agentId)).then(rows => rows[0]);
      if (agent?.lifecycleError) { await heartbeat.cancelRun(run.id, "super_individual_connection_unavailable"); return { status: "failed", text: "", error: agent.lifecycleError }; }
    }
    if (["queued", "running", "scheduled_retry"].includes(run.status)) return null;
    const comments = await tasks.listComments(stage.issueId);
    const last = [...comments].reverse().find(comment => comment.authorAgentId && comment.body);
    const result = run.resultJson ?? {};
    const nested = result.nativeResult && typeof result.nativeResult === "object" ? result.nativeResult as Record<string, unknown> : {};
    const text = last?.body ?? String(result.result ?? result.response ?? result.summary ?? nested.summary ?? "");
    return { status: run.status, text, error: run.error ?? run.stderrExcerpt };
  }
  async function reconcile(id: string) {
    const { row: root, workflow } = await load(id);
    if (!activePhases.includes(workflow.phase)) return;
    for (const stage of workflow.stages.filter(item => item.status === "running" || item.status === "pending")) {
      const result = await stageResult(stage);
      if (!result) continue;
      if (result.status !== "succeeded") { stage.status = "failed"; workflow.phase = "blocked"; workflow.error = result.error || `执行未完成 (${result.status})，请查看日志后重试`; await save(id, workflow, "blocked"); return; }
      stage.status = "done"; stage.result = result.text;
      if (stage.role === "planner") {
        try {
          workflow.plan = individualPlanSchema.parse(extractJson(result.text));
          for (const step of workflow.plan.steps) step.engine = await availableEngine(step.kind === "coding" ? "codex" : "claude");
          workflow.planRevision = individualPlanDigest(workflow.plan);
          const current = await docs.getIssueDocumentByKey(id, "plan");
          const document = await docs.upsertIssueDocument({ issueId: id, key: "plan", title: "执行计划与分工", format: "markdown", body: JSON.stringify(workflow.plan, null, 2), baseRevisionId: current?.latestRevisionId, createdByUserId: "local-board" });
          const request = await approval.create(root.companyId, { type: "request_board_approval", requestedByUserId: "local-board", payload: { issueId: id, planRevision: workflow.planRevision, documentRevisionId: document.document.latestRevisionId, kind: "super_individual_plan" } });
          workflow.approvalId = request.id; workflow.phase = "plan_review"; workflow.error = null;
        } catch (error) { workflow.phase = "blocked"; workflow.error = error instanceof Error ? error.message : String(error); }
      }
      if (stage.role === "reviewer") {
        try {
          const review = extractJson(result.text) as { passed?: unknown; feedback?: unknown };
          if (typeof review.passed !== "boolean" || typeof review.feedback !== "string") throw new Error("审查结果格式不正确");
          workflow.feedback = review.feedback;
          if (review.passed) workflow.phase = "acceptance";
          else if (workflow.reviewRound >= 3) { workflow.phase = "blocked"; workflow.error = "三轮返工后仍未通过审查：" + review.feedback; }
          else {
            workflow.reviewRound++; workflow.phase = "executing";
            workflow.stages = workflow.stages.filter(item => item.role === "planner");
            await tasks.addComment(id, `审查要求返工（第 ${workflow.reviewRound} 轮）：\n${review.feedback}`, { userId: "local-board" });
          }
        } catch (error) { workflow.phase = "blocked"; workflow.error = error instanceof Error ? error.message : String(error); }
      }
      await save(id, workflow, workflow.phase === "acceptance" ? "in_review" : workflow.phase === "blocked" ? "blocked" : workflow.phase === "plan_review" ? "todo" : "in_progress");
    }
    if (workflow.phase === "executing") {
      if (workflow.approvedRevision !== workflow.planRevision) { workflow.phase = "plan_review"; await save(id, workflow, "todo"); return; }
      const completed = workflow.plan?.steps.every(step => workflow.stages.some(stage => stage.role === "worker" && stage.key === step.key && stage.status === "done"));
      if (completed) {
        workflow.phase = "reviewing"; await save(id, workflow);
        const results = workflow.stages.filter(stage => stage.role === "worker").map(stage => `${stage.key}: ${stage.result}`).join("\n\n");
        await startStage(root, workflow, "reviewer", `review-${workflow.reviewRound}`, workflow.coordinator === "claude" ? "codex" : "claude", `你是独立审查员，仅检查和读取产出，不修改交付文件。按原始要求和验收标准逐项核实真实文件，不采信执行者自述。\n需求：${root.description}\n计划：${JSON.stringify(workflow.plan)}\n结果：${results}\n仅返回 JSON 代码块 {"passed":true或false,"feedback":"具体审查结论及需返工内容"}。不要创建其他任务，不标记父任务完成。`);
      } else {
        const busy = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.status, ["queued", "running"]));
        let capacity = Math.max(0, 2 - busy.length);
        // Workers sharing this directory run serially; tasks in other directories may run concurrently.
        const roots = await db.select({ id: issues.id, overrides: issues.assigneeAdapterOverrides }).from(issues).where(eq(issues.originKind, ORIGIN));
        const sameDirectoryBusy = roots.some(other => other.id !== id && readIndividualWorkflow(other.overrides)?.directory === workflow.directory && readIndividualWorkflow(other.overrides)?.stages.some(stage => stage.status === "running"));
        if (!sameDirectoryBusy && !workflow.stages.some(stage => stage.status === "running")) {
          const next = readyIndividualSteps(workflow)[0];
          if (next && capacity-- > 0) await startStage(root, workflow, "worker", next.key, next.engine ?? (next.kind === "coding" ? "codex" : "claude"), `执行已由用户确认的计划中的这一项。仅在工作目录内产出，不创建或派发额外任务，不修改父任务。完成后说明文件路径、检查结果及限制。\n总需求：${root.description}\n验收标准：${workflow.plan?.acceptance}\n当前任务：${next.title}\n${next.description}\n此前成果：${workflow.stages.filter(stage => stage.role === "worker" && stage.status === "done").map(stage => stage.result).join("\n")}\n返工意见：${workflow.feedback ?? "无"}`);
        }
      }
    }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const rows = await db.select().from(issues).where(eq(issues.originKind, ORIGIN));
      for (const row of rows) {
        const workflow = readIndividualWorkflow(row.assigneeAdapterOverrides);
        if (!workflow || !activePhases.includes(workflow.phase)) continue;
        await serialized(row.id, async () => {
          if (!initialized) { workflow.resumePhase = workflow.phase; workflow.phase = "paused"; workflow.error = "上次运行已中断，请点击恢复继续"; await save(row.id, workflow, "blocked"); await stopTree(row.id, "super_individual_restart"); for (const stage of workflow.stages) if (["running", "pending"].includes(stage.status)) stage.status = "failed"; await save(row.id, workflow); }
          else await reconcile(row.id);
        }).catch(async error => {
          logger.warn({ err: error, taskId: row.id }, "super individual reconciliation failed");
          const current = await load(row.id);
          current.workflow.phase = "blocked";
          current.workflow.error = error instanceof Error ? error.message : String(error);
          await save(row.id, current.workflow, "blocked");
        });
      }
      initialized = true;
    } finally { ticking = false; }
  }
  const timer = setInterval(() => { void tick().catch(error => logger.warn({ err: error }, "super individual workflow tick failed")); }, 3000);
  timer.unref();
  void tick().catch(error => logger.warn({ err: error }, "super individual initialization failed"));

  return {
    engines,
    async configureRole(companyId: string, id: string, input: { model: string; instructions: string }, userId: string) {
      const agent = await db.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, companyId))).then(rows => rows[0]);
      if (!agent || agent.metadata?.superIndividual !== true) throw notFound("协作角色不存在");
      const running = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, id), inArray(heartbeatRuns.status, ["queued", "running"])));
      if (running.length) throw conflict("请先暂停这个角色的运行任务，再修改配置");
      await lifecycle.updateConfiguration(id, { adapterConfig: { ...agent.adapterConfig, model: input.model.trim() || undefined }, metadata: { ...agent.metadata, superIndividualRoleInstructions: input.instructions.trim() } });
      await logActivity(db, { companyId, actorType: "user", actorId: userId, action: "super_individual.role.configured", entityType: "agent", entityId: id });
      return { ok: true };
    },
    async list(companyId: string) { return db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.originKind, ORIGIN))).orderBy(desc(issues.updatedAt)); },
    async get(id: string, companyId: string) {
      const { row, workflow } = await load(id, companyId);
      const children = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.parentId, id))).orderBy(issues.createdAt);
      const comments = await tasks.listComments(id);
      const runs = children.length ? await db.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.issueId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt, error: heartbeatRuns.error, summary: heartbeatRuns.resultJson, stdoutExcerpt: heartbeatRuns.stdoutExcerpt, stderrExcerpt: heartbeatRuns.stderrExcerpt }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.issueId, children.map(child => child.id)))).orderBy(desc(heartbeatRuns.createdAt)) : [];
      return { task: row, workflow, children, comments, runs };
    },
    async create(companyId: string, input: { title: string; description: string; coordinator: IndividualEngine; directory: string; projectId?: string | null; priority: string }, userId: string, workbuddyRequestId?: string) {
      const create = async () => {
        const requestDigest = individualPlanDigest({ title: input.title, description: input.description, coordinator: input.coordinator, directory: input.directory, projectId: input.projectId ?? null, priority: input.priority });
        if (workbuddyRequestId) {
          const existing = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.originKind, ORIGIN), sql`${issues.assigneeAdapterOverrides}->>'workbuddyRequestId' = ${workbuddyRequestId}`)).then(rows => rows[0]);
          if (existing) {
            if (existing.assigneeAdapterOverrides?.workbuddyRequestDigest !== requestDigest) throw conflict("此请求标识已用于其他任务内容");
            return existing;
          }
        }
        const directory = await realpath(input.directory).catch(() => { throw unprocessable("工作目录不存在，请选择本机文件夹"); });
        if (!(await stat(directory)).isDirectory()) throw unprocessable("请选择文件夹");
        if (input.projectId) { const project = await db.execute(sql`select id from projects where id = ${input.projectId}::uuid and company_id = ${companyId}::uuid`); if (!project.length) throw notFound("项目不存在"); }
        const workflow: IndividualWorkflow = { version: 1, coordinator: input.coordinator, directory, phase: "draft", stages: [], reviewRound: 0 };
        const task = await tasks.create(companyId, { title: input.title, description: input.description, projectId: input.projectId, priority: input.priority, status: "backlog", assigneeUserId: userId, responsibleUserId: userId, createdByUserId: userId, originKind: ORIGIN, assigneeAdapterOverrides: { superIndividual: workflow, ...(workbuddyRequestId ? { workbuddyRequestId, workbuddyRequestDigest: requestDigest } : {}) } });
        await record(companyId, task.id, "created", userId); return task;
      };
      return workbuddyRequestId ? serialized(`workbuddy-create:${companyId}`, create) : create();
    },
    async reportExternalResult(companyId: string, id: string, submissionId: string, result: string, artifacts: string[]) {
      return serialized(id, async () => {
        await load(id, companyId);
        const marker = `<!-- si-workbuddy-result:${submissionId} -->`;
        const body = `${marker}\nWorkBuddy 回传结果（未审查）\n\n${result}${artifacts.length ? "\n\n产出文件：\n" + artifacts.map(file => `- ${file}`).join("\n") : ""}`;
        const existing = (await tasks.listComments(id)).find(comment => comment.body.startsWith(marker));
        if (existing && existing.body !== body) throw conflict("此回传标识已用于其他结果");
        const comment = existing ?? await tasks.addComment(id, body, { userId: "local-board" });
        if (!existing) await record(companyId, id, "workbuddy_result", "local-board", { submissionId });
        return { commentId: comment.id, received: true, reviewed: false, message: "已保存到任务产出与讨论；审批和任务状态保持不变。" };
      });
    },
    async action(companyId: string, id: string, action: string, input: { revision?: string; feedback?: string; title?: string; description?: string; priority?: string; status?: string; plan?: unknown }, userId: string) {
      return serialized(id, async () => {
        const { row: root, workflow } = await load(id, companyId);
        workflow.error = null;
        if (action === "plan") {
          if (!["draft", "blocked", "plan_review"].includes(workflow.phase)) throw conflict("请先暂停当前任务");
          if (workflow.approvalId) await approval.cancel(workflow.approvalId, "重新规划，旧审批失效");
          workflow.phase = "planning"; workflow.approvedRevision = undefined; workflow.planRevision = undefined; workflow.plan = undefined; workflow.stages = [];
          await startStage(root, workflow, "planner", `plan-${workflow.stages.length}`, workflow.coordinator, `你是总控规划员。用户尚未批准执行，只能研究与读取资料，不得实现、写入工作文件、派发任务或修改父任务状态。把任务分解为可执行的步骤、必要依赖及明确产出文件。\n任务：${root.title}\n${root.description}\n用户修改意见：${input.feedback ?? "无"}\n${planFormat}`);
        } else if (action === "approve") {
          if (workflow.phase !== "plan_review" || !workflow.plan || !workflow.approvalId || input.revision !== workflow.planRevision) throw conflict("计划已变更，请检查最新版本后确认");
          const stored = await docs.getIssueDocumentByKey(id, "plan");
          if (!stored || individualPlanDigest(JSON.parse(stored.body ?? "null")) !== workflow.planRevision) throw conflict("计划文档已变更，请重新生成计划");
          await approval.approve(workflow.approvalId, userId, `用户确认计划 ${workflow.planRevision}`);
          workflow.approvedRevision = workflow.planRevision; workflow.phase = "executing";
          await save(id, workflow, "todo");
        } else if (action === "pause" || action === "cancel") {
          if (action === "pause") workflow.resumePhase = workflow.phase;
          workflow.phase = action === "cancel" ? "cancelled" : "paused";
          await save(id, workflow, action === "cancel" ? "cancelled" : "blocked");
          await stopTree(id, `super_individual_${action}`);
          for (const stage of workflow.stages) if (["running", "pending"].includes(stage.status)) stage.status = "failed";
          await save(id, workflow);
        } else if (action === "resume" || action === "retry") {
          if (!["paused", "blocked"].includes(workflow.phase)) throw conflict("任务当前无需恢复");
          const failedPlanner = workflow.stages.some(stage => stage.role === "planner" && stage.status === "failed");
          const failedReview = workflow.stages.some(stage => stage.role === "reviewer" && stage.status === "failed");
          workflow.stages = workflow.stages.filter(stage => stage.status === "done");
          if (!workflow.plan || failedPlanner) {
            workflow.phase = "planning";
            await startStage(root, workflow, "planner", `plan-${workflow.stages.length}`, workflow.coordinator, `只研究和规划，不实施或派发。\n${root.title}\n${root.description}\n${planFormat}`);
          } else { workflow.phase = workflow.approvedRevision === workflow.planRevision ? "executing" : "plan_review"; if (failedReview) workflow.feedback = "上次审查中断，请重新审查已有产出"; await save(id, workflow, "todo"); }
        } else if (action === "accept") {
          if (workflow.phase !== "acceptance") throw conflict("任务尚未完成独立审查，不能验收");
          workflow.phase = "completed"; await save(id, workflow, "done");
        } else if (action === "return") {
          if (workflow.phase !== "acceptance") throw conflict("只有待验收任务可以退回");
          if (!input.feedback?.trim()) throw unprocessable("请说明需要修改的内容");
          workflow.feedback = input.feedback; workflow.reviewRound = 0; workflow.phase = "executing"; workflow.stages = workflow.stages.filter(stage => stage.role === "planner"); await save(id, workflow, "todo");
        } else if (action === "edit") {
          if (activePhases.includes(workflow.phase)) throw conflict("请暂停任务后修改需求");
          if (workflow.approvalId) await approval.cancel(workflow.approvalId, "任务要求已修改，旧审批失效");
          workflow.approvedRevision = undefined; workflow.planRevision = undefined; workflow.plan = undefined; workflow.stages = []; workflow.phase = "draft";
          await tasks.update(id, { title: input.title ?? root.title, description: input.description ?? root.description, priority: input.priority ?? root.priority, companyGuard: companyId }); await save(id, workflow, "backlog");
        } else if (action === "move") {
          if (!["draft", "cancelled", "completed"].includes(workflow.phase)) throw conflict("执行中的任务请使用暂停、确认或验收操作");
          if (!["backlog", "todo", "cancelled"].includes(input.status ?? "")) throw conflict("任务必须完成执行和验收后才能进入该状态");
          if (input.status !== "cancelled") { workflow.approvedRevision = undefined; workflow.planRevision = undefined; workflow.plan = undefined; workflow.stages = []; }
          workflow.phase = input.status === "cancelled" ? "cancelled" : "draft"; await save(id, workflow, input.status);
        } else if (action === "comment") {
          if (!input.feedback?.trim()) throw unprocessable("请输入讨论内容");
          await tasks.addComment(id, input.feedback, { userId });
        } else throw unprocessable("未知操作");
        await record(companyId, id, action, userId, { planRevision: workflow.planRevision });
        return this.get(id, companyId);
      });
    },
    async pauseAll() {
      const rows = await db.select().from(issues).where(eq(issues.originKind, ORIGIN));
      for (const row of rows) if (activePhases.includes(readIndividualWorkflow(row.assigneeAdapterOverrides)?.phase ?? "")) await this.action(row.companyId, row.id, "pause", {}, "local-board");
    },
  };
}
export function superIndividualService(db: Db) {
  let service = instances.get(db); if (!service) { service = createService(db); instances.set(db, service); } return service;
}
