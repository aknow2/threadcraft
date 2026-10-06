import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

export interface ModelOption {
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  isDefault: boolean;
}
// Shared attachment payload: original filename and file data URL.
export interface ImageAttachment {
  name: string;
  url: string;
}
export interface SendOptions {
  model: string | null;
  effort: string | null;
  permission?: "read-only" | "workspace-write" | "danger-full-access";
}
export interface QueuedMessage {
  id: string;
  text: string;
  images: ImageAttachment[];
  options: SendOptions;
  uncertain?: boolean;
}
export const inheritModel: SendOptions = { model: null, effort: null };

export interface InteractionRequest {
  id: string;
  method: string;
  params: {
    reason?: string;
    message?: string;
    command?: string;
    cwd?: string;
    grantRoot?: string;
    serverName?: string;
    mode?: string;
    url?: string;
    formSupported?: boolean;
    availableDecisions?: unknown[];
    networkApprovalContext?: { host: string; protocol: string };
    permissions?: unknown;
    additionalPermissions?: unknown;
    changes?: unknown;
    questions?: {
      id: string;
      question: string;
      isSecret?: boolean;
      options?: { label: string; description?: string }[];
    }[];
    requestedSchema?: {
      required?: string[];
      properties?: Record<
        string,
        {
          type: string;
          title?: string;
          description?: string;
          enum?: (string | number)[];
        }
      >;
    };
  };
}
export type ChatEvent =
  | ({ type: "request" } & InteractionRequest)
  | { type: "requestClosed"; id: string }
  | { type: "ready" }
  | { type: "delta" | "message"; id: string; text: string };

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  unread?: boolean;
  cwd: string;
  archived: boolean;
  groupId: string | null;
  position: number;
}
export interface Group {
  id: string;
  name: string;
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "activity";
  text: string;
}
export interface ChatPage {
  observedUpdatedAt?: number | null;
  messages: ChatMessage[];
  nextCursor: string | null;
}
export interface Board {
  revision: number;
  groups: Group[];
  threads: Thread[];
  lastSync: number | null;
}
export type Mutation =
  | { type: "createGroup"; name: string }
  | { type: "renameGroup"; id: string; name: string }
  | { type: "deleteGroup"; id: string }
  | {
      type: "moveThread";
      id: string;
      groupId: string | null;
      beforeId: string | null;
    }
  | { type: "reorderGroup"; id: string; beforeId: string | null };

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri())
    return Promise.reject(
      new Error(
        "デスクトップアプリで開いてください（npm run tauri dev）。ブラウザーから実データには接続しません。",
      ),
    );
  return invoke<T>(command, args);
}
export const api = {
  createThread: (cwd: string, groupId: string | null) =>
    call<{ board: Board; threadId: string }>("create_thread", { cwd, groupId }),
  listModels: () => call<ModelOption[]>("list_models"),
  markThreadRead: (id: string, observedUpdatedAt: number) =>
    call<Board>("mark_thread_read", { id, observedUpdatedAt }),
  sendMessage: (
    id: string,
    text: string,
    onEvent: (event: ChatEvent) => void,
    options: SendOptions = inheritModel,
    images: ImageAttachment[] = [],
  ) => {
    const channel = new Channel<ChatEvent>();
    channel.onmessage = onEvent;
    return call<string>("send_message", {
      id,
      text,
      images,
      onEvent: channel,
      options,
    });
  },
  respondToRequest: (id: string, requestId: string, answer: unknown) =>
    call<void>("respond_to_request", { id, requestId, answer }),
  forkThread: (id: string) =>
    call<{ board: Board; threadId: string }>("fork_thread", { id }),
  steerMessage: (id: string, text: string, images: ImageAttachment[]) =>
    call<void>("steer_message", {
      id,
      text,
      images,
    }),
  stopMessage: (id: string) => call<void>("stop_message", { id }),
  openInZed: (id: string) => call<void>("open_in_zed", { id }),
  readThread: (id: string, cursor: string | null = null) =>
    call<ChatPage>("read_thread", { id, cursor }),
  board: () => call<Board>("get_board"),
  refresh: () => call<Board>("refresh_threads"),
  mutate: (expectedRevision: number, mutation: Mutation) =>
    call<Board>("mutate_board", { expectedRevision, mutation }),
};
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "code" in error) {
    if ("message" in error && typeof error.message === "string")
      return error.message;
    const messages: Record<string, string> = {
      Conflict:
        "分類が変更されました。再読み込みしましたので、やり直してください。",
      NotFound: "対象が見つかりません。再読み込みしてやり直してください。",
      Storage: "保存に失敗しました。空き容量とアクセス権を確認してください。",
      UnsupportedVersion:
        "Codex CLI 0.153.4 以降が必要です。または API の応答形式に対応していません。",
    };
    return (
      messages[String(error.code)] ??
      "操作に失敗しました。もう一度お試しください。"
    );
  }
  return typeof error === "string" ? error : "操作に失敗しました。";
}

export function chatSendError(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  const notSent =
    code === "ThreadInUse" ||
    code === "ChatNotSent" ||
    code === "Validation" ||
    code === "NotFound";
  const detail = errorMessage(error);
  if (code === "ThreadInUse")
    return {
      notSent,
      title: "このスレッドは別の Codex 接続で使用中です",
      message: "今回は送信されていません。入力文は下書きに残っています。",
      action:
        "Zed・Codex アプリ・ターミナルなどで、このスレッドの Codex セッションを終了してから、もう一度「送信」を押してください。応答が終わっていてもセッションが残っている場合があります。",
      detail,
    };
  return {
    notSent,
    title: notSent
      ? "メッセージを送信できませんでした"
      : "送信結果・応答の完了を確認できませんでした",
    message: notSent
      ? "今回は送信されていません。入力文は下書きに残っています。"
      : "送信済みの可能性があります。入力文は下書きに残しています。",
    action: notSent
      ? "Codex の起動・ログイン状態と設定を確認してから、もう一度「送信」を押してください。"
      : "重複送信を避けるため、再送信前に「会話を再読み込み」で履歴を確認してください。自動再送は行いません。",
    detail,
  };
}
export function newerBoard(current: Board | null, next: Board): Board {
  if (
    current &&
    (current.revision > next.revision ||
      (current.revision === next.revision &&
        (current.lastSync ?? 0) > (next.lastSync ?? 0)))
  )
    return current;
  return next;
}
export function visibleThreads(
  board: Board,
  groupId: string | null,
  search: string,
): Thread[] {
  const query = search.trim().toLocaleLowerCase();
  return board.threads
    .filter(
      (t) =>
        !t.archived &&
        t.groupId === groupId &&
        t.title.toLocaleLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        (groupId ? Number(!!b.unread) - Number(!!a.unread) : 0) ||
        (groupId
          ? (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
          : b.createdAt - a.createdAt) ||
        a.id.localeCompare(b.id),
    );
}
