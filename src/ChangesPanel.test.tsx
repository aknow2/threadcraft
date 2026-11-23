import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChangesPanel, { diffLines } from "./ChangesPanel";
import type { ChatMessage } from "./api";

afterEach(cleanup);
const change: ChatMessage = {
  id: '["turn","edit"]',
  role: "activity",
  text: "ファイル変更",
  fileChange: {
    status: "completed",
    changes: [
      {
        path: "src/app.ts",
        kind: { type: "update", move_path: "src/main.ts" },
        diff: "--- a/src/app.ts\n+++ b/src/main.ts\n@@ -1,2 +1,2 @@\n-const old = 1;\n+const next = 2;\n unchanged\n\\ No newline at end of file",
      },
    ],
  },
};
it("counts patch body lines and tracks old/new numbers across hunks", () => {
  const lines = diffLines(
    change.fileChange!.changes[0].diff + "\n@@ -20 +30,2 @@\n stay\n+extra",
  );
  expect(
    lines.filter((line) => line.type === "add").map((line) => line.next),
  ).toEqual([1, 31]);
  expect(
    lines.filter((line) => line.type === "delete").map((line) => line.old),
  ).toEqual([1]);
  expect(lines.find((line) => line.text === " unchanged")).toMatchObject({
    old: 2,
    next: 2,
  });
});
it("opens safe text diffs, deduplicates live updates and labels unapplied changes", async () => {
  render(
    <ChangesPanel
      messages={[
        change,
        {
          ...change,
          fileChange: { ...change.fileChange!, status: "declined" },
        },
      ]}
      hasMore={false}
      loading={false}
      onMore={() => {}}
      onClose={() => {}}
    />,
  );
  expect(screen.getAllByText("却下")).toHaveLength(1);
  expect(screen.queryByText("適用済み")).toBeNull();
  expect(screen.queryByText("-const old = 1;")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /src\/app.ts/ }));
  expect(
    screen.getByText("-const old = 1;").closest(".diff-line")?.className,
  ).toContain("diff-delete");
  expect(
    screen.getByText("+const next = 2;").closest(".diff-line")?.className,
  ).toContain("diff-add");
});
it("exposes older-history loading and close actions with an empty state", async () => {
  const more = vi.fn();
  const close = vi.fn();
  render(
    <ChangesPanel
      messages={[]}
      hasMore
      loading={false}
      onMore={more}
      onClose={close}
    />,
  );
  expect(
    screen.getByText("読み込んだ履歴にファイル変更はありません。"),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "以前の履歴から変更を読み込む" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "差分パネルを閉じる" }),
  );
  expect(more).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it("keeps markup inert and reports missing patch content", async () => {
  const unsafe = {
    ...change,
    fileChange: {
      status: "failed",
      changes: [
        {
          path: "<script>example</script>",
          kind: { type: "add" },
          diff: "@@ -0,0 +1 @@\n+<img src=x onerror=alert(1)>",
        },
        { path: "empty.bin", kind: { type: "delete" }, diff: "" },
      ],
    },
  };
  const { container } = render(
    <ChangesPanel
      messages={[unsafe]}
      hasMore={false}
      loading={false}
      onMore={() => {}}
      onClose={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /<script>/ }));
  expect(container.querySelector("img,script")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /empty.bin/ }));
  expect(screen.getByText("差分の本文が記録されていません。")).toBeTruthy();
});
