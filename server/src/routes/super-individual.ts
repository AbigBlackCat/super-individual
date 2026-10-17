import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { individualCreateSchema, readIndividualWorkflow } from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import { superIndividualService } from "../services/super-individual.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { conflict } from "../errors.js";
import { superIndividualMcpRoutes } from "./super-individual-mcp.js";

export function superIndividualRoutes(db: Db) {
  const router = Router();
  const service = superIndividualService(db);
  router.use(superIndividualMcpRoutes(db));
  router.use("/individual", (req, _res, next) => { assertBoard(req); next(); });
  router.get("/individual/engines", async (req, res) => res.json(await service.engines(req.query.refresh === "true")));
  router.post("/individual/pause-all", async (_req, res) => { await service.pauseAll(); res.json({ ok: true }); });
  router.use("/individual/:companyId", (req, _res, next) => { assertCompanyAccess(req, req.params.companyId); next(); });
  router.post("/individual/:companyId/roles/:id", validate(z.object({ model: z.string().max(100), instructions: z.string().max(6000) })), async (req, res) => res.json(await service.configureRole(String(req.params.companyId), String(req.params.id), req.body, req.actor.userId ?? "local-board")));
  router.get("/individual/:companyId/tasks", async (req, res) => res.json(await service.list(String(req.params.companyId))));
  router.post("/individual/:companyId/tasks", validate(individualCreateSchema), async (req, res) => res.status(201).json(await service.create(String(req.params.companyId), req.body, req.actor.userId ?? "local-board")));
  router.get("/individual/:companyId/tasks/:id", async (req, res) => res.json(await service.get(String(req.params.id), String(req.params.companyId))));
  router.post("/individual/:companyId/tasks/:id/:action", validate(z.object({ revision: z.string().optional(), feedback: z.string().max(30000).optional(), title: z.string().min(1).max(200).optional(), description: z.string().max(30000).optional(), priority: z.enum(["critical", "high", "medium", "low"]).optional(), status: z.string().optional() })), async (req, res) => res.json(await service.action(String(req.params.companyId), String(req.params.id), String(req.params.action), req.body, req.actor.userId ?? "local-board")));

  // The legacy task API remains available, but cannot bypass the personal task's approval/acceptance gates.
  router.use("/issues/:id", async (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const task = await issueService(db).getById(String(req.params.id));
    if (task && readIndividualWorkflow(task.assigneeAdapterOverrides) && (req.method === "PATCH" || req.method === "DELETE" || req.path.startsWith("/documents/plan"))) throw conflict("请通过 super individual 的任务操作确认计划、修改需求或验收结果");
    next();
  });
  router.post("/companies/:companyId/issues", async (req, _res, next) => {
    if (req.body.parentId) {
      const parent = await issueService(db).getById(String(req.body.parentId));
      if (parent && (readIndividualWorkflow(parent.assigneeAdapterOverrides) || parent.originKind === "plugin:super-individual-stage")) throw conflict("个人任务的子任务由已确认的计划派发");
    }
    next();
  });
  return router;
}
