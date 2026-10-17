import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { individualCreateSchema, readIndividualWorkflow } from "@paperclipai/shared";
import { companyService } from "../services/companies.js";
import { superIndividualService } from "../services/super-individual.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { forbidden, notFound, unprocessable } from "../errors.js";

const scope = z.object({ companyId: z.string().uuid() });
const taskScope = scope.extend({ taskId: z.string().uuid() });
function taskView(task: Awaited<ReturnType<ReturnType<typeof superIndividualService>["list"]>>[number]) {
  const workflow = readIndividualWorkflow(task.assigneeAdapterOverrides);
  return { id: task.id, identifier: task.identifier, title: task.title, description: task.description, status: task.status, priority: task.priority, projectId: task.projectId, coordinator: workflow?.coordinator, directory: workflow?.directory, phase: workflow?.phase, updatedAt: task.updatedAt };
}

export function superIndividualMcpRoutes(db: Db) {
  const router = Router();
  const service = superIndividualService(db);
  const companies = companyService(db);
  router.post("/individual-mcp/:tool", async (req, res) => {
    assertBoard(req);
    const token = process.env.SUPER_INDIVIDUAL_MCP_TOKEN;
    const supplied = req.header("x-si-mcp-token") ?? "";
    if (req.actor.source !== "local_implicit" || !token || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw forbidden("本地 MCP 连接未授权，请重新打开 super individual");
    res.set("Cache-Control", "no-store");
    const tool = String(req.params.tool);
    if (tool === "list_workspaces") {
      z.object({}).strict().parse(req.body);
      return res.json((await companies.list()).map(company => ({ id: company.id, name: company.name })));
    }
    const { companyId } = scope.parse(req.body);
    assertCompanyAccess(req, companyId);
    if (!await companies.getById(companyId)) throw notFound("工作区不存在");
    if (tool === "list_tasks") {
      const input = scope.extend({ search: z.string().max(200).optional(), status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict().parse(req.body);
      const rows = (await service.list(companyId)).filter(task => (!input.status || task.status === input.status) && (!input.search || `${task.identifier} ${task.title} ${task.description ?? ""}`.toLowerCase().includes(input.search.toLowerCase())));
      return res.json({ tasks: rows.slice(input.offset, input.offset + input.limit).map(taskView), total: rows.length, nextOffset: input.offset + input.limit < rows.length ? input.offset + input.limit : null });
    }
    if (tool === "get_task") {
      const input = taskScope.strict().parse(req.body);
      const detail = await service.get(input.taskId, companyId);
      return res.json({ task: taskView(detail.task), plan: detail.workflow.plan ?? null, approvedRevision: detail.workflow.approvedRevision ?? null, error: detail.workflow.error ?? null, children: detail.children.map(child => ({ id: child.id, title: child.title, status: child.status })), comments: detail.comments.map(comment => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt })), outputs: detail.workflow.stages.filter(stage => stage.result).map(stage => ({ role: stage.role, result: stage.result })) });
    }
    if (tool === "create_task") {
      const input = individualCreateSchema.extend({ directory: z.string().min(1).max(4096).refine(value => path.isAbsolute(value), "工作目录须为本机绝对路径"), companyId: z.string().uuid(), requestId: z.string().uuid() }).strict().parse(req.body);
      return res.status(201).json(taskView(await service.create(companyId, input, "local-board", input.requestId)));
    }
    if (tool === "report_result") {
      const input = taskScope.extend({ submissionId: z.string().uuid(), result: z.string().trim().min(1).max(20000), artifacts: z.array(z.string().max(4096).refine(value => path.isAbsolute(value) && !/[\r\n]/.test(value), "产出路径须为本机绝对路径")).max(20).default([]) }).strict().parse(req.body);
      return res.json(await service.reportExternalResult(companyId, input.taskId, input.submissionId, input.result, input.artifacts));
    }
    throw unprocessable("此 MCP 工具不可用；计划确认和最终验收只能在看板中操作");
  });
  return router;
}
