import { describe, expect, it } from "vitest";
import { individualPlanSchema, readyIndividualSteps, type IndividualWorkflow } from "@paperclipai/shared";
import { individualStageOverrides, individualClaudeEnvironment } from "./super-individual-policy.js";
import { parseIssueAssigneeAdapterOverrides } from "./execution-workspace-policy.js";
const step = (key: string, dependsOn: string[] = []) => ({ key, title: key, description: key, kind: "coding" as const, dependsOn });
const plan = { summary: "计划", acceptance: "文件正确", steps: [step("a"), step("b", ["a"])] };
const workflow: IndividualWorkflow = { version: 1, coordinator: "claude", directory: "/tmp", phase: "executing", plan, planRevision: "v1", approvedRevision: "v1", stages: [], reviewRound: 0 };
describe("super individual execution gate", () => {
  it("applies only an explicitly configured HTTP proxy to Claude", () => {
    expect(individualClaudeEnvironment()).toEqual({});
    expect(individualClaudeEnvironment("http://127.0.0.1:7897")).toEqual({ HTTP_PROXY: "http://127.0.0.1:7897", HTTPS_PROXY: "http://127.0.0.1:7897", ALL_PROXY: "http://127.0.0.1:7897" });
    expect(() => individualClaudeEnvironment("socks5h://127.0.0.1:7897")).toThrow(/HTTP/);
  });
  it("passes each task directory through Paperclip's actual override parser", () => {
    for (const directory of ["/tmp/task-a", "/tmp/task-b"]) {
      const parsed = parseIssueAssigneeAdapterOverrides(individualStageOverrides(directory));
      expect(parsed?.adapterConfig?.cwd).toBe(directory);
      expect(parsed?.useProjectWorkspace).toBe(false);
    }
  });
  it("rejects cycles, absent dependencies and duplicate keys", () => {
    for (const steps of [[step("a", ["b"]), step("b", ["a"])], [step("a", ["missing"])], [step("a"), step("a")]]) expect(individualPlanSchema.safeParse({ ...plan, steps }).success).toBe(false);
  });
  it("does not dispatch before approval or after a plan revision", () => {
    expect(readyIndividualSteps({ ...workflow, approvedRevision: undefined })).toEqual([]);
    expect(readyIndividualSteps({ ...workflow, approvedRevision: "old" })).toEqual([]);
    expect(readyIndividualSteps({ ...workflow, phase: "paused" })).toEqual([]);
  });
  it("releases dependents only after completion, without duplicating completed work", () => {
    expect(readyIndividualSteps(workflow).map(item => item.key)).toEqual(["a"]);
    expect(readyIndividualSteps({ ...workflow, stages: [{ key: "a", issueId: "1", role: "worker", engine: "codex", status: "running" }] })).toEqual([]);
    expect(readyIndividualSteps({ ...workflow, stages: [{ key: "a", issueId: "1", role: "worker", engine: "codex", status: "done" }] }).map(item => item.key)).toEqual(["b"]);
  });
});
