import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  api,
  errorMessage,
  newerBoard,
  visibleThreads,
  type Board,
  type Group,
  type Mutation,
  type Thread,
  type SendOptions,
  type ImageAttachment,
  type QueuedMessage,
} from "./api";
import ChatPane from "./ChatPane";
import { loadPermission, savePermission } from "./permissionPreferences";
import { loadFavorites, saveFavorites } from "./favoritePreferences";

type Drag = { kind: "thread" | "group"; id: string };
type Dialog = { kind: "create" } | { kind: "rename" | "delete"; group: Group };
const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function App() {
  const isMac = /Mac/i.test(navigator.platform);
  const [board, setBoard] = useState<Board | null>(null);
  const [favorites, setFavorites] = useState(loadFavorites);
  const [favoriteError, setFavoriteError] = useState("");
  function toggleFavorite(id: string) {
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (!saveFavorites(next)) {
      setFavoriteError(
        "お気に入りを保存できませんでした。もう一度お試しください。",
      );
      return;
    }
    setFavorites(next);
    setFavoriteError("");
  }
  const [selected, setSelected] = useState<Thread | null>(null);
  const [chatAutoFocus, setChatAutoFocus] = useState(true);
  const [chatOpenVersion, setChatOpenVersion] = useState(0);
  const pendingThreadFocus = useRef<Thread | null>(null);
  const [runningThreads, setRunningThreads] = useState<Thread[]>([]);
  const [focusRequest, setFocusRequest] = useState(0);
  const queues = useRef(new Map<string, QueuedMessage[]>());
  const imageDrafts = useRef(new Map<string, ImageAttachment[]>());
  const drafts = useRef(new Map<string, string>());
  const [defaultPermission, setDefaultPermission] = useState(loadPermission);
  const modelOptions = useRef(new Map<string, SendOptions>());
  const inboxPane = useRef<HTMLElement>(null);
  const pendingInboxFocus = useRef<{ id: string; index: number } | null>(null);
  function selectThread(thread: Thread) {
    setChatAutoFocus(true);
    setSelected(thread);
  }
  const [openingEditor, setOpeningEditor] = useState<string | null>(null);
  const editorLock = useRef(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [newChat, setNewChat] = useState(false);
  const [settings, setSettings] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string | null>(null);
  const dragging = useRef<Drag | null>(null);
  const mutationLock = useRef(false);
  const groupPanes = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const thread = pendingThreadFocus.current;
    if (!thread) return;
    const pane = thread.groupId
      ? groupPanes.current.get(thread.groupId)
      : inboxPane.current;
    const card = Array.from(
      pane?.querySelectorAll<HTMLElement>("[data-thread-id]") ?? [],
    ).find((element) => element.dataset.threadId === thread.id);
    const button = card?.querySelector<HTMLButtonElement>(".thread-open");
    if (!button) return;
    pendingThreadFocus.current = null;
    button.focus({ preventScroll: true });
    button.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: "auto",
    });
  }, [chatOpenVersion, collapsed, focusRequest, search]);

  useEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches(".thread-open")) {
      // Reading a thread can move its card below the remaining unread cards.
      focused.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
        behavior: "auto",
      });
    }
  }, [board]);

  function focusThreadCard(targetThread: Thread) {
    const thread =
      board?.threads.find((t) => t.id === targetThread.id) ?? targetThread;
    pendingThreadFocus.current = thread;
    setSearch("");
    if (thread.groupId)
      setCollapsed((previous) => {
        const next = new Set(previous);
        next.delete(thread.groupId!);
        return next;
      });
    setChatAutoFocus(false);
    setSelected(thread);
    // Do not change the chat key: remounting would detach its active stream.
    setFocusRequest((value) => value + 1);
  }
  useEffect(() => {
    function focusGroup(event: globalThis.KeyboardEvent) {
      const element = event.target instanceof HTMLElement ? event.target : null;
      if (
        !event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        event.defaultPrevented ||
        dialog ||
        settings ||
        newChat ||
        element?.closest(
          "input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],dialog",
        )
      )
        return;
      // Shift changes key into punctuation (e.g. !); code preserves the digit.
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1];
      if (!digit) return;
      const group = board?.groups[Number(digit) - 1];
      const pane = group && groupPanes.current.get(group.id);
      if (!pane) return;
      event.preventDefault();
      pane.focus({ preventScroll: true });
      pane.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
        behavior: "auto",
      });
    }
    window.addEventListener("keydown", focusGroup);
    return () => window.removeEventListener("keydown", focusGroup);
  }, [board?.groups, dialog, settings, newChat]);
  const refreshLock = useRef(false);
  const retries = useRef(0);
  const accept = useCallback(
    (next: Board) => setBoard((current) => newerBoard(current, next)),
    [],
  );
  const load = useCallback(async () => {
    try {
      accept(await api.board());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [accept]);
  const refresh = useCallback(async () => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setSyncing(true);
    try {
      accept(await api.refresh());
      setSyncError("");
      retries.current = 0;
    } catch (e) {
      setSyncError(errorMessage(e));
      retries.current = Math.min(retries.current + 1, 4);
    } finally {
      refreshLock.current = false;
      setSyncing(false);
    }
  }, [accept]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === "visible") await refresh();
      if (!disposed) timer = setTimeout(tick, 30000 * 2 ** retries.current);
    };
    void load().then(() => {
      if (!disposed) void tick();
    });
    const focus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
    };
  }, [load, refresh]);

  async function mutate(mutation: Mutation): Promise<boolean> {
    if (!board || mutationLock.current) return false;
    mutationLock.current = true;
    setBusy(true);
    setError("");
    try {
      accept(await api.mutate(board.revision, mutation));
      return true;
    } catch (e) {
      setError(errorMessage(e));
      await load();
      return false;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  function start(e: DragEvent, payload: Drag) {
    if (busy) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    dragging.current = payload;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-treadcraft", JSON.stringify(payload));
  }
  function end() {
    dragging.current = null;
    setTarget(null);
  }
  function over(e: DragEvent, key: string, kind: Drag["kind"]) {
    if (!busy && dragging.current?.kind === kind) {
      e.preventDefault();
      e.stopPropagation();
      setTarget(key);
      e.dataTransfer.dropEffect = "move";
    }
  }
  function dropThread(
    e: DragEvent,
    groupId: string | null,
    beforeId: string | null = null,
  ) {
    const drag = dragging.current;
    if (drag?.kind !== "thread") return;
    e.preventDefault();
    e.stopPropagation();
    end();
    const current = board?.threads.find((t) => t.id === drag.id);
    if (
      !current ||
      busy ||
      drag.id === beforeId ||
      (search.trim() && current.groupId === groupId)
    )
      return;
    void mutate({
      type: "moveThread",
      id: drag.id,
      groupId,
      beforeId: search.trim() ? null : beforeId,
    });
  }
  function dropGroup(e: DragEvent, beforeId: string | null) {
    const drag = dragging.current;
    if (drag?.kind !== "group") return;
    e.preventDefault();
    e.stopPropagation();
    end();
    if (!search.trim() && drag.id !== beforeId)
      void mutate({ type: "reorderGroup", id: drag.id, beforeId });
  }
  function card(t: Thread) {
    return (
      <article
        key={t.id}
        data-thread-id={t.id}
        className={`thread ${selected?.id === t.id ? "selected" : ""} ${target === t.id ? "drop-before" : ""}`}
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button,select,input")) {
            if (t.groupId === null)
              event.currentTarget
                .querySelector<HTMLButtonElement>(".thread-open")
                ?.focus();
            else selectThread(t);
          }
        }}
        onDragOver={(e) => over(e, t.id, "thread")}
        onDrop={(e) => dropThread(e, t.groupId, t.groupId ? t.id : null)}
      >
        <button
          className="handle"
          aria-label={`${t.title} をドラッグ`}
          draggable={!busy}
          onDragStart={(e) => start(e, { kind: "thread", id: t.id })}
          onDragEnd={end}
          disabled={busy}
        >
          ⠿
        </button>
        <button
          className="thread-body thread-open"
          aria-label={
            t.groupId === null
              ? `${t.title} を選択`
              : `${t.title} のチャットを表示`
          }
          title={
            t.groupId === null
              ? "クリックで選択・Enterでチャットを表示"
              : undefined
          }
          aria-pressed={selected?.id === t.id}
          onClick={(event) => {
            if (t.groupId === null) event.currentTarget.focus();
            else selectThread(t);
          }}
          onKeyDown={(event) => {
            if (
              t.groupId === null &&
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.shiftKey
            ) {
              event.preventDefault();
              selectThread(t);
            }
          }}
        >
          <h3>
            {t.unread ? (
              <span
                className="unread-dot"
                aria-label="未読"
                title="treadcraft で前回閲覧後に更新されています"
              />
            ) : null}
            {t.title}
          </h3>
          <p title={t.cwd}>
            {t.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "作業場所不明"}{" "}
            <span>· {date(t.createdAt)}</span>
          </p>
        </button>
        <div className="thread-actions">
          <button
            className="favorite-toggle"
            aria-label={`${t.title} をお気に入り${favorites.has(t.id) ? "から解除" : "に登録"}`}
            aria-pressed={favorites.has(t.id)}
            title={
              favorites.has(t.id) ? "お気に入りから解除" : "お気に入りに登録"
            }
            onClick={(event) => {
              event.stopPropagation();
              toggleFavorite(t.id);
            }}
          >
            <span aria-hidden="true">{favorites.has(t.id) ? "★" : "☆"}</span>
          </button>
          <button
            className="open-editor"
            aria-label={`${t.title} のワークスペースを Zed で開く`}
            title={t.cwd || "作業フォルダ不明"}
            disabled={!t.cwd || openingEditor !== null}
            onClick={async (event) => {
              event.stopPropagation();
              if (editorLock.current) return;
              editorLock.current = true;
              setOpeningEditor(t.id);
              setError("");
              try {
                await api.openInZed(t.id);
              } catch (error) {
                setError(errorMessage(error));
              } finally {
                editorLock.current = false;
                setOpeningEditor(null);
              }
            }}
          >
            {openingEditor === t.id ? "起動中…" : "Zedで開く ↗"}
          </button>
          <select
            aria-label={`${t.title} の移動先`}
            value={t.groupId ?? ""}
            disabled={busy}
            onChange={(e) =>
              void mutate({
                type: "moveThread",
                id: t.id,
                groupId: e.target.value || null,
                beforeId: null,
              })
            }
          >
            <option value="">未分類</option>
            {board?.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      </article>
    );
  }
  const inbox = board ? visibleThreads(board, null, search) : [];
  useEffect(() => {
    const pending = pendingInboxFocus.current;
    if (
      !pending ||
      !board ||
      visibleThreads(board, null, search).some((t) => t.id === pending.id)
    )
      return;
    pendingInboxFocus.current = null;
    const pane = inboxPane.current;
    if (
      !pane ||
      (document.activeElement !== document.body &&
        !pane.contains(document.activeElement))
    )
      return;
    const buttons = pane.querySelectorAll<HTMLButtonElement>(".thread-open");
    (buttons[Math.min(pending.index, buttons.length - 1)] ?? pane).focus();
  }, [board, search]);

  function inboxKeyDown(event: KeyboardEvent<HTMLElement>) {
    const element = event.target as HTMLElement;
    if (
      event.nativeEvent.isComposing ||
      element.closest("input,textarea,select,[contenteditable=true]") ||
      event.altKey ||
      event.shiftKey
    )
      return;
    const id =
      element.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId;
    const index = inbox.findIndex((t) => t.id === id);
    if (index < 0) return;
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      const next = Math.max(
        0,
        Math.min(
          inbox.length - 1,
          index + (event.key === "ArrowDown" ? 1 : -1),
        ),
      );
      inboxPane.current
        ?.querySelectorAll<HTMLButtonElement>(".thread-open")
        [next]?.focus();
      return;
    }
    const modifier = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!modifier || !/^[1-9]$/.test(event.key)) return;
    event.preventDefault();
    const group = board?.groups[Number(event.key) - 1];
    if (!group || event.repeat || mutationLock.current) return;
    pendingInboxFocus.current = { id: inbox[index].id, index };
    void mutate({
      type: "moveThread",
      id: inbox[index].id,
      groupId: group.id,
      beforeId: null,
    }).then((success) => {
      if (!success) pendingInboxFocus.current = null;
    });
  }
  const unreadThreads = (board?.threads ?? [])
    .filter((thread) => thread.unread && !thread.archived)
    .sort(
      (a, b) =>
        (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const recentThreads = (board?.threads ?? [])
    .filter((thread) => !thread.archived)
    .sort(
      (a, b) =>
        (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 5);
  const activeCount = board?.threads.filter((t) => !t.archived).length ?? 0;
  const threadsById = new Map(
    board?.threads.map((thread) => [thread.id, thread]),
  );
  const favoriteThreads = [...favorites].flatMap((id) => {
    const thread = threadsById.get(id);
    return thread && !thread.archived ? [thread] : [];
  });
  function unclassifySelected(event: KeyboardEvent<HTMLElement>) {
    const element = event.target as HTMLElement;
    if (
      event.key !== "Delete" ||
      event.defaultPrevented ||
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      dialog ||
      newChat ||
      settings ||
      mutationLock.current ||
      element.closest(
        "input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],dialog",
      )
    )
      return;
    const focusedId =
      element.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId;
    const thread = board?.threads.find(
      (item) => item.id === (focusedId ?? selected?.id),
    );
    if (!thread || thread.archived || thread.groupId === null) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = document.activeElement;
    void mutate({
      type: "moveThread",
      id: thread.id,
      groupId: null,
      beforeId: null,
    }).then((success) => {
      if (
        !success ||
        (document.activeElement !== origin &&
          document.activeElement !== document.body)
      )
        return;
      pendingThreadFocus.current = { ...thread, groupId: null };
      setFocusRequest((value) => value + 1);
    });
  }
  function groupKeyDown(event: KeyboardEvent<HTMLElement>, groupId: string) {
    const element = event.target as HTMLElement;
    if (
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      event.altKey ||
      event.shiftKey ||
      element.closest(
        "input,textarea,select,[contenteditable]:not([contenteditable=false])",
      )
    )
      return;
    const modifier = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (modifier && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!board || event.repeat) return;
      const latest = visibleThreads(board, groupId, search)
        .filter((thread) => thread.unread)
        .reduce<Thread | null>(
          (result, thread) =>
            !result ||
            (thread.updatedAt ?? thread.createdAt) >
              (result.updatedAt ?? result.createdAt)
              ? thread
              : result,
          null,
        );
      if (!latest) return;
      pendingThreadFocus.current = latest;
      setCollapsed((previous) => {
        const next = new Set(previous);
        next.delete(groupId);
        return next;
      });
      setChatAutoFocus(false);
      setSelected(latest);
      setChatOpenVersion((version) => version + 1);
      return;
    }
    if (
      event.ctrlKey ||
      event.metaKey ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
    )
      return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(".thread-open"),
    );
    if (!buttons.length) return;
    const card = element.closest("[data-thread-id]");
    const index = buttons.findIndex((button) => card?.contains(button));
    const next =
      index < 0
        ? event.key === "ArrowDown"
          ? 0
          : buttons.length - 1
        : Math.max(
            0,
            Math.min(
              buttons.length - 1,
              index + (event.key === "ArrowDown" ? 1 : -1),
            ),
          );
    event.preventDefault();
    event.stopPropagation();
    buttons[next].focus({ preventScroll: true });
    buttons[next].scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: "auto",
    });
  }
  return (
    <div
      className="app"
      onKeyDown={(e) => {
        if (e.key === "Escape") end();
        unclassifySelected(e);
      }}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">▧</span>
          <h1>
            treadcraft<span>THREAD COMMAND CENTER</span>
          </h1>
        </div>
        <div className="toolbar">
          {runningThreads.map((runningThread) => (
            <button
              key={runningThread.id}
              className="running-badge"
              aria-label={`実行中: ${runningThread.title} のチャットとスレッドへ移動`}
              title="treadcraftで実行中 · クリックでチャットとカードへ移動"
              onClick={() => focusThreadCard(runningThread)}
            >
              <span aria-hidden="true" className="running-dot" />
              <span>実行中</span>
              <span className="running-title">{runningThread.title}</span>
            </button>
          ))}
          <label className="search">
            <span aria-hidden>⌕</span>
            <input
              aria-label="スレッドを検索"
              placeholder="スレッドを検索…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <button onClick={() => void refresh()} disabled={syncing || !board}>
            {syncing ? "同期中…" : "↻ 更新"}
          </button>
          <button aria-label="接続設定" onClick={() => setSettings(true)}>
            設定
          </button>
        </div>
        {unreadThreads.length ? (
          <nav className="unread-chips" aria-label="未読スレッド一覧">
            <span className="unread-chips-label">
              未読 {unreadThreads.length}
            </span>
            <div className="unread-chips-list">
              {unreadThreads.map((thread) => (
                <button
                  key={thread.id}
                  className="unread-chip"
                  aria-label={"未読: " + thread.title + " のチャットを表示"}
                  title={thread.title}
                  aria-pressed={selected?.id === thread.id}
                  onClick={() => focusThreadCard(thread)}
                >
                  <span className="unread-dot" aria-hidden="true" />
                  <span className="unread-chip-title">{thread.title}</span>
                </button>
              ))}
            </div>
          </nav>
        ) : null}
        {recentThreads.length > 0 && (
          <nav className="unread-chips" aria-label="最近のスレッド一覧">
            <span className="unread-chips-label">最近の会話</span>
            <div className="unread-chips-list">
              {recentThreads.map((thread) => (
                <button
                  key={thread.id}
                  className="unread-chip"
                  aria-label={`最近: ${thread.title} のチャットを表示`}
                  title={thread.title}
                  aria-pressed={selected?.id === thread.id}
                  onClick={() => focusThreadCard(thread)}
                >
                  <span className="unread-chip-title">{thread.title}</span>
                </button>
              ))}
            </div>
          </nav>
        )}
        {favoriteThreads.length > 0 && (
          <nav
            className="unread-chips favorite-chips"
            aria-label="お気に入りスレッド一覧"
          >
            <span className="unread-chips-label">お気に入り</span>
            <div className="unread-chips-list">
              {favoriteThreads.map((thread) => (
                <button
                  key={thread.id}
                  className="unread-chip"
                  aria-label={`お気に入り: ${thread.title} のチャットを表示`}
                  title={thread.title}
                  aria-pressed={selected?.id === thread.id}
                  onClick={() => focusThreadCard(thread)}
                >
                  {thread.unread && (
                    <span className="unread-dot" aria-label="未読" />
                  )}
                  <span className="unread-chip-title">{thread.title}</span>
                </button>
              ))}
            </div>
          </nav>
        )}
      </header>
      {favoriteError && (
        <p role="alert" className="notice error">
          {favoriteError}
        </p>
      )}
      <div className="statusbar">
        <span className={`status-dot ${syncError ? "offline" : ""}`} />{" "}
        <span>
          {syncing
            ? "Codex から一覧を取得中"
            : syncError
              ? "オフライン · キャッシュを表示"
              : board?.lastSync
                ? "Codex · ローカル分類"
                : "Codex · 未同期"}
        </span>
        <span className="status-right">
          {activeCount} THREADS{" "}
          {board?.lastSync ? ` / 最終同期 ${date(board.lastSync)}` : ""}
        </span>
      </div>
      {error ? (
        <div role="alert" className="notice error">
          {error}
          <button
            onClick={() => {
              setError("");
              void load();
            }}
          >
            再読み込み
          </button>
        </div>
      ) : null}
      {syncError ? (
        <div role="status" className="notice">
          {syncError} 分類は引き続き編集できます。
        </div>
      ) : null}
      <main className={`board ${selected ? "with-chat" : ""}`} aria-busy={busy}>
        <div
          className="kanban-board"
          role="region"
          aria-label="スレッドのカンバンボード"
        >
          <section
            aria-labelledby="inbox-title"
            ref={inboxPane}
            tabIndex={-1}
            onKeyDown={inboxKeyDown}
            className={`inbox pane ${target === "inbox" ? "drop-active" : ""}`}
            onDragOver={(e) => over(e, "inbox", "thread")}
            onDrop={(e) => dropThread(e, null)}
          >
            <div className="pane-heading">
              <div>
                <span className="eyebrow">INBOX</span>
                <h2 id="inbox-title">
                  未分類 <span className="count">{inbox.length}</span>
                  {inbox.some((t) => t.unread) ? (
                    <span className="unread-count">
                      未読 {inbox.filter((t) => t.unread).length}
                    </span>
                  ) : null}
                </h2>
              </div>
              <span className="caption">作成日時 · 新しい順</span>
            </div>
            <p className="pane-description">
              スレッドをグループへドラッグして編成
            </p>
            <div className="thread-list">
              {!board ? (
                <Empty
                  title={error ? "データを読み込めません" : "読み込み中…"}
                  text="デスクトップアプリからローカルのスレッドに接続します。"
                />
              ) : inbox.length ? (
                inbox.map(card)
              ) : (
                <Empty
                  title={
                    search
                      ? "一致するスレッドはありません"
                      : "未分類のスレッドはありません"
                  }
                  text="ここへドロップするとグループから外せます。"
                />
              )}
            </div>
            <div className="inbox-footer">
              ↑↓ 選択 · Enter チャット · {isMac ? "⌘" : "Ctrl"}＋1〜9
              グループへ分類
              <br />↙ ここへ戻して分類を解除
            </div>
            <button
              className="new-chat-button primary"
              aria-label="新しいチャットを開始"
              title="新しいチャットを開始"
              disabled={!board || busy}
              onClick={() => setNewChat(true)}
            >
              <span aria-hidden="true">＋</span>
            </button>
          </section>
          <div
            className="group-scroll"
            role="region"
            aria-label="グループの横スクロール領域"
            tabIndex={0}
            onDragOverCapture={(e) => {
              if (!dragging.current) return;
              const viewport = e.currentTarget;
              const bounds = viewport.getBoundingClientRect();
              const edge = Math.min(48, bounds.width / 4);
              if (e.clientX < bounds.left + edge) viewport.scrollLeft -= 24;
              else if (e.clientX > bounds.right - edge)
                viewport.scrollLeft += 24;
            }}
          >
            <section
              aria-labelledby="groups-title"
              className="groups pane"
              onDragOver={(e) => {
                if (!search.trim()) over(e, "groups-end", "group");
              }}
              onDrop={(e) => dropGroup(e, null)}
            >
              <div className="pane-heading">
                <div>
                  <span className="eyebrow">YOUR SQUADS</span>
                  <h2 id="groups-title">
                    グループ{" "}
                    <span className="count">{board?.groups.length ?? 0}</span>
                  </h2>
                </div>
                <button
                  className="primary"
                  disabled={!board || busy}
                  onClick={() => setDialog({ kind: "create" })}
                >
                  ＋ グループ作成
                </button>
              </div>
              <p className="pane-description">
                Shift＋1〜9 グループへ · ↑↓ スレッド選択 · Enter チャット ·
                Delete 未分類へ
              </p>
              <div className="group-list">
                {board?.groups.map((g, index) => {
                  const threads = visibleThreads(board, g.id, search);
                  const closed = collapsed.has(g.id);
                  return (
                    <section
                      key={g.id}
                      ref={(element) => {
                        if (element) groupPanes.current.set(g.id, element);
                        else groupPanes.current.delete(g.id);
                      }}
                      tabIndex={-1}
                      onKeyDown={(event) => groupKeyDown(event, g.id)}
                      className={`group ${target === g.id ? "drop-active" : ""} ${target === `group-${g.id}` ? "drop-before" : ""}`}
                      aria-label={g.name}
                      onDragOver={(e) => {
                        if (
                          dragging.current?.kind === "group" &&
                          !search.trim()
                        )
                          over(e, `group-${g.id}`, "group");
                        else over(e, g.id, "thread");
                      }}
                      onDrop={(e) => {
                        if (dragging.current?.kind === "group")
                          dropGroup(e, g.id);
                        else dropThread(e, g.id);
                      }}
                    >
                      <div className="group-heading">
                        <button
                          className="handle"
                          aria-label={`${g.name} をドラッグ`}
                          disabled={busy || !!search.trim()}
                          draggable={!busy && !search.trim()}
                          onDragStart={(e) =>
                            start(e, { kind: "group", id: g.id })
                          }
                          onDragEnd={end}
                        >
                          ⠿
                        </button>
                        <button
                          className="group-title"
                          aria-expanded={!closed}
                          onClick={() =>
                            setCollapsed((previous) => {
                              const next = new Set(previous);
                              if (next.has(g.id)) next.delete(g.id);
                              else next.add(g.id);
                              return next;
                            })
                          }
                        >
                          <span aria-hidden>{closed ? "▸" : "▾"}</span>
                          <span>{g.name}</span>
                          <span className="count">{threads.length}</span>
                          {threads.some((t) => t.unread) ? (
                            <span className="unread-count">
                              未読 {threads.filter((t) => t.unread).length}
                            </span>
                          ) : null}
                        </button>
                        <button
                          aria-label={`${g.name} を左へ`}
                          disabled={busy || index === 0 || !!search.trim()}
                          onClick={() =>
                            void mutate({
                              type: "reorderGroup",
                              id: g.id,
                              beforeId: board.groups[index - 1].id,
                            })
                          }
                        >
                          ←
                        </button>
                        <button
                          aria-label={`${g.name} を右へ`}
                          disabled={
                            busy ||
                            index === board.groups.length - 1 ||
                            !!search.trim()
                          }
                          onClick={() =>
                            void mutate({
                              type: "reorderGroup",
                              id: g.id,
                              beforeId: board.groups[index + 2]?.id ?? null,
                            })
                          }
                        >
                          →
                        </button>
                        <button
                          disabled={busy}
                          aria-label={`${g.name} の名前変更`}
                          onClick={() =>
                            setDialog({ kind: "rename", group: g })
                          }
                        >
                          編集
                        </button>
                        <button
                          disabled={busy}
                          className="delete"
                          aria-label={`${g.name} を削除`}
                          onClick={() =>
                            setDialog({ kind: "delete", group: g })
                          }
                        >
                          ×
                        </button>
                      </div>
                      {!closed ? (
                        <div className="group-content">
                          {threads.length ? (
                            threads.map(card)
                          ) : (
                            <div className="drop-placeholder">
                              {search
                                ? "一致するスレッドはありません"
                                : "＋ スレッドをここへドロップ"}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </section>
                  );
                })}
                {board && !board.groups.length ? (
                  <Empty
                    title="最初のグループを編成しよう"
                    text="「グループ作成」から始められます。会話の内容は変更しません。"
                  />
                ) : null}
              </div>
              {target === "groups-end" ? (
                <div className="drop-placeholder">末尾へ移動</div>
              ) : null}
            </section>
          </div>
        </div>
        {[...runningThreads, selected]
          .filter(
            (thread, index, threads): thread is Thread =>
              thread !== null &&
              threads.findIndex((item) => item?.id === thread.id) === index,
          )
          .map((thread) => (
            <ChatPane
              key={thread.id}
              visible={selected?.id === thread.id}
              autoFocus={chatAutoFocus && selected?.id === thread.id}
              thread={board?.threads.find((t) => t.id === thread.id) ?? thread}
              onReadBoard={accept}
              onFork={(result) => {
                accept(result.board);
                const fork = result.board.threads.find(
                  (item) => item.id === result.threadId,
                );
                if (fork) {
                  setChatAutoFocus(true);
                  setSelected(fork);
                }
              }}
              initialQueue={queues.current.get(thread.id)}
              onQueueChange={(queue) => queues.current.set(thread.id, queue)}
              initialImages={imageDrafts.current.get(thread.id)}
              onImagesChange={(images) =>
                imageDrafts.current.set(thread.id, images)
              }
              initialDraft={drafts.current.get(thread.id) ?? ""}
              initialOptions={modelOptions.current.get(thread.id)}
              permission={defaultPermission}
              onOptionsChange={(options) => {
                modelOptions.current.set(thread.id, options);
                if (
                  options.permission &&
                  options.permission !== defaultPermission
                ) {
                  setDefaultPermission(options.permission);
                  if (!savePermission(options.permission))
                    setError(
                      "実行権限を保存できませんでした。今回の起動中のみ適用します。",
                    );
                }
              }}
              onDraftChange={(text) => drafts.current.set(thread.id, text)}
              onBusyChange={(busy) => {
                if (!busy) void refresh();
                setRunningThreads((current) =>
                  busy
                    ? current.some((item) => item.id === thread.id)
                      ? current
                      : [...current, thread]
                    : current.filter((item) => item.id !== thread.id),
                );
              }}
              close={() => setSelected(null)}
            />
          ))}
      </main>
      {newChat && board ? (
        <NewChatDialog
          board={board}
          initialCwd={selected?.cwd ?? ""}
          initialGroupId={selected?.groupId ?? ""}
          close={() => setNewChat(false)}
          created={({ board: next, threadId }) => {
            accept(next);
            setSearch("");
            const thread = next.threads.find((item) => item.id === threadId);
            if (thread) {
              if (thread.groupId)
                setCollapsed((previous) => {
                  const expanded = new Set(previous);
                  expanded.delete(thread.groupId!);
                  return expanded;
                });
              selectThread(thread);
            }
            setNewChat(false);
          }}
        />
      ) : null}
      {dialog ? (
        <GroupDialog
          error={error}
          key={dialog.kind + ("group" in dialog ? dialog.group.id : "")}
          dialog={dialog}
          count={
            board?.threads.filter(
              (t) => t.groupId === ("group" in dialog ? dialog.group.id : ""),
            ).length ?? 0
          }
          busy={busy}
          close={() => setDialog(null)}
          submit={async (name) => {
            const mutation: Mutation =
              dialog.kind === "create"
                ? { type: "createGroup", name }
                : dialog.kind === "rename"
                  ? { type: "renameGroup", id: dialog.group.id, name }
                  : { type: "deleteGroup", id: dialog.group.id };
            if (await mutate(mutation)) setDialog(null);
          }}
        />
      ) : null}
      {settings ? (
        <Modal title="接続について" close={() => setSettings(false)}>
          <p>
            導入済みの Codex CLI（0.153.4 以降）から一覧を取得します。CLI / VS
            Code / App Server のスレッドが対象です。
          </p>
          <p>
            CLI が見つからない場合は、起動時の環境変数{" "}
            <code>TREADCRAFT_CODEX_BIN</code>{" "}
            に実行ファイルの絶対パスを指定してください。
          </p>
          <p>
            分類はこの端末の SQLite に保存します。Codex のセクションや通常の
            ChatGPT 会話とは同期しません。
          </p>
          <button className="primary" onClick={() => setSettings(false)}>
            閉じる
          </button>
        </Modal>
      ) : null}
    </div>
  );
}

function NewChatDialog({
  board,
  initialCwd,
  initialGroupId,
  close,
  created,
}: {
  board: Board;
  initialCwd: string;
  initialGroupId: string;
  close: () => void;
  created: (result: { board: Board; threadId: string }) => void;
}) {
  const workspaces = [
    ...new Set(board.threads.map((thread) => thread.cwd).filter(Boolean)),
  ].sort();
  const [cwd, setCwd] = useState(initialCwd || workspaces[0] || "");
  const [groupId, setGroupId] = useState(initialGroupId);
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const matchingWorkspaces = workspaces.filter((path) =>
    path
      .toLocaleLowerCase()
      .includes(workspaceSearch.trim().toLocaleLowerCase()),
  );
  const [custom, setCustom] = useState(!workspaces.length);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const composing = useRef(false);
  const valid =
    !!cwd.trim() &&
    (!groupId || board.groups.some((group) => group.id === groupId));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || lock.current || composing.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      created(await api.createThread(cwd.trim(), groupId || null));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return (
    <Modal title="新しいチャット" close={close} locked={pending}>
      <p>作業するワークスペースと、会話を整理するグループを選んでください。</p>
      <form
        className="new-chat-form"
        onSubmit={submit}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
      >
        <label className="field">
          ワークスペースを検索
          <input
            type="search"
            autoFocus
            value={workspaceSearch}
            disabled={pending}
            placeholder="フォルダ名・パスで絞り込み…"
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            onChange={(event) => {
              const query = event.target.value;
              setWorkspaceSearch(query);
              if (!custom) {
                const matches = workspaces.filter((path) =>
                  path
                    .toLocaleLowerCase()
                    .includes(query.trim().toLocaleLowerCase()),
                );
                if (!matches.includes(cwd)) setCwd(matches[0] ?? "");
              }
            }}
          />
        </label>
        <label className="field">
          ワークスペース
          <select
            value={custom ? "" : cwd || "__no_workspace__"}
            disabled={pending}
            onChange={(event) => {
              const value = event.target.value;
              setCustom(!value);
              setCwd(value);
            }}
          >
            {!custom && !cwd ? (
              <option value="__no_workspace__" disabled>
                候補がありません
              </option>
            ) : null}
            {matchingWorkspaces.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
            <option value="">別のフォルダを指定…</option>
          </select>
        </label>
        <small role="status">
          {matchingWorkspaces.length
            ? `${matchingWorkspaces.length} 件の候補`
            : "一致するワークスペースはありません。「別のフォルダを指定…」から入力できます。"}
        </small>
        {custom ? (
          <label className="field">
            フォルダの絶対パス
            <input
              required
              value={cwd}
              disabled={pending}
              placeholder="/Users/you/projects/my-project"
              onChange={(event) => setCwd(event.target.value)}
            />
          </label>
        ) : null}
        <label className="field">
          グループ
          <select
            value={groupId}
            disabled={pending}
            onChange={(event) => setGroupId(event.target.value)}
          >
            <option value="">未分類</option>
            {board.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        {error ? (
          <p className="chat-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" disabled={pending} onClick={close}>
            キャンセル
          </button>
          <button
            type="submit"
            className="primary"
            disabled={pending || !valid}
          >
            {pending ? "開始中…" : "会話を開始"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <span aria-hidden>▧</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function Modal({
  title,
  close,
  children,
  locked = false,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  locked?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!locked) close();
      }}
      aria-label={title}
    >
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

function GroupDialog({
  error,
  dialog,
  count,
  busy,
  close,
  submit,
}: {
  error: string;
  dialog: Dialog;
  count: number;
  busy: boolean;
  close: () => void;
  submit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(
    dialog.kind === "rename" ? dialog.group.name : "",
  );
  const composing = useRef(false);
  const deleting = dialog.kind === "delete";
  const valid = !!name.trim() && [...name.trim()].length <= 100;
  const title = deleting
    ? "グループを削除"
    : dialog.kind === "rename"
      ? "グループ名を変更"
      : "新しいグループ";
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!composing.current && !busy && (deleting || valid))
      void submit(name.trim());
  }
  return (
    <Modal title={title} close={close} locked={busy}>
      {error ? <p role="alert">{error}</p> : null}
      <form
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            (e.nativeEvent.isComposing ||
              composing.current ||
              e.keyCode === 229)
          )
            e.preventDefault();
        }}
      >
        {deleting ? (
          <p>
            「{dialog.group.name}」を削除します。所属する {count}{" "}
            件は未分類に戻ります。会話は削除されません。
          </p>
        ) : (
          <label className="field">
            グループ名
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              placeholder="例：リリース準備"
            />
            <small>1〜100文字</small>
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            キャンセル
          </button>
          <button
            className={deleting ? "danger" : "primary"}
            disabled={busy || (!deleting && !valid)}
          >
            {busy ? "保存中…" : deleting ? "削除する" : "保存する"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
