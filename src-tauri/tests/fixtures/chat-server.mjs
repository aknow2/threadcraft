#!/usr/bin/env node
// Deterministic protocol fixture. Never contacts a model or reads real sessions.
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.153.4");
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const event = (method, params) => send({ method, params });
const turn = { id: "turn-owned", status: "inProgress", items: [] };
let resumedModel;
let resumedSandbox;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const p = request.params;
  switch (request.method) {
    case "initialize":
      send({ id: request.id, result: {} });
      break;
    case "initialized": break;
    case "model/list":
      assert.equal(p.includeHidden, false);
      send({ id: request.id, result: {
        data: p.cursor ? [{ model: "plain-model", displayName: "Plain", defaultReasoningEffort: "none", supportedReasoningEfforts: [], isDefault: false }] : [{
          id: "catalog-id", model: "test-model", displayName: "Test", defaultReasoningEffort: "low",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "Thorough" }], isDefault: true
        }], nextCursor: p.cursor ? null : "page-two"
      } });
      break;
    case "thread/fork":
      assert.equal(p.threadId, "thread-test");
      assert.equal(p.ephemeral, false);
      assert.equal(p.excludeTurns, true);
      assert.equal(p.deferGoalContinuation, true);
      send({ id: request.id, result: { thread: { id: "forked-thread", name: "分岐元の会話", preview: "", cwd: "/new-workspace", createdAt: 20, updatedAt: 20 } } });
      break;
    case "thread/start":
      assert.equal(p.cwd, "/new-workspace");
      assert.equal(p.ephemeral, false);
      assert.ok(["read-only", "workspace-write", "danger-full-access"].includes(p.sandbox));
      resumedSandbox = p.sandbox;
      assert.equal(p.approvalsReviewer, "user");
      assert.equal(p.threadId, undefined);
      resumedModel = p.model;
      send({ id: request.id, result: { thread: { id: "thread-test", cwd: "/new-workspace", status: { type: "idle" } } } });
      break;
    case "thread/resume":
      resumedModel = p.model;
      if (p.threadId === "writer-conflict") {
        send({ id: request.id, error: { code: -32600, message: "thread writer-conflict already has an active writer" } });
        break;
      }
      assert.equal(p.threadId, "thread-test");
      assert.ok(["read-only", "workspace-write", "danger-full-access"].includes(p.sandbox));
      resumedSandbox = p.sandbox;
      assert.equal(p.approvalsReviewer, "user");
      send({ id: request.id, result: { thread: { id: p.threadId, cwd: "/new-workspace", status: { type: "idle" } } } });
      break;
    case "turn/start": {
      assert.equal(p.threadId, "thread-test");
      const scenario = p.input.find((item) => item.type === "text")?.text ?? "images";
      if (scenario === "images") assert.deepEqual(p.input, [{ type: "image", url: "data:image/png;base64,aGVsbG8=" }]);
      const expectedPermission = scenario.startsWith("permission:")
        ? scenario.slice("permission:".length) : "read-only";
      assert.equal(resumedSandbox, expectedPermission);
      const policies = {
        "read-only": { type: "readOnly", networkAccess: false },
        "workspace-write": { type: "workspaceWrite", writableRoots: ["/new-workspace"], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        "danger-full-access": { type: "dangerFullAccess" },
      };
      assert.deepEqual(p.sandboxPolicy, policies[expectedPermission]);
      assert.equal(p.approvalPolicy, "on-request");
      assert.deepEqual(p.environments, [{ environmentId: "local", cwd: "/new-workspace" }]);
      event("turn/started", { threadId: p.threadId, turn });
      event("item/agentMessage/delta", { threadId: "foreign", turnId: turn.id, itemId: "a", delta: "MUST NOT DISPLAY" });
      event("item/agentMessage/delta", { threadId: p.threadId, turnId: turn.id, itemId: "a", delta: "こん" });
      send({ id: request.id, result: { turn } });

      if (scenario === "selected-model") {
        assert.equal(resumedModel, "test-model");
        assert.equal(p.model, "test-model");
        assert.equal(p.effort, "high");
      } else {
        assert.equal(resumedModel, undefined);
        assert.equal(p.model, undefined);
        assert.equal(p.effort, undefined);
      }
      if (scenario === "disconnect") process.exit(0);
      if (scenario === "stop" || scenario === "steer") break;
      if (scenario === "approval") {
        send({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: p.threadId, turnId: turn.id } });
        break;
      }
      event("item/agentMessage/delta", { threadId: p.threadId, turnId: turn.id, itemId: "a", delta: "にちは" });
      event("item/completed", { threadId: p.threadId, turnId: turn.id, item: { id: "a", type: "agentMessage", text: "こんにちは" } });
      event("turn/completed", { threadId: p.threadId, turn: { ...turn, status: "completed" } });
      break;
    }
    case "turn/steer":
      assert.equal(p.threadId, "thread-test");
      assert.equal(p.expectedTurnId, turn.id);
      assert.equal(p.input[0].text, "追加指示");
      send({ id: request.id, result: { turnId: turn.id } });
      event("turn/completed", { threadId: p.threadId, turn: { ...turn, status: "completed" } });
      break;
    case "turn/interrupt":
      assert.equal(p.turnId, turn.id);
      assert.equal(p.threadId, "thread-test");
      send({ id: request.id, result: {} });
      event("turn/completed", { threadId: p.threadId, turn: { ...turn, status: "interrupted" } });
      break;
    default:
      // Unsupported server requests must get an error, never an approval.
      assert.equal(request.id, 77);
      if (request.result) {
        assert.ok(["accept", "decline"].includes(request.result.decision));
        event("turn/completed", { threadId: "thread-test", turn: { ...turn, status: "completed" } });
      } else { assert.ok(request.error); }
  }
}
