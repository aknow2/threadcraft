import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InteractionCard from "./InteractionCard";
import { api } from "./api";
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: { respondToRequest: vi.fn() },
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it("requires an explicit approval and routes it to the correct request", async () => {
  vi.mocked(api.respondToRequest).mockResolvedValue(undefined);
  render(
    <InteractionCard
      threadId="thread"
      request={{
        id: "request",
        method: "item/commandExecution/requestApproval",
        params: { command: "npm test" },
      }}
    />,
  );
  expect(api.respondToRequest).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "今回のみ許可" }));
  expect(api.respondToRequest).toHaveBeenCalledWith("thread", "request", {
    action: "accept",
    answers: {},
    content: {},
  });
});
it("preserves the answer when submission fails", async () => {
  vi.mocked(api.respondToRequest).mockRejectedValue(new Error("送信失敗"));
  render(
    <InteractionCard
      threadId="thread"
      request={{
        id: "question",
        method: "item/tool/requestUserInput",
        params: {
          questions: [
            { id: "q", question: "色は？", options: [{ label: "青" }] },
          ],
        },
      }}
    />,
  );
  await userEvent.click(screen.getByRole("radio", { name: "青" }));
  await userEvent.click(screen.getByRole("button", { name: "回答を送信" }));
  await screen.findByRole("alert");
  expect(
    (screen.getByRole("radio", { name: "青" }) as HTMLInputElement).checked,
  ).toBe(true);
  await waitFor(() =>
    expect(api.respondToRequest).toHaveBeenCalledWith("thread", "question", {
      action: "answer",
      answers: { q: "青" },
      content: {},
    }),
  );
});

it("remembers an accepted operation and answers its next approval automatically", async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>(
    "node:crypto",
  );
  vi.stubGlobal("crypto", webcrypto);
  localStorage.clear();
  vi.mocked(api.respondToRequest).mockResolvedValue(undefined);
  const scope = JSON.stringify({
    source: "source",
    cwd: "/project",
    permission: "workspace-write",
  });
  const request = {
    id: "one",
    method: "item/commandExecution/requestApproval",
    params: { command: "npm test", cwd: "/project" },
  };
  const first = render(
    <InteractionCard threadId="t" request={request} approvalScope={scope} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "許可して記憶" }));
  const { savedApprovals } = await import("./approvalPreferences");
  await waitFor(() => expect(savedApprovals()).toHaveLength(1));
  first.unmount();
  render(
    <InteractionCard
      threadId="other"
      request={{ ...request, id: "two" }}
      approvalScope={scope}
    />,
  );
  await waitFor(() =>
    expect(api.respondToRequest).toHaveBeenCalledWith(
      "other",
      "two",
      expect.objectContaining({ action: "accept" }),
    ),
  );
  expect(api.respondToRequest).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("allows a one-time approval without saving it", async () => {
  localStorage.clear();
  vi.mocked(api.respondToRequest).mockResolvedValue(undefined);
  render(
    <InteractionCard
      threadId="t"
      approvalScope='{"cwd":"/project"}'
      request={{
        id: "one",
        method: "item/commandExecution/requestApproval",
        params: { command: "npm test" },
      }}
    />,
  );
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "今回のみ許可" }));
  expect(api.respondToRequest).toHaveBeenCalledOnce();
  const { savedApprovals } = await import("./approvalPreferences");
  expect(savedApprovals()).toHaveLength(0);
});

it("remembers GitHub tool approval and maps automatic acceptance to the new question ID", async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>(
    "node:crypto",
  );
  vi.stubGlobal("crypto", webcrypto);
  localStorage.clear();
  vi.mocked(api.respondToRequest).mockResolvedValue(undefined);
  const scope = JSON.stringify({
    source: "source",
    cwd: "/project",
    permission: "read-only",
  });
  const request = {
    id: "first",
    method: "item/tool/requestUserInput",
    params: {
      toolApproval: {
        server: "codex_apps",
        tool: "github.update_issue",
        connectorId: "github",
        linkId: null,
        questionId: "q1",
        acceptLabel: "Accept",
        declineLabel: "Decline",
        cancelLabel: "Cancel",
      },
      questions: [
        {
          id: "q1",
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
  const first = render(
    <InteractionCard threadId="t" request={request} approvalScope={scope} />,
  );
  expect(screen.queryByRole("radio")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "許可して記憶" }));
  const { savedApprovals } = await import("./approvalPreferences");
  await waitFor(() => expect(savedApprovals()).toHaveLength(1));
  expect(api.respondToRequest).toHaveBeenCalledWith("t", "first", {
    action: "answer",
    answers: { q1: "Accept" },
    content: {},
  });
  first.unmount();
  const next = {
    ...request,
    id: "second",
    params: {
      ...request.params,
      toolApproval: { ...request.params.toolApproval, questionId: "q2" },
      questions: [{ ...request.params.questions[0], id: "q2" }],
    },
  };
  render(<InteractionCard threadId="t" request={next} approvalScope={scope} />);
  await waitFor(() =>
    expect(api.respondToRequest).toHaveBeenCalledWith("t", "second", {
      action: "answer",
      answers: { q2: "Accept" },
      content: {},
    }),
  );
  expect(api.respondToRequest).toHaveBeenCalledTimes(2);
});
