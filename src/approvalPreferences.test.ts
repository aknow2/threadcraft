import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  approvalScope,
  hasSavedApproval,
  rememberApproval,
  savedApprovals,
  forgetApproval,
  canRememberApproval,
} from "./approvalPreferences";
import type { InteractionRequest, Thread } from "./api";
const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>(
  "node:crypto",
);
const thread: Thread = {
  id: '["source","first"]',
  cwd: "/project",
  title: "会話",
  createdAt: 0,
  archived: false,
  groupId: null,
  position: 0,
};
const scope = approvalScope(thread, "workspace-write");
const request: InteractionRequest = {
  id: "one",
  method: "item/commandExecution/requestApproval",
  params: { command: "npm test", cwd: "/project" },
};
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => vi.unstubAllGlobals());
it("remembers exact operations across threads, request IDs, and reloads", async () => {
  expect(await hasSavedApproval(scope, request)).toBe(false);
  expect(await rememberApproval(scope, request)).toBe(true);
  const otherScope = approvalScope(
    { ...thread, id: '["source","second"]' },
    "workspace-write",
  );
  expect(
    await hasSavedApproval(otherScope, {
      ...request,
      id: "two",
      params: { ...request.params, reason: "again" },
    }),
  ).toBe(true);
  expect(savedApprovals()).toHaveLength(1);
  expect(forgetApproval(savedApprovals()[0].key)).toBe(true);
  expect(await hasSavedApproval(scope, request)).toBe(false);
});
it("does not reuse grants for changed commands, folders, permissions, or extra request fields", async () => {
  await rememberApproval(scope, request);
  expect(
    await hasSavedApproval(scope, {
      ...request,
      params: { ...request.params, command: "npm test && npm publish" },
    }),
  ).toBe(false);
  expect(
    await hasSavedApproval(scope, {
      ...request,
      params: { ...request.params, cwd: "/other" },
    }),
  ).toBe(false);
  expect(
    await hasSavedApproval(
      approvalScope({ ...thread, cwd: "/other" }, "workspace-write"),
      request,
    ),
  ).toBe(false);
  expect(
    await hasSavedApproval(
      approvalScope(thread, "danger-full-access"),
      request,
    ),
  ).toBe(false);
  expect(
    await hasSavedApproval(
      approvalScope(
        { ...thread, id: '["other-source","one"]' },
        "workspace-write",
      ),
      request,
    ),
  ).toBe(false);
  expect(
    await hasSavedApproval(scope, {
      ...request,
      params: {
        ...request.params,
        additionalPermissions: { network: { enabled: true } },
      },
    }),
  ).toBe(false);
});
it("matches file edits only when their patch content matches", async () => {
  const file: InteractionRequest = {
    id: "file",
    method: "item/fileChange/requestApproval",
    params: {
      changes: [
        { path: "/project/a", kind: { type: "update" }, diff: "+original" },
      ],
    },
  };
  expect(await rememberApproval(scope, file)).toBe(true);
  expect(await hasSavedApproval(scope, file)).toBe(true);
  expect(
    await hasSavedApproval(scope, {
      ...file,
      params: {
        changes: [
          { path: "/project/a", kind: { type: "update" }, diff: "+different" },
        ],
      },
    }),
  ).toBe(false);
});
it("never replays questions, MCP forms, unknown operations or prohibited decisions", async () => {
  for (const method of [
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "unknown",
  ]) {
    expect(canRememberApproval({ ...request, method })).toBe(false);
    expect(await rememberApproval(scope, { ...request, method })).toBe(false);
  }
  expect(
    await hasSavedApproval(scope, {
      ...request,
      params: { ...request.params, availableDecisions: ["decline"] },
    }),
  ).toBe(false);
  expect(canRememberApproval({ ...request, params: {} })).toBe(false);
  expect(
    canRememberApproval({
      ...request,
      method: "item/fileChange/requestApproval",
      params: {},
    }),
  ).toBe(false);
});
it("does not treat broken storage or failed writes as a remembered permission", async () => {
  localStorage.setItem("treadcraft.approvals.v1", "corrupt");
  expect(await hasSavedApproval(scope, request)).toBe(false);
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("full");
    });
  expect(await rememberApproval(scope, request)).toBe(false);
  write.mockRestore();
});

const toolRequest: InteractionRequest = {
  id: "tool-one",
  method: "item/tool/requestUserInput",
  params: {
    toolApproval: {
      server: "codex_apps",
      tool: "github.update_issue",
      connectorId: "github",
      linkId: "account-one",
      questionId: "q",
      acceptLabel: "Accept",
      declineLabel: "Decline",
      cancelLabel: "Cancel",
    },
    questions: [
      {
        id: "q",
        question: 'Allow GitHub to run tool "github.update_issue"?',
        options: [
          { label: "Accept" },
          { label: "Decline" },
          { label: "Cancel" },
        ],
      },
    ],
  },
};
it("remembers a specific connector tool across arguments and workspaces, but not other tools or accounts", async () => {
  const { saveToolApprovalMode } = await import("./approvalPreferences");
  expect(await rememberApproval(scope, toolRequest)).toBe(true);
  const otherScope = approvalScope(
    { ...thread, cwd: "/different-project" },
    "read-only",
  );
  expect(
    await hasSavedApproval(otherScope, {
      ...toolRequest,
      id: "tool-two",
      params: { ...toolRequest.params, reason: "Update another issue" },
    }),
  ).toBe(true);
  for (const patch of [
    { tool: "github.delete_issue" },
    { server: "other" },
    { connectorId: "another" },
    { linkId: "account-two" },
  ]) {
    expect(
      await hasSavedApproval(scope, {
        ...toolRequest,
        params: {
          ...toolRequest.params,
          toolApproval: { ...toolRequest.params.toolApproval!, ...patch },
        },
      }),
    ).toBe(false);
  }
  saveToolApprovalMode("ask");
  expect(await hasSavedApproval(scope, toolRequest)).toBe(false);
  saveToolApprovalMode("remember");
  expect(await hasSavedApproval(scope, toolRequest)).toBe(true);
  forgetApproval(savedApprovals()[0].key);
  expect(await hasSavedApproval(scope, toolRequest)).toBe(false);
});
