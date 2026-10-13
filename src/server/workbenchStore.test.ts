import { describe, expect, it } from "vitest";

import { WorkbenchStore, defaultWorkflow } from "../workbench/store.js";

describe("WorkbenchStore", () => {
  it("rolls back interrupted state and events together without notifying subscribers", () => {
    const store = new WorkbenchStore(":memory:");
    try {
      const project = store.createProject("atomic recovery");
      const target = store.createTarget(
        project.id,
        "/tmp/example",
        "directory",
      );
      const run = store.createRun({
        projectId: project.id,
        targetId: target.id,
        workflow: defaultWorkflow(),
        parameters: {},
      });
      store.updateRun(run.id, { state: "running" });
      store.appendEvent({
        runId: run.id,
        type: "step.started",
        stepInstanceId: "inventory",
      });
      const delivered: string[] = [];
      const remove = store.onRunEvent(run.id, (event) => {
        delivered.push(event.type);
      });
      expect(() =>
        store.transaction(() => {
          store.updateRun(run.id, { state: "interrupted" });
          store.appendEvent({ runId: run.id, type: "run.interrupted" });
          throw new Error("persistence failed before commit");
        }),
      ).toThrow("persistence failed");
      expect(store.getRun(run.id)?.state).toBe("running");
      expect(store.listEvents(run.id)).toHaveLength(1);
      expect(delivered).toEqual([]);
      store.transaction(() => {
        store.updateRun(run.id, { state: "interrupted" });
        store.appendEvent({ runId: run.id, type: "run.interrupted" });
      });
      expect(delivered).toEqual(["run.interrupted"]);
      expect(store.listSteps(run.id)[0]?.state).toBe("interrupted");
      remove();
    } finally {
      store.close();
    }
  });
  it("persists ordered run events and projects step state", () => {
    const store = new WorkbenchStore(":memory:");
    const project = store.createProject("test project");
    const target = store.createTarget(project.id, "/tmp/example", "directory");
    const workflow = defaultWorkflow();
    const run = store.createRun({
      projectId: project.id,
      targetId: target.id,
      workflow,
      parameters: {
        input_path: "/tmp/example",
        format: "directory",
        integrity_policy: "fail",
      },
    });

    store.appendEvent({
      runId: run.id,
      type: "step.started",
      stepInstanceId: "inventory",
      payload: { step_definition_id: "inventory", name: "建立目标快照" },
    });
    store.appendEvent({
      runId: run.id,
      type: "step.progress",
      stepInstanceId: "inventory",
      payload: {
        phase: "inventory",
        completed: 1,
        total: 2,
        message: "读取文件",
      },
    });
    store.appendEvent({
      runId: run.id,
      type: "step.finished",
      stepInstanceId: "inventory",
      payload: { state: "succeeded" },
    });

    expect(store.listEvents(run.id).map((event) => event.sequence)).toEqual([
      1, 2, 3,
    ]);
    expect(store.listEvents(run.id, 1)).toHaveLength(2);
    expect(store.listSteps(run.id)).toMatchObject([
      {
        stepInstanceId: "inventory",
        state: "succeeded",
        completed: 1,
        total: 2,
        message: "读取文件",
      },
    ]);
    store.close();
  });

  it("binds an idempotency key to one run and cascades it away with the run", () => {
    const store = new WorkbenchStore(":memory:");
    const project = store.createProject("idempotent project");
    const target = store.createTarget(project.id, "/tmp/example", "directory");
    const run = store.createRun({
      projectId: project.id,
      targetId: target.id,
      workflow: defaultWorkflow(),
      parameters: {},
    });

    store.recordRunIdempotency("contract-key", "digest-a", run.id);
    expect(store.findRunIdempotency("contract-key")).toEqual({
      runId: run.id,
      requestDigest: "digest-a",
    });
    expect(store.findRunIdempotency("other-key")).toBeNull();
    expect(() =>
      store.recordRunIdempotency("contract-key", "digest-b", run.id),
    ).toThrowError();

    store.deleteRun(run.id);
    expect(store.getRun(run.id)).toBeNull();
    expect(store.findRunIdempotency("contract-key")).toBeNull();
    store.close();
  });
});
