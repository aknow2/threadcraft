import { useEffect, useId, useRef, useState } from "react";
import {
  api,
  errorMessage,
  chatSendError,
  type ChatPage,
  type Thread,
  type ChatMessage,
  type Board,
  type ModelOption,
  type SendOptions,
  type ImageAttachment,
  type QueuedMessage,
  type InteractionRequest,
  inheritModel,
} from "./api";
import InteractionCard from "./InteractionCard";
import ModelPicker from "./ModelPicker";
import MarkdownMessage from "./MarkdownMessage";

export default function ChatPane({
  thread,
  close,
  onBusyChange,
  initialDraft = "",
  onDraftChange,
  onReadBoard,
  initialOptions = inheritModel,
  onOptionsChange,
  autoFocus = true,
  visible = true,
  permission,
  initialImages = [],
  onImagesChange,
  initialQueue = [],
  onQueueChange,
  onFork,
}: {
  onFork?: (result: { board: Board; threadId: string }) => void;
  initialQueue?: QueuedMessage[];
  onQueueChange?: (queue: QueuedMessage[]) => void;
  initialImages?: ImageAttachment[];
  onImagesChange?: (images: ImageAttachment[]) => void;
  thread: Thread;
  close: () => void;
  onBusyChange?: (busy: boolean) => void;
  initialDraft?: string;
  onDraftChange?: (text: string) => void;
  onReadBoard?: (board: Board) => void;
  initialOptions?: SendOptions;
  onOptionsChange?: (options: SendOptions) => void;
  autoFocus?: boolean;
  visible?: boolean;
  permission?: SendOptions["permission"];
}) {
  const [requests, setRequests] = useState<InteractionRequest[]>([]);
  const [forking, setForking] = useState(false);
  const forkLock = useRef(false);
  const [forkError, setForkError] = useState("");
  const [queue, setQueue] = useState(initialQueue);
  const queueRef = useRef(queue);
  const stopRequested = useRef(false);
  const [steering, setSteering] = useState(false);
  const steerLock = useRef(false);
  function updateQueue(next: QueuedMessage[]) {
    queueRef.current = next;
    setQueue(next);
    onQueueChange?.(next);
  }
  function enqueue() {
    if (
      !sendLock.current ||
      steerLock.current ||
      readingImagesRef.current ||
      thread.archived ||
      !optionsValid ||
      (!draft.trim() && !imagesRef.current.length)
    )
      return;
    updateQueue([
      ...queueRef.current,
      {
        id: crypto.randomUUID(),
        text: draft,
        images: imagesRef.current,
        options: { ...options },
      },
    ]);
    updateDraft("");
    updateImages([]);
  }
  async function steer() {
    if (
      !sendLock.current ||
      !ready ||
      stopping ||
      steerLock.current ||
      readingImagesRef.current ||
      thread.archived ||
      (!draft.trim() && !imagesRef.current.length)
    )
      return;
    steerLock.current = true;
    setSteering(true);
    setSendError("");
    const text = draft;
    const attached = imagesRef.current;
    const version = draftVersion.current;
    try {
      await api.steerMessage(thread.id, text, attached);
      if (draftVersion.current === version) updateDraft("");
      if (imagesRef.current === attached) updateImages([]);
      setLive((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          role: "user",
          text: [text, ...attached.map((image) => `添付: ${image.name}`)]
            .filter(Boolean)
            .join("\n"),
        },
      ]);
    } catch (error) {
      setSendError(`Steer: ${errorMessage(error)}`);
    } finally {
      steerLock.current = false;
      setSteering(false);
    }
  }
  const inputId = useId();
  const [images, setImages] = useState<ImageAttachment[]>(initialImages);
  const imagesRef = useRef(images);
  const [readingImages, setReadingImages] = useState(false);
  const readingImagesRef = useRef(false);
  const [draggingImages, setDraggingImages] = useState(false);
  function updateImages(next: ImageAttachment[]) {
    imagesRef.current = next;
    setImages(next);
    onImagesChange?.(next);
  }
  async function addImages(files: File[]) {
    if (thread.archived || readingImagesRef.current || !files.length) return;
    setSendError("");
    if (
      imagesRef.current.length + files.length > 4 ||
      files.some((file) => file.size > 5 * 1024 * 1024 || file.size === 0)
    ) {
      setSendError(
        "添付は合計4ファイルまで、各5MB以下の空でないファイルを指定してください。",
      );
      return;
    }
    readingImagesRef.current = true;
    setReadingImages(true);
    try {
      const added = await Promise.all(
        files.map(
          (file) =>
            new Promise<ImageAttachment>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({ name: file.name, url: String(reader.result) });
              reader.onerror = () =>
                reject(new Error("ファイルを読み込めませんでした。"));
              reader.onabort = () =>
                reject(new Error("ファイルの読み込みを中止しました。"));
              reader.readAsDataURL(
                !file.type && file.name.toLowerCase().endsWith(".pdf")
                  ? new Blob([file], { type: "application/pdf" })
                  : file,
              );
            }),
        ),
      );
      updateImages([...imagesRef.current, ...added]);
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      readingImagesRef.current = false;
      setReadingImages(false);
    }
  }

  const draftVersion = useRef(0);
  const [localOptions, setOptions] = useState(initialOptions);
  const options = permission ? { ...localOptions, permission } : localOptions;
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState("");
  const [modelsReload, setModelsReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    setModelsLoading(true);
    setModelsError("");
    void api
      .listModels()
      .then((value) => {
        if (!disposed) setModels(value);
      })
      .catch((error) => {
        if (!disposed) {
          setModels([]);
          setModelsError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!disposed) setModelsLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [modelsReload]);
  const selectedModel = models.find((m) => m.model === options.model);
  const optionsValid =
    options.model === null ||
    (!modelsLoading &&
      !!selectedModel &&
      (selectedModel.supportedReasoningEfforts.length === 0
        ? options.effort === null
        : selectedModel.supportedReasoningEfforts.some(
            (e) => e.reasoningEffort === options.effort,
          )));
  const [page, setPage] = useState<ChatPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const moreLock = useRef(false);
  const [readError, setReadError] = useState("");
  const [readRetry, setReadRetry] = useState(0);
  const observed = page?.observedUpdatedAt;
  useEffect(() => {
    if (!visible || observed == null || !onReadBoard) return;
    let disposed = false;
    let started = false;
    const acknowledge = () => {
      if (
        started ||
        document.visibilityState !== "visible" ||
        !document.hasFocus()
      )
        return;
      started = true;
      setReadError("");
      void api
        .markThreadRead(thread.id, observed)
        .then((board) => {
          if (!disposed) onReadBoard(board);
        })
        .catch(() => {
          if (!disposed)
            setReadError(
              "既読状態を保存できませんでした。未読マークは残しています。",
            );
        });
    };
    acknowledge();
    window.addEventListener("focus", acknowledge);
    document.addEventListener("visibilitychange", acknowledge);
    return () => {
      disposed = true;
      window.removeEventListener("focus", acknowledge);
      document.removeEventListener("visibilitychange", acknowledge);
    };
  }, [observed, thread.id, onReadBoard, readRetry, visible]);
  const heading = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState(initialDraft);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [ready, setReady] = useState(false);
  const [sendError, setSendError] = useState("");
  const [sendFailure, setSendFailure] = useState<ReturnType<
    typeof chatSendError
  > | null>(null);
  const [status, setStatus] = useState("");
  const [live, setLive] = useState<ChatMessage[]>([]);
  const sendLock = useRef(false);
  const messagesView = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  function updateDraft(text: string) {
    draftVersion.current++;
    setDraft(text);
    onDraftChange?.(text);
  }
  useEffect(() => {
    const view = messagesView.current;
    if (view && follow.current) view.scrollTop = view.scrollHeight;
  }, [page, live]);

  async function sendMessage(queued?: QueuedMessage): Promise<void> {
    if (
      sendLock.current ||
      (!queued && loading) ||
      !page ||
      (!queued &&
        ((!draft.trim() && !images.length) ||
          readingImagesRef.current ||
          !optionsValid)) ||
      thread.archived
    )
      return;
    stopRequested.current = false;
    let completed = false;
    sendLock.current = true;
    onBusyChange?.(true);
    setSending(true);
    setReady(false);
    setStopping(false);
    setSendError("");
    setSendFailure(null);
    setStatus("Codex に接続中…");
    follow.current = true;
    const text = queued?.text ?? draft;
    const sentImages = queued?.images ?? imagesRef.current;
    if (!queued) {
      updateImages([]);
      updateDraft("");
    }
    const sentDraftVersion = draftVersion.current;
    setLive([
      {
        id: "outgoing",
        role: "user",
        text: [text, ...sentImages.map((image) => `添付: ${image.name}`)]
          .filter(Boolean)
          .join("\n"),
      },
    ]);
    try {
      const result = await api.sendMessage(
        thread.id,
        text,
        (event) => {
          if (event.type === "request") {
            setRequests((previous) => [
              ...previous.filter((item) => item.id !== event.id),
              event,
            ]);
            return;
          }
          if (event.type === "requestClosed") {
            setRequests((previous) =>
              previous.filter((item) => item.id !== event.id),
            );
            return;
          }
          if (event.type === "ready") {
            setReady(true);
            setStatus("Codex が応答中…");
            return;
          }
          setLive((previous) => {
            const existing = previous.find((m) => m.id === event.id);
            const message: ChatMessage = {
              id: event.id,
              role: "assistant",
              text:
                event.type === "delta"
                  ? (existing?.text ?? "") + event.text
                  : event.text,
            };
            return existing
              ? previous.map((m) => (m.id === event.id ? message : m))
              : [...previous, message];
          });
        },
        queued?.options ?? options,
        ...(sentImages.length ? [sentImages] : []),
      );
      completed = result === "completed";
      setReady(false);
      setStatus(
        result === "interrupted"
          ? "応答を停止しました。"
          : "応答が完了しました。",
      );
      // Supersede any history reload started while streaming.
      const current = ++generation.current;
      setLoading(true);
      // Keep the streamed answer if history refresh fails; never resend automatically.
      try {
        const latest = await api.readThread(thread.id);
        if (generation.current === current) {
          setPage(latest);
          setLive([]);
        }
      } catch {
        setSendError(
          "応答後の履歴取得に失敗しました。表示中の回答を残しています。会話を再読み込みしてください。",
        );
      } finally {
        if (generation.current === current) setLoading(false);
      }
    } catch (e) {
      if (queued) {
        updateQueue([
          { ...queued, uncertain: !chatSendError(e).notSent },
          ...queueRef.current,
        ]);
      } else {
        updateImages([...sentImages, ...imagesRef.current]);
        if (draftVersion.current === sentDraftVersion) updateDraft(text);
      }
      const failure = chatSendError(e);
      setSendFailure(failure);
      if (failure.notSent) setLive([]);
      setStatus("");
    } finally {
      setRequests([]);
      sendLock.current = false;
      setSending(false);
      setStopping(false);
      const next = queueRef.current[0];
      if (completed && !stopRequested.current && next && !next.uncertain) {
        updateQueue(queueRef.current.slice(1));
        await sendMessage(next);
      } else {
        onBusyChange?.(false);
      }
    }
  }

  async function stopMessage() {
    stopRequested.current = true;
    setStopping(true);
    try {
      await api.stopMessage(thread.id);
    } catch (e) {
      setSendError(errorMessage(e));
      setStopping(false);
    }
  }
  useEffect(() => {
    if (visible && autoFocus) heading.current?.focus();
  }, [autoFocus, visible]);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    setPage(null);
    void api
      .readThread(thread.id)
      .then((result) => {
        if (generation.current === current) {
          setPage(result);
          if (!sendLock.current) setLive([]);
        }
      })
      .catch((e) => {
        if (generation.current === current) setError(errorMessage(e));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [thread.id, reload]);

  async function more() {
    if (!page?.nextCursor || moreLock.current) return;
    moreLock.current = true;
    const current = generation.current;
    const cursor = page.nextCursor;
    setLoading(true);
    setError("");
    try {
      const next = await api.readThread(thread.id, cursor);
      if (current !== generation.current) return;
      if (next.nextCursor === cursor)
        throw new Error(
          "続きの取得位置が更新されませんでした。会話を再読み込みしてください。",
        );
      setPage((previous) => {
        const messages = new Map(next.messages.map((m) => [m.id, m]));
        previous?.messages.forEach((m) => messages.set(m.id, m));
        return {
          observedUpdatedAt: previous?.observedUpdatedAt,
          messages: [...messages.values()],
          nextCursor: next.nextCursor,
        };
      });
    } catch (e) {
      if (current === generation.current) setError(errorMessage(e));
    } finally {
      moreLock.current = false;
      if (current === generation.current) setLoading(false);
    }
  }

  return (
    <aside
      className="chat-pane"
      aria-label="チャット内容"
      hidden={!visible}
      style={visible ? undefined : { display: "none" }}
    >
      <header className="chat-heading">
        <div>
          <span className="eyebrow">CONVERSATION</span>
          <h2 ref={heading} tabIndex={-1}>
            {thread.title}
          </h2>
        </div>
        <button aria-label="チャット欄を閉じる" onClick={close}>
          ×
        </button>
      </header>
      <div className="chat-toolbar">
        <span>最近のメッセージを表示</span>
        <button
          disabled={loading}
          onClick={() => {
            follow.current = true;
            setReload((v) => v + 1);
          }}
        >
          会話を再読み込み
        </button>
      </div>
      {onFork && (
        <div className="fork-controls">
          <button
            type="button"
            disabled={sending || forking || loading || !page?.messages.length}
            title="会話履歴を引き継いで新しいスレッドを作成"
            onClick={async () => {
              if (forkLock.current) return;
              forkLock.current = true;
              setForking(true);
              setForkError("");
              try {
                onFork(await api.forkThread(thread.id));
              } catch (error) {
                setForkError(errorMessage(error));
              } finally {
                forkLock.current = false;
                setForking(false);
              }
            }}
          >
            {forking ? "分岐を作成中…" : "この会話から分岐"}
          </button>
          {forkError && (
            <p role="alert" className="chat-error">
              {forkError}
            </p>
          )}
        </div>
      )}
      {readError ? (
        <div role="alert" className="chat-error">
          <p>{readError}</p>
          <button onClick={() => setReadRetry((v) => v + 1)}>
            既読の保存を再試行
          </button>
        </div>
      ) : null}
      {thread.unread &&
      observed != null &&
      (thread.updatedAt ?? 0) > observed ? (
        <p className="chat-state">
          新しい更新があります。「会話を再読み込み」で確認してください。
        </p>
      ) : null}
      <div
        className="chat-messages"
        ref={messagesView}
        aria-busy={loading}
        onScroll={() => {
          const view = messagesView.current;
          if (view)
            follow.current =
              view.scrollHeight - view.scrollTop - view.clientHeight < 80;
        }}
      >
        {page?.nextCursor ? (
          <button
            className="load-more"
            disabled={loading}
            onClick={() => {
              follow.current = false;
              void more();
            }}
          >
            以前のメッセージを読み込む
          </button>
        ) : null}
        {page?.messages.map((message) => (
          <article key={message.id} className={`chat-message ${message.role}`}>
            <h3>
              {message.role === "user"
                ? "あなた"
                : message.role === "assistant"
                  ? "Codex"
                  : "アクティビティ"}
            </h3>
            <MarkdownMessage text={message.text} />
          </article>
        ))}
        {error ? (
          <div role="alert" className="chat-error">
            <p>{error}</p>
            <button
              onClick={() => {
                if (page?.nextCursor) void more();
                else setReload((v) => v + 1);
              }}
              disabled={loading}
            >
              再試行
            </button>
          </div>
        ) : null}
        {loading ? (
          <p role="status" className="chat-state">
            会話を読み込み中…
          </p>
        ) : null}
        {!loading && page && !page.messages.length && !page.nextCursor ? (
          <p className="chat-state">保存されたメッセージはありません。</p>
        ) : null}
        {live.map((message) => (
          <article key={message.id} className={`chat-message ${message.role}`}>
            <h3>
              {message.role === "user" ? "あなた（今回の送信）" : "Codex"}
            </h3>
            <MarkdownMessage text={message.text} />
          </article>
        ))}
      </div>
      {requests.length > 0 && (
        <div className="interaction-list" aria-label="回答待ちの確認">
          {requests.map((request) => (
            <InteractionCard
              key={request.id}
              threadId={thread.id}
              request={request}
            />
          ))}
        </div>
      )}
      <form
        className={`chat-composer${draggingImages ? " dragging-images" : ""}`}
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer.types).includes("Files")) {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = thread.archived ? "none" : "copy";
            setDraggingImages(!thread.archived);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDraggingImages(false);
        }}
        onDrop={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          setDraggingImages(false);
          void addImages(Array.from(event.dataTransfer.files));
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (sendLock.current) enqueue();
          else void sendMessage();
        }}
      >
        <ModelPicker
          models={models}
          value={options}
          disabled={thread.archived}
          loading={modelsLoading}
          error={modelsError}
          reload={() => setModelsReload((n) => n + 1)}
          onChange={(value) => {
            setOptions(value);
            onOptionsChange?.(value);
          }}
        />
        {!optionsValid && !modelsLoading ? (
          <p role="alert" className="chat-error">
            選択したモデル・推論強度を確認できません。選び直すか「スレッドの設定を使用」に戻してください。
          </p>
        ) : null}
        <div className="attachment-toolbar">
          <label htmlFor={inputId}>メッセージ</label>
          <label className="image-file-picker">
            ファイルを追加
            <input
              aria-label="ファイルを追加"
              type="file"
              multiple
              disabled={thread.archived || readingImages}
              onChange={(event) => {
                void addImages(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </label>
        </div>
        <small className="attachment-help">
          全形式を添付可能 ·
          4件まで・各5MB以下。読み取り可否はCodexのモデル・ツールによります。
        </small>
        {images.length > 0 && (
          <ul className="image-attachments" aria-label="添付ファイル">
            {images.map((image, index) => (
              <li key={`${index}-${image.name}`}>
                {!/^data:image\/(png|jpeg|webp|gif);base64,/.test(image.url) ? (
                  <span className="file-attachment-icon" aria-hidden="true">
                    📄
                  </span>
                ) : (
                  <img src={image.url} alt={image.name} />
                )}
                <span title={image.name}>{image.name}</span>
                <button
                  type="button"
                  aria-label={`${image.name}を削除`}
                  disabled={thread.archived}
                  onClick={() =>
                    updateImages(images.filter((_, i) => i !== index))
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {readingImages && <p role="status">ファイルを読み込み中…</p>}
        <textarea
          id={inputId}
          value={draft}
          maxLength={32000}
          rows={3}
          disabled={thread.archived}
          placeholder="メッセージを入力、またはファイルをドロップ…"
          onChange={(e) => updateDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              (e.metaKey || e.ctrlKey) &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              if (sendLock.current) enqueue();
              else void sendMessage();
            }
          }}
        />
        <div className="composer-actions">
          <small>
            Enter で改行 · ⌘ / Ctrl + Enter で{sending ? "Queue" : "送信"}
          </small>
          {sending ? (
            <div className="sending-actions">
              <button
                type="button"
                title="今の作業に追加指示"
                disabled={
                  !ready ||
                  stopping ||
                  steering ||
                  readingImages ||
                  thread.archived ||
                  (!draft.trim() && !images.length)
                }
                onClick={() => void steer()}
              >
                {steering ? "送信中…" : "Steer"}
              </button>
              <button
                type="button"
                title="応答終了後に順番に送信"
                disabled={
                  stopping ||
                  steering ||
                  readingImages ||
                  thread.archived ||
                  !optionsValid ||
                  (!draft.trim() && !images.length)
                }
                onClick={enqueue}
              >
                Queue
              </button>
              <button
                type="button"
                disabled={!ready || stopping}
                onClick={() => void stopMessage()}
              >
                {stopping ? "停止中…" : "応答を停止"}
              </button>
            </div>
          ) : (
            <button
              type="submit"
              disabled={
                loading ||
                !page ||
                (!draft.trim() && !images.length) ||
                readingImages ||
                thread.archived ||
                !optionsValid
              }
            >
              送信
            </button>
          )}
        </div>
        {queue.length > 0 && (
          <section className="queued-messages" aria-label="送信待ち">
            <p>
              送信待ち {queue.length}件{!sending ? "（停止中）" : ""} ·
              このアプリの起動中のみ保持
            </p>
            <ol>
              {queue.map((item) => (
                <li key={item.id}>
                  <span>
                    {item.text || "添付ファイル"}
                    {item.images.length ? ` · 添付${item.images.length}件` : ""}
                    {item.uncertain
                      ? "（送信結果未確認・履歴を確認してください）"
                      : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      updateQueue(
                        queueRef.current.filter(
                          (entry) => entry.id !== item.id,
                        ),
                      )
                    }
                  >
                    取消
                  </button>
                </li>
              ))}
            </ol>
            {!sending && (
              <button
                type="button"
                disabled={loading || thread.archived || queue[0].uncertain}
                onClick={() => {
                  const next = queueRef.current[0];
                  if (!next || next.uncertain || sendLock.current) return;
                  updateQueue(queueRef.current.slice(1));
                  void sendMessage(next);
                }}
              >
                キューを再開
              </button>
            )}
          </section>
        )}
        {status ? (
          <p role="status">
            {status}
            {sending ? " 他のスレッドに移動しても応答は続きます。" : ""}
          </p>
        ) : null}
        {sendFailure ? (
          <div role="alert" className="chat-error send-failure">
            <h3>{sendFailure.title}</h3>
            <p>{sendFailure.message}</p>
            <p>{sendFailure.action}</p>
            {!sendFailure.notSent ? (
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  follow.current = true;
                  setReload((v) => v + 1);
                }}
              >
                会話を再読み込みして確認
              </button>
            ) : null}
            <details>
              <summary>技術的な詳細</summary>
              <p className="message-text">{sendFailure.detail}</p>
            </details>
          </div>
        ) : null}
        {sendError ? (
          <p role="alert" className="chat-error">
            {sendError}
          </p>
        ) : null}
      </form>
    </aside>
  );
}
