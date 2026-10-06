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
