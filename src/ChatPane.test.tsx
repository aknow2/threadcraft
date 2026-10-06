import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatPane from "./ChatPane";
import { api, type ChatPage, type Thread, type ModelOption } from "./api";
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: {
    readThread: vi.fn(),
    listModels: vi.fn(),
    sendMessage: vi.fn(),
    stopMessage: vi.fn(),
    steerMessage: vi.fn(),
    forkThread: vi.fn(),
    markThreadRead: vi.fn(),
  },
}));
const thread: Thread = {
  id: "a",
  title: "会話A",
  createdAt: 0,
  cwd: "",
  archived: false,
  groupId: null,
  position: 0,
};
beforeEach(() => {
  vi.mocked(api.listModels).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const modelFixture: ModelOption[] = [
  {
    model: "test-model",
    displayName: "Test Model",
    defaultReasoningEffort: "low",
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "high", description: "Thorough" },
    ],
  },
  {
    model: "other-model",
    displayName: "Other Model",
    defaultReasoningEffort: "medium",
    isDefault: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
    ],
  },
];

it("sends selected settings and allows editing the next draft while sending", async () => {
  vi.mocked(api.listModels).mockResolvedValue(modelFixture);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  let finish!: (status: string) => void;
  vi.mocked(api.sendMessage).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<ChatPane thread={thread} close={() => {}} />);
  await screen.findByRole("option", { name: "Test Model（標準）" });
  await user.selectOptions(screen.getByLabelText("モデル"), "test-model");
  expect(
    (screen.getByLabelText("推論強度（グレード）") as HTMLSelectElement).value,
  ).toBe("low");
  await user.selectOptions(
    screen.getByLabelText("推論強度（グレード）"),
    "high",
  );
  await user.selectOptions(
    screen.getByLabelText("実行権限", { exact: false }),
    "workspace-write",
  );
  await user.type(screen.getByLabelText("メッセージ"), "質問");
  await user.click(screen.getByRole("button", { name: "送信" }));
  expect(api.sendMessage).toHaveBeenCalledWith(
    "a",
    "質問",
    expect.any(Function),
    { model: "test-model", effort: "high", permission: "workspace-write" },
  );
  expect((screen.getByLabelText("モデル") as HTMLSelectElement).disabled).toBe(
    false,
  );
  expect(
    (screen.getByLabelText("推論強度（グレード）") as HTMLSelectElement)
      .disabled,
  ).toBe(false);
  expect(
    (screen.getByRole("combobox", { name: /実行権限/ }) as HTMLSelectElement)
      .disabled,
  ).toBe(false);
  expect(
    (screen.getByLabelText("メッセージ") as HTMLTextAreaElement).value,
  ).toBe("");
  await user.type(screen.getByLabelText("メッセージ"), "次の質問");
  await user.selectOptions(
    screen.getByRole("combobox", { name: /実行権限/ }),
    "read-only",
  );
  await act(async () => finish("completed"));
  expect(
    (screen.getByLabelText("メッセージ") as HTMLTextAreaElement).value,
  ).toBe("次の質問");
  expect(api.sendMessage).toHaveBeenCalledTimes(1);
});

it("resets effort to supported default when changing model", async () => {
  vi.mocked(api.listModels).mockResolvedValue(modelFixture);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  const change = vi.fn();
  const user = userEvent.setup();
  render(
    <ChatPane thread={thread} close={() => {}} onOptionsChange={change} />,
  );
  await screen.findByRole("option", { name: "Test Model（標準）" });
  await user.selectOptions(screen.getByLabelText("モデル"), "test-model");
  await user.selectOptions(
    screen.getByLabelText("推論強度（グレード）"),
    "high",
  );
  await user.selectOptions(screen.getByLabelText("モデル"), "other-model");
  expect(
    (screen.getByLabelText("推論強度（グレード）") as HTMLSelectElement).value,
  ).toBe("medium");
  expect(screen.queryByRole("option", { name: "High（高）" })).toBeNull();
  expect(change).toHaveBeenLastCalledWith({
    model: "other-model",
    effort: "medium",
  });
});

it("allows inherited settings after catalog failure and can retry", async () => {
  vi.mocked(api.listModels)
    .mockRejectedValueOnce(new Error("接続失敗"))
    .mockResolvedValue(modelFixture);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  vi.mocked(api.sendMessage).mockResolvedValue("completed");
  const user = userEvent.setup();
  render(<ChatPane thread={thread} close={() => {}} />);
  await screen.findByRole("alert");
  await user.type(screen.getByLabelText("メッセージ"), "質問");
  await user.click(screen.getByRole("button", { name: "送信" }));
  expect(api.sendMessage).toHaveBeenCalledWith(
    "a",
    "質問",
    expect.any(Function),
    { model: null, effort: null },
  );
  await screen.findByText("応答が完了しました。");
  await user.click(screen.getByRole("button", { name: "モデル一覧を更新" }));
  await screen.findByRole("option", { name: "Test Model（標準）" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("blocks vanished models without discarding the draft or silently falling back", async () => {
  vi.mocked(api.listModels).mockResolvedValue(modelFixture);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  const user = userEvent.setup();
  render(
    <ChatPane
      thread={thread}
      close={() => {}}
      initialDraft="残す"
      initialOptions={{ model: "gone-model", effort: "high" }}
    />,
  );
  await screen.findByRole("alert");
  expect(
    (screen.getByRole("button", { name: "送信" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.keyDown(screen.getByLabelText("メッセージ"), {
    key: "Enter",
    ctrlKey: true,
  });
  expect(api.sendMessage).not.toHaveBeenCalled();
  expect(
    (screen.getByLabelText("メッセージ") as HTMLTextAreaElement).value,
  ).toBe("残す");
  await user.selectOptions(screen.getByLabelText("モデル"), "");
  expect(
    (screen.getByRole("button", { name: "送信" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it("ignores an earlier thread response after switching", async () => {
  let resolveOld!: (page: ChatPage) => void;
  vi.mocked(api.readThread).mockImplementation((id) =>
    id === "a"
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve({
          messages: [{ id: "b1", role: "user", text: "新しい会話" }],
          nextCursor: null,
        }),
  );
  const view = render(<ChatPane key="a" thread={thread} close={() => {}} />);
  view.rerender(
    <ChatPane
      key="b"
      thread={{ ...thread, id: "b", title: "会話B" }}
      close={() => {}}
    />,
  );
  await screen.findByText("新しい会話");
  await act(async () =>
    resolveOld({
      messages: [{ id: "a1", role: "user", text: "古い会話" }],
      nextCursor: null,
    }),
  );
  expect(screen.queryByText("古い会話")).toBeNull();
});
it("appends another page without duplicating messages", async () => {
  vi.mocked(api.readThread)
    .mockResolvedValueOnce({
      messages: [{ id: "1", role: "user", text: "質問" }],
      nextCursor: "next",
    })
    .mockResolvedValueOnce({
      messages: [
        { id: "1", role: "user", text: "質問" },
        { id: "2", role: "assistant", text: "回答" },
      ],
      nextCursor: null,
    });
  const user = userEvent.setup();
  render(<ChatPane thread={thread} close={() => {}} />);
  await user.click(await screen.findByText("以前のメッセージを読み込む"));
  await screen.findByText("回答");
  expect(screen.getAllByText("質問")).toHaveLength(1);
  expect(api.readThread).toHaveBeenLastCalledWith("a", "next");
});
it("shows failure and permits retry", async () => {
  vi.mocked(api.readThread)
    .mockRejectedValueOnce(new Error("取得できません"))
    .mockResolvedValueOnce({ messages: [], nextCursor: null });
  const user = userEvent.setup();
  render(<ChatPane thread={thread} close={() => {}} />);
  await screen.findByRole("alert");
  await user.click(screen.getByText("再試行"));
  expect(
    await screen.findByText("保存されたメッセージはありません。"),
  ).toBeTruthy();
});
it("renders HTML as inert text", async () => {
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [
      { id: "1", role: "assistant", text: '<img src=x onerror="alert(1)">' },
    ],
    nextCursor: null,
  });
  render(<ChatPane thread={thread} close={() => {}} />);
  await screen.findByText('<img src=x onerror="alert(1)">');
  expect(screen.queryByRole("img")).toBeNull();
});

it("marks only the displayed snapshot read after loading succeeds", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
    observedUpdatedAt: 10,
  });
  const board = { revision: 1, groups: [], threads: [], lastSync: 1 };
  vi.mocked(api.markThreadRead).mockResolvedValue(board);
  const accept = vi.fn();
  render(
    <ChatPane
      thread={{ ...thread, updatedAt: 11, unread: true }}
      close={() => {}}
      onReadBoard={accept}
    />,
  );
  await waitFor(() => expect(api.markThreadRead).toHaveBeenCalledWith("a", 10));
  expect(accept).toHaveBeenCalledWith(board);
});

it("does not mark a failed history load as read", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.mocked(api.readThread).mockRejectedValue(new Error("取得失敗"));
  render(<ChatPane thread={thread} close={() => {}} onReadBoard={vi.fn()} />);
  await screen.findByRole("alert");
  expect(api.markThreadRead).not.toHaveBeenCalled();
});

it("waits for focus before acknowledging a background history load", async () => {
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
    observedUpdatedAt: 10,
  });
  vi.mocked(api.markThreadRead).mockResolvedValue({
    revision: 1,
    groups: [],
    threads: [],
    lastSync: 1,
  });
  render(<ChatPane thread={thread} close={() => {}} onReadBoard={vi.fn()} />);
  await screen.findByText("保存されたメッセージはありません。");
  expect(api.markThreadRead).not.toHaveBeenCalled();
  focus.mockReturnValue(true);
  fireEvent.focus(window);
  await waitFor(() => expect(api.markThreadRead).toHaveBeenCalledTimes(1));
});

it("sends once, streams text, and loads persisted history", async () => {
  vi.mocked(api.readThread)
    .mockResolvedValueOnce({ messages: [], nextCursor: null })
    .mockResolvedValueOnce({
      messages: [{ id: "saved", role: "assistant", text: "こんにちは" }],
      nextCursor: null,
    });
  let finish!: (status: string) => void;
  vi.mocked(api.sendMessage).mockImplementation((_id, _text, emit) => {
    emit({ type: "ready" });
    emit({ type: "delta", id: "a", text: "こんに" });
    emit({ type: "delta", id: "a", text: "ちは" });
    emit({ type: "message", id: "a", text: "こんにちは" });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const user = userEvent.setup();
  const busy = vi.fn();
  render(<ChatPane thread={thread} close={() => {}} onBusyChange={busy} />);
  await screen.findByText("保存されたメッセージはありません。");
  await user.type(screen.getByLabelText("メッセージ"), "質問です");
  await user.click(screen.getByRole("button", { name: "送信" }));
  expect(await screen.findByText("こんにちは")).toBeTruthy();
  expect(
    (screen.getByLabelText("チャット欄を閉じる") as HTMLButtonElement).disabled,
  ).toBe(false);
  fireEvent.keyDown(screen.getByLabelText("メッセージ"), {
    key: "Enter",
    ctrlKey: true,
  });
  expect(api.sendMessage).toHaveBeenCalledTimes(1);
  await act(async () => finish("completed"));
  expect(screen.getAllByText("こんにちは")).toHaveLength(1);
  expect(
    (screen.getByLabelText("メッセージ") as HTMLTextAreaElement).value,
  ).toBe("");
  expect(busy).toHaveBeenLastCalledWith(false);
});

it("keeps failed input and does not retry automatically", async () => {
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  vi.mocked(api.sendMessage).mockRejectedValue(new Error("接続切断"));
  const user = userEvent.setup();
  render(<ChatPane thread={thread} close={() => {}} />);
  await user.type(screen.getByLabelText("メッセージ"), "残す文章");
  await user.click(screen.getByRole("button", { name: "送信" }));
  expect((await screen.findByRole("alert")).textContent).toContain("再送信前");
  expect(
    (screen.getByLabelText("メッセージ") as HTMLTextAreaElement).value,
  ).toBe("残す文章");
  expect(api.sendMessage).toHaveBeenCalledTimes(1);
});

it("explains writer conflicts as unsent and preserves only the draft", async () => {
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  vi.mocked(api.sendMessage).mockRejectedValue({
    code: "ThreadInUse",
    message: "Codex: thread test already has an active writer",
  });
  const user = userEvent.setup();
  render(<ChatPane thread={thread} close={() => {}} />);
  await user.type(screen.getByLabelText("メッセージ"), "下書きを残す");
  await user.click(screen.getByRole("button", { name: "送信" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("今回は送信されていません");
  expect(alert.textContent).toContain("セッションを終了");
  expect(alert.textContent).not.toContain("送信済みの可能性");
  expect(screen.queryByText("あなた（今回の送信）")).toBeNull();
  expect(
    (screen.getByLabelText("メッセージ") as HTMLTextAreaElement).value,
  ).toBe("下書きを残す");
  expect(alert.querySelector("details")?.open).toBe(false);
  expect(api.sendMessage).toHaveBeenCalledTimes(1);
});

it("does not submit whitespace, Enter, or IME confirmation", async () => {
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  render(<ChatPane thread={thread} close={() => {}} />);
  await screen.findByText("保存されたメッセージはありません。");
  const input = screen.getByLabelText("メッセージ");
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  fireEvent.change(input, { target: { value: "日本語" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", metaKey: true, keyCode: 229 });
  expect(api.sendMessage).not.toHaveBeenCalled();
});

it("stops only the selected send and shows interruption", async () => {
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  let finish!: (status: string) => void;
  vi.mocked(api.sendMessage).mockImplementation((_id, _text, emit) => {
    emit({ type: "ready" });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  vi.mocked(api.stopMessage).mockImplementation(async () => {
    finish("interrupted");
  });
  const user = userEvent.setup();
  render(<ChatPane thread={thread} close={() => {}} />);
  await user.type(screen.getByLabelText("メッセージ"), "質問");
  await user.click(screen.getByRole("button", { name: "送信" }));
  await user.click(await screen.findByRole("button", { name: "応答を停止" }));
  await waitFor(() => expect(api.stopMessage).toHaveBeenCalledWith("a"));
  expect(await screen.findByText("応答を停止しました。")).toBeTruthy();
});

it("preserves permission when selecting and clearing a model", async () => {
  vi.mocked(api.listModels).mockResolvedValue(modelFixture);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  const change = vi.fn();
  const user = userEvent.setup();
  render(
    <ChatPane
      thread={thread}
      close={() => {}}
      onOptionsChange={change}
      initialOptions={{
        model: null,
        effort: null,
        permission: "danger-full-access",
      }}
    />,
  );
  await screen.findByRole("option", { name: "Test Model（標準）" });
  await user.selectOptions(screen.getByLabelText("モデル"), "test-model");
  expect(change).toHaveBeenLastCalledWith({
    model: "test-model",
    effort: "low",
    permission: "danger-full-access",
  });
  await user.selectOptions(screen.getByLabelText("モデル"), "");
  expect(change).toHaveBeenLastCalledWith({
    model: null,
    effort: null,
    permission: "danger-full-access",
  });
  await user.selectOptions(
    screen.getByRole("combobox", { name: /実行権限/ }),
    "read-only",
  );
  expect(change).toHaveBeenLastCalledWith({
    model: null,
    effort: null,
    permission: "read-only",
  });
});

it("does not acknowledge a hidden running chat until it is visible", async () => {
  vi.mocked(api.markThreadRead).mockResolvedValue({
    revision: 1,
    lastSync: null,
    threads: [thread],
    groups: [],
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
    observedUpdatedAt: 10,
  });
  const accept = vi.fn();
  const { rerender } = render(
    <ChatPane
      thread={thread}
      close={() => {}}
      visible={false}
      onReadBoard={accept}
    />,
  );
  await waitFor(() => expect(api.readThread).toHaveBeenCalled());
  fireEvent.focus(window);
  expect(api.markThreadRead).not.toHaveBeenCalled();
  rerender(
    <ChatPane thread={thread} close={() => {}} visible onReadBoard={accept} />,
  );
  await waitFor(() =>
    expect(api.markThreadRead).toHaveBeenCalledWith(thread.id, 10),
  );
});

it.each(["", "次の質問"])(
  "preserves an edited next draft %j when sending fails",
  async (nextDraft) => {
    vi.mocked(api.readThread).mockResolvedValue({
      messages: [],
      nextCursor: null,
    });
    let fail!: (error: Error) => void;
    vi.mocked(api.sendMessage).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const change = vi.fn();
    render(
      <ChatPane
        thread={thread}
        close={() => {}}
        initialDraft="送る文章"
        onDraftChange={change}
      />,
    );
    await screen.findByText("保存されたメッセージはありません。");
    const input = screen.getByLabelText("メッセージ") as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(input.value).toBe("");
    expect(change).toHaveBeenLastCalledWith("");
    fireEvent.change(input, { target: { value: "編集途中" } });
    fireEvent.change(input, { target: { value: nextDraft } });
    await act(async () => fail(new Error("接続切断")));
    expect(input.value).toBe(nextDraft);
    expect(change).toHaveBeenLastCalledWith(nextDraft);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  },
);

it("drops an image, sends it without text, and retains it after failure", async () => {
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  vi.mocked(api.sendMessage).mockRejectedValue(new Error("disconnected"));
  render(<ChatPane thread={thread} close={() => {}} />);
  await screen.findByText("保存されたメッセージはありません。");
  const file = new File(["image bytes"], "sample.png", { type: "image/png" });
  fireEvent.drop(screen.getByLabelText("メッセージ"), {
    dataTransfer: { types: ["Files"], files: [file] },
  });
  await screen.findByAltText("sample.png");
  await userEvent.click(screen.getByRole("button", { name: "送信" }));
  await waitFor(() =>
    expect(api.sendMessage).toHaveBeenCalledWith(
      "a",
      "",
      expect.any(Function),
      expect.any(Object),
      [{ name: "sample.png", url: "data:image/png;base64,aW1hZ2UgYnl0ZXM=" }],
    ),
  );
  await screen.findByText("送信結果・応答の完了を確認できませんでした");
  expect(screen.getByAltText("sample.png")).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "sample.pngを削除" }),
  );
  expect(screen.queryByAltText("sample.png")).toBeNull();
});

it("rejects non-image drops without sending", async () => {
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  render(<ChatPane thread={thread} close={() => {}} />);
  fireEvent.drop(screen.getByLabelText("メッセージ"), {
    dataTransfer: {
      types: ["Files"],
      files: [new File(["text"], "file.txt", { type: "text/plain" })],
    },
  });
  await screen.findByText(
    "添付は合計4ファイルまで、各5MB以下のPNG・JPEG・WebP・GIF・PDFを指定してください。",
  );
  expect(api.sendMessage).not.toHaveBeenCalled();
});

it("steers the current turn and drains queued messages in order while preserving the next draft", async () => {
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  vi.mocked(api.steerMessage).mockResolvedValue(undefined);
  const finishes: ((value: string) => void)[] = [];
  vi.mocked(api.sendMessage).mockImplementation((_id, _text, emit) => {
    emit({ type: "ready" });
    return new Promise((resolve) => finishes.push(resolve));
  });
  const user = userEvent.setup();
  render(<ChatPane thread={thread} close={() => {}} initialDraft="first" />);
  await screen.findByText("保存されたメッセージはありません。");
  await user.click(screen.getByRole("button", { name: "送信" }));
  const input = screen.getByLabelText("メッセージ");
  await user.type(input, "change now");
  await user.click(screen.getByRole("button", { name: "Steer" }));
  expect(api.steerMessage).toHaveBeenCalledWith("a", "change now", []);
  await user.type(input, "second");
  await user.click(screen.getByRole("button", { name: "Queue" }));
  await user.type(input, "third");
  await user.click(screen.getByRole("button", { name: "Queue" }));
  expect(api.sendMessage).toHaveBeenCalledTimes(1);
  await user.type(input, "my next draft");
  await act(async () => finishes[0]("completed"));
  expect(vi.mocked(api.sendMessage).mock.calls[1][1]).toBe("second");
  await act(async () => finishes[1]("completed"));
  expect(vi.mocked(api.sendMessage).mock.calls[2][1]).toBe("third");
  await act(async () => finishes[2]("completed"));
  expect((input as HTMLTextAreaElement).value).toBe("my next draft");
  expect(screen.queryByRole("region", { name: "送信待ち" })).toBeNull();
});

it("keeps the queue paused after interruption", async () => {
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  let finish!: (value: string) => void;
  vi.mocked(api.sendMessage).mockImplementation((_id, _text, emit) => {
    emit({ type: "ready" });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const user = userEvent.setup();
  render(<ChatPane thread={thread} close={() => {}} initialDraft="first" />);
  await screen.findByText("保存されたメッセージはありません。");
  await user.click(screen.getByRole("button", { name: "送信" }));
  await user.type(screen.getByLabelText("メッセージ"), "later");
  await user.click(screen.getByRole("button", { name: "Queue" }));
  await act(async () => finish("interrupted"));
  expect(api.sendMessage).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "キューを再開" })).toBeTruthy();
});

it("opens a fork returned by the API without sending a message", async () => {
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [{ id: "m", role: "assistant", text: "保存済みの会話" }],
    nextCursor: null,
  });
  const result = {
    board: {
      revision: 2,
      lastSync: null,
      groups: [],
      threads: [{ ...thread, id: "fork" }],
    },
    threadId: "fork",
  };
  vi.mocked(api.forkThread).mockResolvedValue(result);
  const onFork = vi.fn();
  render(<ChatPane thread={thread} close={() => {}} onFork={onFork} />);
  await screen.findByText("保存済みの会話");
  await userEvent.click(
    screen.getByRole("button", { name: "この会話から分岐" }),
  );
  expect(api.forkThread).toHaveBeenCalledWith("a");
  expect(onFork).toHaveBeenCalledWith(result);
  expect(api.sendMessage).not.toHaveBeenCalled();
});
