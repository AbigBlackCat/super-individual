import { z } from "zod";

export const individualEngines = ["claude", "codex"] as const;
export type IndividualEngine = typeof individualEngines[number];
export const individualStepSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(6000),
  kind: z.enum(["coding", "research", "writing", "document"]),
  engine: z.enum(individualEngines).optional(),
  dependsOn: z.array(z.string()).max(12).default([]),
});
export const individualPlanSchema = z.object({
  summary: z.string().min(1).max(6000),
  acceptance: z.string().min(1).max(6000),
  steps: z.array(individualStepSchema).min(1).max(12),
}).superRefine((plan, context) => {
  const keys = new Set(plan.steps.map(step => step.key));
  if (keys.size !== plan.steps.length) context.addIssue({ code: "custom", message: "子任务标识不能重复" });
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(key: string): boolean {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    const step = plan.steps.find(item => item.key === key);
    for (const dependency of step?.dependsOn ?? []) {
      if (!keys.has(dependency) || !visit(dependency)) return false;
    }
    visiting.delete(key); visited.add(key); return true;
  }
  if (plan.steps.some(step => !visit(step.key))) context.addIssue({ code: "custom", message: "依赖必须存在，且不能形成循环" });
});
export type IndividualPlan = z.infer<typeof individualPlanSchema>;
export const individualCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(30000).default(""),
  coordinator: z.enum(individualEngines),
  directory: z.string().min(1).max(4096),
  projectId: z.string().uuid().nullable().optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
});
export type IndividualPhase = "draft" | "planning" | "plan_review" | "executing" | "reviewing" | "acceptance" | "completed" | "paused" | "blocked" | "cancelled";
export interface IndividualStage {
  issueId: string;
  key: string;
  role: "planner" | "worker" | "reviewer";
  engine: IndividualEngine;
  agentId?: string;
  runId?: string | null;
  result?: string;
  status: "pending" | "running" | "done" | "failed";
}
export interface IndividualWorkflow {
  version: 1;
  coordinator: IndividualEngine;
  directory: string;
  phase: IndividualPhase;
  resumePhase?: IndividualPhase;
  plan?: IndividualPlan;
  planRevision?: string;
  approvedRevision?: string;
  approvalId?: string;
  stages: IndividualStage[];
  reviewRound: number;
  error?: string | null;
  feedback?: string;
}
export function readIndividualWorkflow(value: unknown): IndividualWorkflow | null {
  if (!value || typeof value !== "object") return null;
  const workflow = (value as Record<string, unknown>).superIndividual;
  if (!workflow || typeof workflow !== "object" || (workflow as IndividualWorkflow).version !== 1) return null;
  return workflow as IndividualWorkflow;
}
export function readyIndividualSteps(workflow: IndividualWorkflow) {
  if (!workflow.plan || !workflow.planRevision || !workflow.approvedRevision || workflow.phase !== "executing" || workflow.approvedRevision !== workflow.planRevision) return [];
  return workflow.plan.steps.filter(step => {
    const own = workflow.stages.find(stage => stage.role === "worker" && stage.key === step.key);
    return !own && step.dependsOn.every(key => workflow.stages.some(stage => stage.role === "worker" && stage.key === key && stage.status === "done"));
  });
}
