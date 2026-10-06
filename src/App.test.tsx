import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { api, type Board } from "./api";
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: {
    board: vi.fn(),
    createThread: vi.fn(),
    listModels: vi.fn(),
    refresh: vi.fn(),
    mutate: vi.fn(),
    readThread: vi.fn(),
    openInZed: vi.fn(),
    sendMessage: vi.fn(),
    stopMessage: vi.fn(),
    markThreadRead: vi.fn(),
  },
}));
const fixture = (): Board => ({
  revision: 1,
  lastSync: 10,
  groups: [{ id: "g", name: "調査" }],
  threads: [
    {
      id: "t",
      title: "API の確認",
      createdAt: 1,
      cwd: "/project",
      archived: false,
      groupId: null,
      position: 0,
    },
  ],
});
beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.listModels).mockResolvedValue([]);
  vi.mocked(api.openInZed).mockResolvedValue(undefined);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [{ id: "m", role: "assistant", text: "確認しました" }],
    nextCursor: null,
  });
  vi.mocked(api.board).mockResolvedValue(fixture());
  vi.mocked(api.refresh).mockResolvedValue(fixture());
  vi.mocked(api.mutate).mockResolvedValue(fixture());
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
it("opens only the workspace when the Zed button is clicked", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", {
      name: "API の確認 のワークスペースを Zed で開く",
    }),
  );
  expect(api.openInZed).toHaveBeenCalledWith("t");
  expect(api.readThread).not.toHaveBeenCalled();
  expect(api.mutate).not.toHaveBeenCalled();
});
it("reports a Zed launch failure without losing the thread", async () => {
  vi.mocked(api.openInZed).mockRejectedValue({
    code: "EditorUnavailable",
    message: "Zed を起動できません。",
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", {
      name: "API の確認 のワークスペースを Zed で開く",
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Zed を起動できません。",
  );
  expect(screen.getByRole("heading", { name: "API の確認" })).toBeTruthy();
});
it("opens chat from the card background without opening Zed", async () => {
  const board = fixture();
  board.threads[0].groupId = "g";
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  render(<App />);
  const title = await screen.findByRole("heading", { name: "API の確認" });
  fireEvent.click(title.closest("article")!);
  await screen.findByText("確認しました");
  expect(api.openInZed).not.toHaveBeenCalled();
});
it("opens the chat on click and closes it without changing classification", async () => {
  const board = fixture();
  board.threads[0].groupId = "g";
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "API の確認 のチャットを表示" }),
  );
  expect(await screen.findByText("確認しました")).toBeTruthy();
  expect(api.readThread).toHaveBeenCalledWith("t");
  expect(api.mutate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "チャット欄を閉じる" }));
  expect(
    screen.queryByRole("complementary", { name: "チャット内容" }),
  ).toBeNull();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
it("moves a thread using its accessible destination menu", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.selectOptions(
    await screen.findByRole("combobox", { name: "API の確認 の移動先" }),
    "g",
  );
  expect(api.mutate).toHaveBeenCalledWith(1, {
    type: "moveThread",
    id: "t",
    groupId: "g",
    beforeId: null,
  });
});
it("creates a group and rejects an empty name", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "API の確認" });
  await user.click(screen.getByRole("button", { name: "＋ グループ作成" }));
  const dialog = screen.getByRole("dialog");
  expect(
    (within(dialog).getByText("保存する") as HTMLButtonElement).disabled,
  ).toBe(true);
  await user.type(within(dialog).getByLabelText(/グループ名/), "リリース");
  await user.click(within(dialog).getByText("保存する"));
  expect(api.mutate).toHaveBeenCalledWith(1, {
    type: "createGroup",
    name: "リリース",
  });
});
it("requires confirmation before deleting a group", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "調査 を削除" }));
  expect(api.mutate).not.toHaveBeenCalled();
  expect(screen.getByText(/会話は削除されません/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "削除する" }));
  expect(api.mutate).toHaveBeenCalledWith(1, { type: "deleteGroup", id: "g" });
});
it("retains the board and explains a failed write", async () => {
  vi.mocked(api.mutate).mockRejectedValue({ code: "Storage" });
  const user = userEvent.setup();
  render(<App />);
  await user.selectOptions(await screen.findByRole("combobox"), "g");
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
});
it("dragging and dropping calls the same move operation", async () => {
  render(<App />);
  const handle = await screen.findByRole("button", {
    name: "API の確認 をドラッグ",
  });
  const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(handle, { dataTransfer });
  fireEvent.dragOver(screen.getByRole("region", { name: "調査" }), {
    dataTransfer,
  });
  fireEvent.drop(screen.getByRole("region", { name: "調査" }), {
    dataTransfer,
  });
  await waitFor(() =>
    expect(api.mutate).toHaveBeenCalledWith(1, {
      type: "moveThread",
      id: "t",
      groupId: "g",
      beforeId: null,
    }),
  );
});
it("does not submit while Japanese IME composition is active", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "API の確認" });
  await user.click(screen.getByRole("button", { name: "＋ グループ作成" }));
  const input = screen.getByLabelText(/グループ名/);
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "調査" } });
  fireEvent.submit(input.closest("form")!);
  expect(api.mutate).not.toHaveBeenCalled();
});

it("shows unread badges and clears them only after successful viewing", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const board = fixture();
  board.threads[0].unread = true;
  board.threads[0].updatedAt = 10;
  board.threads[0].groupId = "g";
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
    observedUpdatedAt: 10,
  });
  vi.mocked(api.markThreadRead).mockResolvedValue({
    ...board,
    revision: 2,
    threads: [{ ...board.threads[0], unread: false }],
  });
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findAllByText("未読 1")).toHaveLength(2);
  expect(screen.getByLabelText("未読")).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "API の確認 のチャットを表示" }),
  );
  await waitFor(() => expect(screen.queryByText("未読 1")).toBeNull());
  expect(screen.queryByLabelText("未読")).toBeNull();
});

it("reorders Kanban lanes with left and right controls", async () => {
  const board = fixture();
  board.groups.push({ id: "g2", name: "開発" }, { id: "g3", name: "完了" });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  vi.mocked(api.mutate).mockResolvedValue(board);
  const user = userEvent.setup();
  render(<App />);
  expect(
    await screen.findByRole("region", { name: "スレッドのカンバンボード" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "調査 を左へ" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "完了 を右へ" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "開発 を左へ" }));
  expect(api.mutate).toHaveBeenLastCalledWith(1, {
    type: "reorderGroup",
    id: "g2",
    beforeId: "g",
  });
  await user.click(screen.getByRole("button", { name: "調査 を右へ" }));
  expect(api.mutate).toHaveBeenLastCalledWith(1, {
    type: "reorderGroup",
    id: "g",
    beforeId: "g3",
  });
});

it("keeps the inbox outside the group scroll viewport even with chat open", async () => {
  const user = userEvent.setup();
  render(<App />);
  const inbox = await screen.findByRole("region", { name: /^未分類/ });
  const viewport = screen.getByRole("region", {
    name: "グループの横スクロール領域",
  });
  expect(viewport.contains(inbox)).toBe(false);
  expect(
    viewport.contains(
      within(viewport).getByRole("region", { name: /^グループ/ }),
    ),
  ).toBe(true);
  expect(inbox.parentElement).toBe(viewport.parentElement);
  await user.click(
    await screen.findByRole("button", { name: "API の確認 を選択" }),
  );
  expect(api.readThread).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("complementary", { name: "チャット内容" }),
  ).toBeTruthy();
  expect(inbox.parentElement).toBe(viewport.parentElement);
});

it("selects inbox cards by click without opening or switching chat or marking read", async () => {
  const board = fixture();
  board.threads[0].unread = true;
  board.threads.push({ ...board.threads[0], id: "second", title: "別の会話" });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  const user = userEvent.setup();
  render(<App />);
  const first = await screen.findByRole("button", {
    name: "API の確認 を選択",
  });
  await user.click(first);
  expect(document.activeElement).toBe(first);
  fireEvent.click(first.closest("article")!);
  expect(api.readThread).not.toHaveBeenCalled();
  expect(api.markThreadRead).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("complementary", { name: "チャット内容" }),
  ).toBeNull();
  await user.keyboard("{Enter}");
  await screen.findByText("確認しました");
  await user.click(screen.getByRole("button", { name: "別の会話 を選択" }));
  expect(api.readThread).toHaveBeenCalledTimes(1);
  expect(
    within(
      screen.getByRole("complementary", { name: "チャット内容" }),
    ).getByRole("heading", { name: "API の確認" }),
  ).toBeTruthy();
});

it("keeps the stream alive while switching, closing and creating chats", async () => {
  const board = fixture();
  board.threads[0].groupId = "g";
  board.threads.push({ ...board.threads[0], id: "second", title: "別の会話" });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  let finish!: (status: string) => void;
  let emitEvent!: Parameters<typeof api.sendMessage>[2];
  vi.mocked(api.sendMessage).mockImplementation((_id, _text, emit) => {
    emitEvent = emit;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "API の確認 のチャットを表示" }),
  );
  await user.type(screen.getByLabelText("メッセージ"), "下書きA");
  await user.click(
    screen.getByRole("button", { name: "別の会話 のチャットを表示" }),
  );
  expect(
    (screen.getByLabelText("メッセージ") as HTMLTextAreaElement).value,
  ).toBe("");
  await user.click(
    screen.getByRole("button", { name: "API の確認 のチャットを表示" }),
  );
  expect(
    (screen.getByLabelText("メッセージ") as HTMLTextAreaElement).value,
  ).toBe("下書きA");
  await user.click(screen.getByRole("button", { name: "送信" }));
  await user.click(
    screen.getByRole("button", { name: "別の会話 のチャットを表示" }),
  );
  expect(
    within(
      screen.getByRole("complementary", { name: "チャット内容" }),
    ).getByRole("heading", { name: "別の会話" }),
  ).toBeTruthy();
  const otherChat = within(
    screen.getByRole("complementary", { name: "チャット内容" }),
  );
  await user.type(otherChat.getByLabelText("メッセージ"), "下書きB");
  act(() =>
    emitEvent({
      type: "delta",
      id: "background",
      text: "別画面で受信した回答",
    }),
  );
  await user.click(screen.getByRole("button", { name: /^実行中:/ }));
  expect(
    (
      within(screen.getByRole("complementary")).getByLabelText(
        "メッセージ",
      ) as HTMLTextAreaElement
    ).value,
  ).toBe("");
  expect(
    within(screen.getByRole("complementary")).getByText("別画面で受信した回答"),
  ).toBeTruthy();
  expect(api.sendMessage).toHaveBeenCalledTimes(1);
  expect(api.stopMessage).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "チャット欄を閉じる" }));
  expect(screen.queryByRole("complementary")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "新しいチャットを開始" }),
  );
  expect(screen.getByRole("dialog", { name: "新しいチャット" })).toBeTruthy();
  const created = { ...board.threads[0], id: "new", title: "新しいチャット" };
  vi.mocked(api.createThread).mockResolvedValue({
    board: { ...board, revision: 2, threads: [...board.threads, created] },
    threadId: "new",
  });
  await user.click(screen.getByRole("button", { name: "会話を開始" }));
  await within(screen.getByRole("complementary")).findByRole("heading", {
    name: "新しいチャット",
  });
  expect(api.createThread).toHaveBeenCalledWith("/project", null);
  await user.click(screen.getByRole("button", { name: /^実行中:/ }));
  expect(screen.getByRole("button", { name: "応答を停止" })).toBeTruthy();
  await act(async () => finish("completed"));
});

it.each([null, "g"])(
  "shows an execution badge and restores card focus without remounting chat in %s",
  async (groupId) => {
    const board = fixture();
    board.threads[0].groupId = groupId;
    vi.mocked(api.board).mockResolvedValue(board);
    vi.mocked(api.refresh).mockResolvedValue(board);
    let finish!: (value: string) => void;
    vi.mocked(api.sendMessage).mockImplementation((_id, _text, emit) => {
      emit({ type: "ready" });
      emit({ type: "delta", id: "live", text: "途中の回答" });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const user = userEvent.setup();
    render(<App />);
    const label = groupId ? "API の確認 のチャットを表示" : "API の確認 を選択";
    await user.click(await screen.findByRole("button", { name: label }));
    if (!groupId) await user.keyboard("{Enter}");
    await screen.findByText("確認しました");
    expect(screen.queryByRole("button", { name: /^実行中:/ })).toBeNull();
    await user.type(screen.getByLabelText("メッセージ"), "質問");
    await user.click(screen.getByRole("button", { name: "送信" }));
    const badge = await screen.findByRole("button", {
      name: "実行中: API の確認 のチャットとスレッドへ移動",
    });
    if (groupId)
      await user.click(
        within(screen.getByRole("region", { name: "調査" })).getByRole(
          "button",
          { expanded: true },
        ),
      );
    await user.type(
      screen.getByLabelText("スレッドを検索"),
      "非表示にする検索",
    );
    await user.click(badge);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: label }),
      ),
    );
    expect(
      (screen.getByLabelText("スレッドを検索") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByText("途中の回答")).toBeTruthy();
    expect(api.readThread).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.stopMessage).not.toHaveBeenCalled();
    await act(async () => finish("completed"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^実行中:/ })).toBeNull(),
    );
  },
);

it("removes the execution badge when sending fails", async () => {
  let fail!: (error: unknown) => void;
  vi.mocked(api.sendMessage).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "API の確認 を選択" }),
  );
  await user.keyboard("{Enter}");
  await screen.findByText("確認しました");
  await user.type(screen.getByLabelText("メッセージ"), "質問");
  await user.click(screen.getByRole("button", { name: "送信" }));
  await screen.findByRole("button", { name: /^実行中:/ });
  await act(async () => fail({ code: "ChatNotSent", message: "接続失敗" }));
  expect(screen.queryByRole("button", { name: /^実行中:/ })).toBeNull();
});

it("focuses groups with Shift+digits from outside inputs without opening chat", async () => {
  const board = fixture();
  board.groups.unshift({ id: "g2", name: "開発" });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  render(<App />);
  const first = await screen.findByRole("region", { name: "開発" });
  const second = screen.getByRole("region", { name: "調査" });
  const scroll = vi.fn();
  second.scrollIntoView = scroll;
  fireEvent.keyDown(document.body, {
    key: "!",
    code: "Digit1",
    shiftKey: true,
  });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: '"', code: "Digit2", shiftKey: true });
  expect(document.activeElement).toBe(second);
  expect(scroll).toHaveBeenCalledWith({
    block: "nearest",
    inline: "nearest",
    behavior: "auto",
  });
  fireEvent.keyDown(second, { key: "(", code: "Digit9", shiftKey: true });
  expect(document.activeElement).toBe(second);
  expect(api.readThread).not.toHaveBeenCalled();
  expect(api.mutate).not.toHaveBeenCalled();
});

it("navigates group threads after Shift+1 and opens chat only on Enter", async () => {
  const board = fixture();
  board.threads[0].groupId = "g";
  board.threads[0].updatedAt = 20;
  board.threads.push({
    ...board.threads[0],
    id: "second",
    title: "次の会話",
    position: 1,
    updatedAt: 10,
  });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  const user = userEvent.setup();
  render(<App />);
  const group = await screen.findByRole("region", { name: "調査" });
  const first = screen.getByRole("button", {
    name: "API の確認 のチャットを表示",
  });
  const second = screen.getByRole("button", {
    name: "次の会話 のチャットを表示",
  });
  fireEvent.keyDown(document.body, {
    key: "!",
    code: "Digit1",
    shiftKey: true,
  });
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(first);
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(document.activeElement).toBe(second);
  await user.keyboard("{ArrowUp}{ArrowUp}");
  expect(document.activeElement).toBe(first);
  group.focus();
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(second);
  expect(api.readThread).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  await screen.findByText("確認しました");
  expect(api.readThread).toHaveBeenCalledWith("second");
  expect(api.mutate).not.toHaveBeenCalled();
});

it.each(["MacIntel", "Win32"])(
  "opens the latest unread in the focused group and retains card focus on %s",
  async (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const board = fixture();
    board.threads[0].groupId = "g";
    board.groups.push({ id: "other", name: "別グループ" });
    board.threads.push(
      {
        ...board.threads[0],
        id: "older",
        title: "前の未読",
        position: 1,
        unread: true,
        updatedAt: 10,
      },
      {
        ...board.threads[0],
        id: "latest",
        title: "最新の未読",
        position: 2,
        unread: true,
        updatedAt: 20,
      },
      {
        ...board.threads[0],
        id: "foreign",
        title: "別グループの未読",
        groupId: "other",
        unread: true,
        updatedAt: 30,
      },
    );
    vi.mocked(api.board).mockResolvedValue(board);
    vi.mocked(api.refresh).mockResolvedValue(board);
    vi.mocked(api.readThread).mockResolvedValue({
      observedUpdatedAt: 20,
      messages: [],
      nextCursor: null,
    });
    vi.mocked(api.markThreadRead).mockResolvedValue({
      ...board,
      revision: 2,
      threads: board.threads.map((t) =>
        t.id === "latest" ? { ...t, unread: false } : t,
      ),
    });
    const user = userEvent.setup();
    render(<App />);
    const group = await screen.findByRole("region", { name: "調査" });
    // A collapsed group must open to reveal and focus its unread target.
    await user.click(within(group).getByRole("button", { expanded: true }));
    group.focus();
    fireEvent.keyDown(group, {
      key: "Enter",
      metaKey: platform === "MacIntel",
      ctrlKey: platform !== "MacIntel",
    });
    await waitFor(() => expect(api.readThread).toHaveBeenCalledWith("latest"));
    const card = await screen.findByRole("button", {
      name: "最新の未読 のチャットを表示",
    });
    await waitFor(() =>
      expect(api.markThreadRead).toHaveBeenCalledWith("latest", 20),
    );
    expect(document.activeElement).toBe(card);
    expect(
      within(
        screen.getByRole("complementary", { name: "チャット内容" }),
      ).getByRole("heading", { name: "最新の未読" }),
    ).toBeTruthy();
    expect(api.mutate).not.toHaveBeenCalled();
  },
);

it("does not open a read thread when a group has no unread threads", async () => {
  const board = fixture();
  board.threads[0].groupId = "g";
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  render(<App />);
  const group = await screen.findByRole("region", { name: "調査" });
  group.focus();
  fireEvent.keyDown(group, { key: "Enter", ctrlKey: true });
  expect(document.activeElement).toBe(group);
  expect(api.readThread).not.toHaveBeenCalled();
});

it("keeps focus in empty or collapsed groups and does not hijack destination selects", async () => {
  const board = fixture();
  board.threads[0].groupId = "g";
  board.groups.push({ id: "empty", name: "空" });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  const user = userEvent.setup();
  render(<App />);
  const group = await screen.findByRole("region", { name: "調査" });
  const select = screen.getByRole("combobox");
  select.focus();
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(select);
  await user.click(within(group).getByRole("button", { expanded: true }));
  group.focus();
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(group);
  const empty = screen.getByRole("region", { name: "空" });
  empty.focus();
  await user.keyboard("{ArrowDown}{ArrowUp}");
  expect(document.activeElement).toBe(empty);
  expect(api.readThread).not.toHaveBeenCalled();
});

it("ignores group shortcuts while editing, composing or showing a dialog", async () => {
  const user = userEvent.setup();
  render(<App />);
  const card = await screen.findByRole("button", { name: "API の確認 を選択" });
  const search = screen.getByLabelText("スレッドを検索");
  search.focus();
  fireEvent.keyDown(search, { key: "!", code: "Digit1", shiftKey: true });
  expect(document.activeElement).toBe(search);
  card.focus();
  fireEvent.keyDown(card, {
    key: "!",
    code: "Digit1",
    shiftKey: true,
    isComposing: true,
  });
  expect(document.activeElement).toBe(card);
  fireEvent.keyDown(card, {
    key: "!",
    code: "Digit1",
    shiftKey: true,
    metaKey: true,
  });
  expect(document.activeElement).toBe(card);
  await user.click(screen.getByRole("button", { name: "＋ グループ作成" }));
  const focused = document.activeElement;
  fireEvent.keyDown(document.body, {
    key: "!",
    code: "Digit1",
    shiftKey: true,
  });
  expect(document.activeElement).toBe(focused);
});

it("navigates inbox cards with arrows and classifies the focused card with Ctrl+2", async () => {
  const board = fixture();
  board.groups.push({ id: "g2", name: "開発" });
  board.threads.push({
    ...board.threads[0],
    id: "second",
    title: "次の会話",
    createdAt: 0,
  });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  vi.mocked(api.mutate).mockResolvedValue({
    ...board,
    revision: 2,
    threads: board.threads.map((t) =>
      t.id === "second" ? { ...t, groupId: "g2" } : t,
    ),
  });
  const user = userEvent.setup();
  render(<App />);
  const first = await screen.findByRole("button", {
    name: "API の確認 を選択",
  });
  const second = screen.getByRole("button", {
    name: "次の会話 を選択",
  });
  first.focus();
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(first);
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(document.activeElement).toBe(second);
  await user.keyboard("{Control>}2{/Control}");
  expect(api.mutate).toHaveBeenCalledWith(1, {
    type: "moveThread",
    id: "second",
    groupId: "g2",
    beforeId: null,
  });
  await waitFor(() => expect(document.activeElement).toBe(first));
  expect(api.readThread).not.toHaveBeenCalled();
});

it("does not classify for missing groups, repeated keys or inside a select", async () => {
  const user = userEvent.setup();
  render(<App />);
  const card = await screen.findByRole("button", {
    name: "API の確認 を選択",
  });
  card.focus();
  await user.keyboard("{Control>}9{/Control}");
  fireEvent.keyDown(card, { key: "1", ctrlKey: true, repeat: true });
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "1", ctrlKey: true });
  fireEvent.keyDown(screen.getByPlaceholderText("スレッドを検索…"), {
    key: "1",
    ctrlKey: true,
  });
  expect(api.mutate).not.toHaveBeenCalled();
});

it("uses the current group order and keeps focus on a failed shortcut move", async () => {
  const board = fixture();
  board.groups.unshift({ id: "g2", name: "開発" });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  vi.mocked(api.mutate).mockRejectedValue({ code: "Storage" });
  const user = userEvent.setup();
  render(<App />);
  const card = await screen.findByRole("button", {
    name: "API の確認 を選択",
  });
  card.focus();
  await user.keyboard("{Control>}1{/Control}");
  await screen.findByRole("alert");
  expect(api.mutate).toHaveBeenCalledWith(1, {
    type: "moveThread",
    id: "t",
    groupId: "g2",
    beforeId: null,
  });
  expect(document.activeElement).toBe(card);
});

it.each(["MacIntel", "Win32", "Linux x86_64"])(
  "uses the platform modifier for classification on %s",
  async (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    render(<App />);
    const card = await screen.findByRole("button", {
      name: "API の確認 を選択",
    });
    card.focus();
    const mac = platform === "MacIntel";
    expect(
      screen.getByText(new RegExp((mac ? "⌘" : "Ctrl") + "＋1〜9")),
    ).toBeTruthy();
    fireEvent.keyDown(card, { key: "1", ctrlKey: mac, metaKey: !mac });
    expect(api.mutate).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "1", ctrlKey: !mac, metaKey: mac });
    await waitFor(() =>
      expect(api.mutate).toHaveBeenCalledWith(1, {
        type: "moveThread",
        id: "t",
        groupId: "g",
        beforeId: null,
      }),
    );
  },
);

it("creates a chat in the chosen workspace and group and opens its composer", async () => {
  const board = fixture();
  const thread = {
    ...board.threads[0],
    id: "new",
    title: "新しいチャット",
    groupId: "g",
  };
  vi.mocked(api.createThread).mockResolvedValue({
    board: { ...board, revision: 2, threads: [...board.threads, thread] },
    threadId: "new",
  });
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "API の確認" });
  await user.click(
    screen.getByRole("button", { name: "新しいチャットを開始" }),
  );
  const dialog = screen.getByRole("dialog", { name: "新しいチャット" });
  expect(
    (within(dialog).getByLabelText("ワークスペース") as HTMLSelectElement)
      .value,
  ).toBe("/project");
  await user.selectOptions(within(dialog).getByLabelText("グループ"), "g");
  await user.click(within(dialog).getByRole("button", { name: "会話を開始" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.createThread).toHaveBeenCalledWith("/project", "g");
  expect(api.readThread).toHaveBeenCalledWith("new");
  expect(
    within(screen.getByRole("region", { name: "調査" })).getByText(
      "新しいチャット",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeTruthy();
});

it("keeps new workspace input after a failure and prevents duplicate creation", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api.createThread).mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "API の確認" });
  await user.click(
    screen.getByRole("button", { name: "新しいチャットを開始" }),
  );
  const dialog = screen.getByRole("dialog");
  await user.selectOptions(within(dialog).getByLabelText("ワークスペース"), "");
  expect(
    (
      within(dialog).getByRole("button", {
        name: "会話を開始",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.type(
    within(dialog).getByLabelText("フォルダの絶対パス"),
    "/another project",
  );
  await user.dblClick(
    within(dialog).getByRole("button", { name: "会話を開始" }),
  );
  expect(api.createThread).toHaveBeenCalledTimes(1);
  expect(api.createThread).toHaveBeenCalledWith("/another project", null);
  expect(
    (
      within(dialog).getByRole("button", {
        name: "キャンセル",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () => reject(new Error("フォルダが見つかりません")));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "フォルダが見つかりません",
  );
  expect(
    (within(dialog).getByLabelText("フォルダの絶対パス") as HTMLInputElement)
      .value,
  ).toBe("/another project");
  await user.click(within(dialog).getByRole("button", { name: "キャンセル" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("filters workspace paths and prevents starting with no matches", async () => {
  const board = fixture();
  board.threads.push({
    ...board.threads[0],
    id: "second",
    cwd: "/work/ThreadCraft",
  });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  const user = userEvent.setup();
  render(<App />);
  await screen.findAllByText("API の確認");
  await user.click(
    screen.getByRole("button", { name: "新しいチャットを開始" }),
  );
  const dialog = within(screen.getByRole("dialog"));
  const search = dialog.getByRole("searchbox", {
    name: "ワークスペースを検索",
  });
  await user.type(search, "THREADcraft");
  expect(
    (dialog.getByLabelText("ワークスペース") as HTMLSelectElement).value,
  ).toBe("/work/ThreadCraft");
  expect(dialog.queryByRole("option", { name: "/project" })).toBeNull();
  await user.keyboard("{Enter}");
  expect(api.createThread).not.toHaveBeenCalled();
  await user.clear(search);
  await user.type(search, "missing-folder");
  expect(
    (dialog.getByRole("button", { name: "会話を開始" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.selectOptions(dialog.getByLabelText("ワークスペース"), "");
  await user.type(dialog.getByLabelText("フォルダの絶対パス"), "/new/path");
  expect(
    (dialog.getByRole("button", { name: "会話を開始" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("shares and persists the latest permission across existing and new chats", async () => {
  const board = fixture();
  board.threads[0].groupId = "g";
  board.threads.push({ ...board.threads[0], id: "second", title: "別の会話" });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  const user = userEvent.setup();
  const view = render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "API の確認 のチャットを表示" }),
  );
  const permission = () =>
    screen.getByRole("combobox", { name: /実行権限/ }) as HTMLSelectElement;
  await user.selectOptions(permission(), "workspace-write");
  await user.click(
    screen.getByRole("button", { name: "別の会話 のチャットを表示" }),
  );
  expect(permission().value).toBe("workspace-write");
  await user.selectOptions(permission(), "danger-full-access");
  await user.click(
    screen.getByRole("button", { name: "API の確認 のチャットを表示" }),
  );
  expect(permission().value).toBe("danger-full-access");
  view.unmount();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "API の確認 のチャットを表示" }),
  );
  expect(permission().value).toBe("danger-full-access");
  const created = { ...board.threads[0], id: "new", title: "新規" };
  vi.mocked(api.createThread).mockResolvedValue({
    board: { ...board, revision: 2, threads: [...board.threads, created] },
    threadId: "new",
  });
  await user.click(
    screen.getByRole("button", { name: "新しいチャットを開始" }),
  );
  await user.click(screen.getByRole("button", { name: "会話を開始" }));
  await screen.findByRole("heading", { name: "新規", level: 2 });
  expect(permission().value).toBe("danger-full-access");
});

it("shows unread chips across groups in update order independently of search", async () => {
  const board = fixture();
  board.threads = [
    {
      ...board.threads[0],
      id: "old",
      title: "古い未読",
      unread: true,
      updatedAt: 10,
    },
    {
      ...board.threads[0],
      id: "new",
      title: "新しい未読",
      groupId: "g",
      unread: true,
      updatedAt: 20,
    },
    {
      ...board.threads[0],
      id: "archived",
      title: "アーカイブ",
      unread: true,
      archived: true,
    },
    { ...board.threads[0], id: "read", title: "既読", unread: false },
  ];
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  const user = userEvent.setup();
  render(<App />);
  const chips = await screen.findByRole("navigation", {
    name: "未読スレッド一覧",
  });
  expect(
    within(chips)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["新しい未読", "古い未読"]);
  await user.type(screen.getByLabelText("スレッドを検索"), "一致しない検索");
  expect(within(chips).getAllByRole("button")).toHaveLength(2);
  await user.click(
    within(chips).getByRole("button", {
      name: "未読: 新しい未読 のチャットを表示",
    }),
  );
  await within(screen.getByRole("complementary")).findByRole("heading", {
    name: "新しい未読",
  });
  expect(api.readThread).toHaveBeenCalledWith("new");
  expect(
    (screen.getByLabelText("スレッドを検索") as HTMLInputElement).value,
  ).toBe("");
  expect(api.markThreadRead).not.toHaveBeenCalled();
});

it("removes the unread chip only after read acknowledgement succeeds", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const board = fixture();
  board.threads[0] = { ...board.threads[0], unread: true, updatedAt: 10 };
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  vi.mocked(api.readThread).mockResolvedValue({
    messages: [],
    nextCursor: null,
    observedUpdatedAt: 10,
  });
  let acknowledge!: (board: Board) => void;
  vi.mocked(api.markThreadRead).mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", {
      name: "未読: API の確認 のチャットを表示",
    }),
  );
  await waitFor(() => expect(api.markThreadRead).toHaveBeenCalledWith("t", 10));
  expect(
    screen.getByRole("navigation", { name: "未読スレッド一覧" }),
  ).toBeTruthy();
  await act(async () =>
    acknowledge({
      ...board,
      revision: 2,
      threads: [{ ...board.threads[0], unread: false }],
    }),
  );
  expect(
    screen.queryByRole("navigation", { name: "未読スレッド一覧" }),
  ).toBeNull();
});

it("runs two chats and stops only the selected chat", async () => {
  const board = fixture();
  board.threads[0].groupId = "g";
  board.threads.push({ ...board.threads[0], id: "second", title: "別の会話" });
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  const finishes = new Map<string, (status: string) => void>();
  const emitters = new Map<string, Parameters<typeof api.sendMessage>[2]>();
  vi.mocked(api.sendMessage).mockImplementation((id, _text, emit) => {
    emitters.set(id, emit);
    emit({ type: "ready" });
    return new Promise((resolve) => finishes.set(id, resolve));
  });
  vi.mocked(api.stopMessage).mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "API の確認 のチャットを表示" }),
  );
  await user.type(screen.getByRole("textbox", { name: "メッセージ" }), "最初");
  await user.click(screen.getByRole("button", { name: "送信" }));
  await user.click(
    screen.getByRole("button", { name: "別の会話 のチャットを表示" }),
  );
  await user.type(screen.getByRole("textbox", { name: "メッセージ" }), "次");
  await user.click(screen.getByRole("button", { name: "送信" }));
  expect(api.sendMessage).toHaveBeenCalledTimes(2);
  expect(screen.getAllByRole("button", { name: /^実行中:/ })).toHaveLength(2);
  act(() => {
    emitters.get("t")!({ type: "delta", id: "a", text: "最初の応答" });
    emitters.get("second")!({ type: "delta", id: "a", text: "別の応答" });
  });
  expect(
    within(screen.getByRole("complementary")).queryByText("最初の応答"),
  ).toBeNull();
  expect(
    within(screen.getByRole("complementary")).getByText("別の応答"),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "応答を停止" }));
  expect(api.stopMessage).toHaveBeenCalledWith("second");
  await act(async () => finishes.get("second")!("interrupted"));
  expect(screen.getAllByRole("button", { name: /^実行中:/ })).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: /^実行中:/ }));
  expect(
    within(screen.getByRole("complementary")).getByText("最初の応答"),
  ).toBeTruthy();
  await act(async () => finishes.get("t")!("completed"));
  expect(screen.queryByRole("button", { name: /^実行中:/ })).toBeNull();
});

it("returns the focused grouped thread to inbox with Delete and follows its focus", async () => {
  const board = fixture();
  board.threads[0].groupId = "g";
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  vi.mocked(api.mutate).mockResolvedValue({
    ...board,
    revision: 2,
    threads: [{ ...board.threads[0], groupId: null }],
  });
  render(<App />);
  const card = await screen.findByRole("button", {
    name: "API の確認 のチャットを表示",
  });
  card.focus();
  fireEvent.keyDown(card, { key: "Delete" });
  await waitFor(() =>
    expect(api.mutate).toHaveBeenCalledWith(1, {
      type: "moveThread",
      id: "t",
      groupId: null,
      beforeId: null,
    }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "API の確認 を選択" }),
    ),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Delete" });
  expect(api.mutate).toHaveBeenCalledTimes(1);
  expect(api.readThread).not.toHaveBeenCalled();
});

it("supports Delete for the open chat but ignores editing, modifiers and repeated keys", async () => {
  const board = fixture();
  board.threads[0].groupId = "g";
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "API の確認 のチャットを表示" }),
  );
  const heading = within(screen.getByRole("complementary")).getByRole(
    "heading",
    { level: 2 },
  );
  fireEvent.keyDown(screen.getByLabelText("メッセージ"), { key: "Delete" });
  fireEvent.keyDown(screen.getByLabelText("スレッドを検索"), { key: "Delete" });
  fireEvent.keyDown(screen.getByLabelText("API の確認 の移動先"), {
    key: "Delete",
  });
  fireEvent.keyDown(heading, { key: "Delete", repeat: true });
  fireEvent.keyDown(heading, { key: "Delete", isComposing: true });
  fireEvent.keyDown(heading, { key: "Delete", ctrlKey: true });
  expect(api.mutate).not.toHaveBeenCalled();
  fireEvent.keyDown(heading, { key: "Delete" });
  await waitFor(() =>
    expect(api.mutate).toHaveBeenCalledWith(1, {
      type: "moveThread",
      id: "t",
      groupId: null,
      beforeId: null,
    }),
  );
});

it.each([null, "g"])(
  "focuses and reveals the unread card in %s, including after acknowledgement",
  async (groupId) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const board = fixture();
    board.threads[0] = {
      ...board.threads[0],
      groupId,
      unread: true,
      updatedAt: 20,
    };
    board.threads.push({
      ...board.threads[0],
      id: "other",
      title: "残る未読",
      updatedAt: 10,
    });
    vi.mocked(api.board).mockResolvedValue(board);
    vi.mocked(api.refresh).mockResolvedValue(board);
    vi.mocked(api.readThread).mockResolvedValue({
      messages: [],
      nextCursor: null,
      observedUpdatedAt: 20,
    });
    let acknowledge!: (board: Board) => void;
    vi.mocked(api.markThreadRead).mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<App />);
    const card = await screen.findByRole("button", {
      name: groupId ? "API の確認 のチャットを表示" : "API の確認 を選択",
    });
    const scroll = vi.fn();
    card.scrollIntoView = scroll;
    const chip = screen.getByRole("button", {
      name: "未読: API の確認 のチャットを表示",
    });
    await user.click(chip);
    expect(document.activeElement).toBe(card);
    expect(scroll).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
      behavior: "auto",
    });
    scroll.mockClear();
    await user.click(chip);
    expect(document.activeElement).toBe(card);
    expect(scroll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.markThreadRead).toHaveBeenCalled());
    scroll.mockClear();
    await act(async () =>
      acknowledge({
        ...board,
        revision: 2,
        threads: board.threads.map((t) =>
          t.id === "t" ? { ...t, unread: false } : t,
        ),
      }),
    );
    expect(document.activeElement).toBe(card);
    expect(scroll).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", {
        name: "未読: API の確認 のチャットを表示",
      }),
    ).toBeNull();
  },
);

it("shows the five most recent active threads and opens their cards", async () => {
  const board = fixture();
  board.threads = Array.from({ length: 7 }, (_, i) => ({
    ...board.threads[0],
    id: `recent-${i}`,
    title: `最近の会話${i}`,
    updatedAt: i + 1,
    archived: i === 6,
  }));
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  render(<App />);
  const nav = await screen.findByRole("navigation", {
    name: "最近のスレッド一覧",
  });
  expect(
    within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual([
    "最近の会話5",
    "最近の会話4",
    "最近の会話3",
    "最近の会話2",
    "最近の会話1",
  ]);
  await userEvent.click(within(nav).getAllByRole("button")[0]);
  await within(screen.getByRole("complementary")).findByRole("heading", {
    name: "最近の会話5",
  });
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "最近の会話5 を選択",
    ),
  );
});

it("registers favorites below recent conversations without opening chat, persists and removes them", async () => {
  const user = userEvent.setup();
  const view = render(<App />);
  await user.click(
    await screen.findByRole("button", {
      name: "API の確認 をお気に入りに登録",
    }),
  );
  const favorites = screen.getByRole("navigation", {
    name: "お気に入りスレッド一覧",
  });
  const recent = screen.getByRole("navigation", { name: "最近のスレッド一覧" });
  expect(
    recent.compareDocumentPosition(favorites) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    within(favorites).getByRole("button", {
      name: "お気に入り: API の確認 のチャットを表示",
    }),
  ).toBeTruthy();
  expect(api.readThread).not.toHaveBeenCalled();
  expect(api.mutate).not.toHaveBeenCalled();
  view.unmount();
  render(<App />);
  const remove = await screen.findByRole("button", {
    name: "API の確認 をお気に入りから解除",
  });
  expect(remove.getAttribute("aria-pressed")).toBe("true");
  await user.click(
    screen.getByRole("button", {
      name: "お気に入り: API の確認 のチャットを表示",
    }),
  );
  await screen.findByText("確認しました");
  await user.click(remove);
  expect(
    screen.queryByRole("navigation", { name: "お気に入りスレッド一覧" }),
  ).toBeNull();
  expect(
    JSON.parse(localStorage.getItem("treadcraft.favoriteThreads.v1")!),
  ).toEqual([]);
  expect(
    screen.getByRole("heading", { name: "API の確認", level: 3 }),
  ).toBeTruthy();
});

it("keeps favorites in registration order across refresh and hides archived entries", async () => {
  const board = fixture();
  board.threads.push({ ...board.threads[0], id: "second", title: "二番目" });
  board.threads.push({
    ...board.threads[0],
    id: "archived",
    title: "保存済み",
    archived: true,
  });
  localStorage.setItem(
    "treadcraft.favoriteThreads.v1",
    JSON.stringify(["second", "t", "archived", "missing"]),
  );
  vi.mocked(api.board).mockResolvedValue(board);
  vi.mocked(api.refresh).mockResolvedValue(board);
  render(<App />);
  const favorites = await screen.findByRole("navigation", {
    name: "お気に入りスレッド一覧",
  });
  expect(
    within(favorites)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["二番目", "API の確認"]);
  await userEvent.click(screen.getByRole("button", { name: "↻ 更新" }));
  expect(within(favorites).getAllByRole("button")).toHaveLength(2);
});

it("reports favorite storage failures without showing an unsaved favorite", async () => {
  render(<App />);
  const add = await screen.findByRole("button", {
    name: "API の確認 をお気に入りに登録",
  });
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("full");
    });
  try {
    await userEvent.click(add);
    expect(
      await screen.findByText(
        "お気に入りを保存できませんでした。もう一度お試しください。",
      ),
    ).toBeTruthy();
    expect(add.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.queryByRole("navigation", { name: "お気に入りスレッド一覧" }),
    ).toBeNull();
  } finally {
    storage.mockRestore();
  }
});
