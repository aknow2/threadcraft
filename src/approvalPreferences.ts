import type { InteractionRequest, SendOptions, Thread } from "./api";

const storageKey = "treadcraft.approvals.v1";
const modeKey = "treadcraft.toolApprovalMode.v1";
export type ToolApprovalMode = "remember" | "ask";
export function toolApprovalMode(): ToolApprovalMode {
  try {
    return localStorage.getItem(modeKey) === "ask" ? "ask" : "remember";
  } catch {
    return "ask";
  }
}
export function saveToolApprovalMode(mode: ToolApprovalMode): boolean {
  try {
    localStorage.setItem(modeKey, mode);
    return true;
  } catch {
    return false;
  }
}
export interface SavedApproval {
  key: string;
  scope: string;
  workspace: string;
  label: string;
  createdAt: number;
}

export function isMcpConfirmation(request: InteractionRequest): boolean {
  const p = request.params;
  const schema = p.requestedSchema;
  return (
    request.method === "mcpServer/elicitation/request" &&
    (p.mode === "form" || p.mode === "openai/form") &&
    !!p.serverName &&
    !!p.message?.trim() &&
    !!p.formSupported &&
    schema?.type === "object" &&
    !!schema.properties &&
    Object.keys(schema.properties).length === 0 &&
    (!schema.required || schema.required.length === 0) &&
    Object.keys(schema).every((key) =>
      [
        "type",
        "properties",
        "required",
        "additionalProperties",
        "title",
        "description",
        "$schema",
      ].includes(key),
    )
  );
}

export function approvalScope(
  thread: Thread,
  permission: SendOptions["permission"],
): string {
  if (!thread.cwd) return "";
  let source = thread.id;
  try {
    const id: unknown = JSON.parse(thread.id);
    if (Array.isArray(id) && typeof id[0] === "string") source = id[0];
  } catch {
    /* Unknown IDs remain isolated to their thread. */
  }
  return JSON.stringify({
    source,
    cwd: thread.cwd,
    permission: permission ?? "read-only",
  });
}

export function canRememberApproval(request: InteractionRequest): boolean {
  const { method, params } = request;
  if (isMcpConfirmation(request)) return toolApprovalMode() === "remember";
  if (
    params.toolApproval &&
    (method === "item/tool/requestUserInput" ||
      method === "tool/requestUserInput")
  ) {
    const tool = params.toolApproval;
    if (tool.protocol === "elicitation") return false;
    const question = params.questions?.find(
      (question) => question.id === tool.questionId,
    );
    return (
      toolApprovalMode() === "remember" &&
      !!tool.server &&
      !!tool.tool &&
      !!question?.options?.some((option) => option.label === tool.acceptLabel)
    );
  }
  if (
    params.availableDecisions &&
    !params.availableDecisions.includes("accept")
  )
    return false;
  if (method === "item/commandExecution/requestApproval")
    return (
      !!params.command?.trim() ||
      !!(
        params.networkApprovalContext?.host &&
        params.networkApprovalContext.protocol
      )
    );
  if (method === "item/fileChange/requestApproval")
    return (
      Array.isArray(params.changes) &&
      params.changes.length > 0 &&
      params.changes.every(
        (change) =>
          change &&
          typeof change.path === "string" &&
          typeof change.diff === "string" &&
          change.kind,
      )
    );
  if (method === "item/permissions/requestApproval")
    return (
      !!params.permissions &&
      typeof params.permissions === "object" &&
      Object.values(params.permissions).some((value) => value !== null)
    );
  return false;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

async function keyFor(
  scope: string,
  request: InteractionRequest,
): Promise<string | null> {
  if (!scope || !canRememberApproval(request)) return null;
  if (request.params.toolApproval) {
    try {
      const { server, tool, connectorId, linkId } = request.params.toolApproval;
      const identity = JSON.stringify({
        source: JSON.parse(scope).source,
        server,
        tool,
        connectorId,
        linkId,
      });
      return await digest(identity);
    } catch {
      return null;
    }
  }
  // Keep every execution-affecting field, including new protocol fields. Only
  // request identifiers and explanatory text vary between identical operations.
  const transient = new Set([
    "threadId",
    "turnId",
    "itemId",
    "requestId",
    "approvalId",
    "elicitationId",
    "reason",
    "availableDecisions",
  ]);
  const params = Object.fromEntries(
    Object.entries(request.params).filter(([key]) => !transient.has(key)),
  );
  try {
    return await digest(
      JSON.stringify(canonical({ scope, method: request.method, params })),
    );
  } catch {
    return null;
  }
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function savedApprovals(): SavedApproval[] {
  try {
    const entries: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? "[]",
    );
    if (!Array.isArray(entries)) return [];
    return entries.filter(
      (entry): entry is SavedApproval =>
        entry &&
        typeof entry === "object" &&
        typeof entry.key === "string" &&
        /^[a-f0-9]{64}$/.test(entry.key) &&
        typeof entry.scope === "string" &&
        typeof entry.workspace === "string" &&
        typeof entry.label === "string" &&
        typeof entry.createdAt === "number",
    );
  } catch {
    return [];
  }
}

export async function hasSavedApproval(
  scope: string,
  request: InteractionRequest,
): Promise<boolean> {
  const key = await keyFor(scope, request);
  if (key) await pendingApprovals.get(key);
  return (
    !!key &&
    canRememberApproval(request) &&
    savedApprovals().some(
      (entry) =>
        entry.key === key &&
        (!!request.params.toolApproval || entry.scope === scope),
    )
  );
}

export async function rememberApproval(
  scope: string,
  request: InteractionRequest,
): Promise<boolean> {
  const key = await keyFor(scope, request);
  if (!key) return false;
  return persistApproval(scope, request, key);
}

const pendingApprovals = new Map<string, Promise<void>>();

// Hash before replying, then publish the grant synchronously when the reply is
// accepted. A following request can wait instead of missing an in-flight save.
export async function approveAndRemember(
  scope: string,
  request: InteractionRequest,
  send: () => Promise<void>,
): Promise<boolean> {
  const key = await keyFor(scope, request);
  if (!key) {
    await send();
    return false;
  }
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  pendingApprovals.set(key, pending);
  try {
    await send();
    return persistApproval(scope, request, key);
  } finally {
    if (pendingApprovals.get(key) === pending) pendingApprovals.delete(key);
    finish();
  }
}

function persistApproval(
  scope: string,
  request: InteractionRequest,
  key: string,
): boolean {
  try {
    const workspace = JSON.parse(scope).cwd;
    if (typeof workspace !== "string" || !workspace) return false;
    const label =
      request.params.toolApproval?.tool ??
      (isMcpConfirmation(request)
        ? `${request.params.serverName}: ${request.params.message}`
        : null) ??
      request.params.command ??
      (request.method === "item/fileChange/requestApproval"
        ? "ファイル編集"
        : "追加権限");
    const entries = savedApprovals().filter((entry) => entry.key !== key);
    entries.push({
      key,
      scope,
      workspace: request.params.toolApproval
        ? "全作業フォルダ・ツール単位"
        : workspace,
      label: label.slice(0, 200),
      createdAt: Date.now(),
    });
    localStorage.setItem(storageKey, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

export function forgetApproval(key: string): boolean {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(savedApprovals().filter((entry) => entry.key !== key)),
    );
    return true;
  } catch {
    return false;
  }
}
