import { runWriteTool } from "./chat-write-tools";
import * as agentRunsRepo from "../repositories/agentRuns";

jest.mock("../repositories/agentRuns");

describe("runWriteTool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(agentRunsRepo.insertAgentRun)
      .mockResolvedValue({ id: "agent-run-stub-1" } as never);
  });

  it("executes immediately when reversible (gate auto-approves)", async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const outcome = await runWriteTool(
      {
        name: "retry_thing",
        describe: () => "retry thing 1",
        reversible: () => true,
        execute,
      },
      { id: "1" },
      { companyId: "co-1" },
    );
    expect(outcome.status).toBe("executed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(agentRunsRepo.insertAgentRun).not.toHaveBeenCalled();
  });

  it("queues for approval when the action is irreversible", async () => {
    const execute = jest.fn();
    const outcome = await runWriteTool(
      {
        name: "amend_thing",
        describe: () => "amend thing 2",
        reversible: () => false,
        execute,
      },
      { id: "2" },
      { companyId: "co-1", userId: "user-1" },
    );
    expect(outcome.status).toBe("queued_for_approval");
    if (outcome.status === "queued_for_approval") {
      expect(outcome.agentRunId).toBe("agent-run-stub-1");
      expect(outcome.flags.some((f) => f.kind === "irreversible_action")).toBe(true);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(agentRunsRepo.insertAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co-1",
        operation: expect.objectContaining({
          kind: "chat_tool_fix",
          tool: "amend_thing",
        }),
      }),
    );
  });

  it("auto-approves transient retries via the fast-path", async () => {
    const execute = jest.fn(async () => ({ retried: true }));
    const outcome = await runWriteTool(
      {
        name: "retry_bulk_row",
        describe: () => "retry row",
        reversible: () => true,
        autoApprove: async () => true,
        execute,
      },
      { runId: "r1", rowIndex: 0 },
      { companyId: "co-1" },
    );
    expect(outcome.status).toBe("executed");
    if (outcome.status === "executed") {
      expect(outcome.summary).toMatch(/transient/i);
      expect(outcome.result).toEqual({ retried: true });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("falls back to the normal gate when autoApprove returns false", async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const outcome = await runWriteTool(
      {
        name: "retry_bulk_row",
        describe: () => "retry row",
        reversible: () => true,
        autoApprove: async () => false,
        execute,
      },
      { runId: "r1", rowIndex: 0 },
      { companyId: "co-1" },
    );
    expect(outcome.status).toBe("executed"); // reversible → gate approves
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("survives an autoApprove probe error and falls through to the gate", async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const outcome = await runWriteTool(
      {
        name: "retry_bulk_row",
        describe: () => "retry row",
        reversible: () => true,
        autoApprove: async () => {
          throw new Error("DB down");
        },
        execute,
      },
      { runId: "r1", rowIndex: 0 },
      { companyId: "co-1" },
    );
    expect(outcome.status).toBe("executed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns a status:error result when queue persistence fails", async () => {
    jest
      .mocked(agentRunsRepo.insertAgentRun)
      .mockRejectedValueOnce(new Error("pg connection refused"));
    const execute = jest.fn();
    const outcome = await runWriteTool(
      {
        name: "amend_thing",
        describe: () => "amend thing 2",
        reversible: () => false,
        execute,
      },
      { id: "2" },
      { companyId: "co-1" },
    );
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.error).toMatch(/connection refused/);
    }
  });
});
