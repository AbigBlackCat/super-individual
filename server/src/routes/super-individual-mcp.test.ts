import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const mocks = vi.hoisted(() => ({ service: { list: vi.fn(), get: vi.fn(), create: vi.fn(), reportExternalResult: vi.fn() }, companies: { list: vi.fn(), getById: vi.fn() } }));
vi.mock("../services/super-individual.js", () => ({ superIndividualService: () => mocks.service }));
vi.mock("../services/companies.js", () => ({ companyService: () => mocks.companies }));
import { superIndividualMcpRoutes } from "./super-individual-mcp.js";
const companyId = "9dfe02be-dc10-451c-8c62-dd3d616d660f";
const taskId = "815b3a50-e51d-4f94-8b68-28210118d9aa";
function app() {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "local-board" }; next(); });
  app.use(superIndividualMcpRoutes({} as never));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ error: error.message }));
  return app;
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("local si MCP authorization and human gates", () => {
  it("fails closed without the desktop capability, including malformed Unicode tokens", async () => {
    vi.stubEnv("SUPER_INDIVIDUAL_MCP_TOKEN", "a".repeat(64));
    for (const token of ["", "b".repeat(64), "é".repeat(32)]) expect((await request(app()).post("/individual-mcp/list_workspaces").set("x-si-mcp-token", token).send({})).status).toBe(403);
    expect(mocks.companies.list).not.toHaveBeenCalled();
  });
  it("only exposes company-scoped task operations and rejects approval/status fields", async () => {
    vi.stubEnv("SUPER_INDIVIDUAL_MCP_TOKEN", "a".repeat(64));
    mocks.companies.getById.mockResolvedValue({ id: companyId });
    const post = (tool: string, body: Record<string, unknown>) => request(app()).post(`/individual-mcp/${tool}`).set("x-si-mcp-token", "a".repeat(64)).send(body);
    expect((await post("approve", { companyId, taskId })).status).toBe(422);
    expect((await post("report_result", { companyId, taskId, submissionId: taskId, result: "done", status: "done" })).status).toBe(400);
    expect(mocks.service.reportExternalResult).not.toHaveBeenCalled();
    mocks.service.reportExternalResult.mockResolvedValue({ received: true, reviewed: false });
    expect((await post("report_result", { companyId, taskId, submissionId: taskId, result: "结果", artifacts: ["/tmp/result.md"] })).body).toEqual({ received: true, reviewed: false });
    expect(mocks.service.reportExternalResult).toHaveBeenCalledWith(companyId, taskId, taskId, "结果", ["/tmp/result.md"]);
    mocks.companies.getById.mockResolvedValue(null);
    expect((await post("get_task", { companyId, taskId })).status).toBe(404);
    expect(mocks.service.get).not.toHaveBeenCalled();
  });
});
