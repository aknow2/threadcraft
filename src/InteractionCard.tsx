import Icon from "./Icon";
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type InteractionRequest } from "./api";
import {
  canRememberApproval,
  hasSavedApproval,
  approveAndRemember,
} from "./approvalPreferences";

export default function InteractionCard({
  threadId,
  request,
  approvalScope = "",
  onRememberError,
}: {
  threadId: string;
  request: InteractionRequest;
  approvalScope?: string;
  onRememberError?: (message: string) => void;
}) {
  const { params: p, method } = request;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [content, setContent] = useState<
    Record<string, string | number | boolean>
  >({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const rememberable = !!approvalScope && canRememberApproval(request);
  const [remember, setRemember] = useState(true);
  const toolApproval = request.params.toolApproval;
  async function respond(action: string, automatic = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const toolLabel =
        toolApproval &&
        toolApproval.protocol !== "elicitation" &&
        (
          {
            accept: toolApproval.acceptLabel,
            decline: toolApproval.declineLabel,
            cancel: toolApproval.cancelLabel,
          } as Record<string, string>
        )[action];
      const send = () =>
        api.respondToRequest(threadId, request.id, {
          action: toolLabel ? "answer" : action,
          answers:
            toolLabel && toolApproval
              ? { [toolApproval.questionId]: toolLabel }
              : answers,
          content,
        });
      if (!automatic && action === "accept" && rememberable && remember) {
        if (!(await approveAndRemember(approvalScope, request, send)))
          onRememberError?.(
            "今回の許可は送信しましたが、次回用の許可を保存できませんでした。",
          );
      } else await send();
    } catch (error) {
      setError(errorMessage(error));
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    let disposed = false;
    if (rememberable)
      void hasSavedApproval(approvalScope, request).then((saved) => {
        if (saved && !disposed && !lock.current) void respond("accept", true);
      });
    return () => {
      disposed = true;
    };
    // One immutable approval request per card; edited answers are never replayed.
  }, [request.id, approvalScope]);
  const question =
    !toolApproval &&
    (method === "item/tool/requestUserInput" ||
      method === "tool/requestUserInput");
  const mcp = method === "mcpServer/elicitation/request" && !toolApproval;
  const permission = method === "item/permissions/requestApproval";
  const allowed = (decision: string) =>
    !p.availableDecisions || p.availableDecisions.includes(decision);
  return (
    <section
      className="interaction-card"
      aria-label={question ? "追加質問" : "承認待ち"}
    >
      <h3>
        {question
          ? "Codexからの追加質問"
          : mcp
            ? `${p.serverName ?? "ツール"}からの確認`
            : permission
              ? "追加権限の確認"
              : toolApproval
                ? `${toolApproval.tool} の実行許可`
                : "操作の承認"}
      </h3>
      {p.reason && <p>{p.reason}</p>}
      {p.message && <p>{p.message}</p>}
      {p.command && <pre>{p.command}</pre>}
      {p.cwd && <p>作業場所: {p.cwd}</p>}
      {p.grantRoot && <p>書き込み先: {p.grantRoot}</p>}
      {p.networkApprovalContext && (
        <p>
          接続先: {p.networkApprovalContext.protocol} /{" "}
          {p.networkApprovalContext.host}
        </p>
      )}
      {p.permissions || p.additionalPermissions || p.changes ? (
        <pre>
          {JSON.stringify(
            p.permissions ?? p.additionalPermissions ?? p.changes,
            null,
            2,
          )}
        </pre>
      ) : null}
      {question &&
        p.questions?.map((q) => (
          <fieldset key={q.id} disabled={busy}>
            <legend>{q.question}</legend>
            {q.options?.map((option) => (
              <label key={option.label}>
                <input
                  type="radio"
                  name={`${request.id}-${q.id}`}
                  checked={answers[q.id] === option.label}
                  onChange={() =>
                    setAnswers({ ...answers, [q.id]: option.label })
                  }
                />
                {option.label}
                {option.description ? ` — ${option.description}` : ""}
              </label>
            ))}
            <label>
              自由入力
              <input
                type={q.isSecret ? "password" : "text"}
                autoComplete="off"
                value={answers[q.id] ?? ""}
                maxLength={32000}
                onChange={(e) =>
                  setAnswers({ ...answers, [q.id]: e.target.value })
                }
              />
            </label>
          </fieldset>
        ))}
      {mcp && p.mode === "url" && p.url && (
        <>
          <p>リンク先で手続きを終えてから「完了」を押してください。</p>
          <button
            type="button"
            disabled={busy || !/^https?:\/\//i.test(p.url)}
            onClick={() =>
              void openUrl(p.url!).catch((e) => setError(errorMessage(e)))
            }
          >
            <Icon name="external" />
            手続きのページを開く
          </button>
        </>
      )}
      {mcp && p.mode !== "url" && !p.formSupported && (
        <p>この形式の入力フォームには未対応です。キャンセルできます。</p>
      )}
      {mcp &&
        p.formSupported &&
        Object.entries(p.requestedSchema?.properties ?? {}).map(
          ([key, field]) => (
            <label key={key}>
              {field.title ?? key}
              {p.requestedSchema?.required?.includes(key) ? "（必須）" : ""}
              {field.description ? ` · ${field.description}` : ""}
              {field.enum ? (
                <select
                  disabled={busy}
                  value={String(content[key] ?? "")}
                  onChange={(e) =>
                    setContent({
                      ...content,
                      [key]:
                        field.type === "number" || field.type === "integer"
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                >
                  <option value="">選択してください</option>
                  {field.enum.map((value) => (
                    <option key={String(value)} value={String(value)}>
                      {String(value)}
                    </option>
                  ))}
                </select>
              ) : field.type === "boolean" ? (
                <select
                  disabled={busy}
                  value={content[key] === undefined ? "" : String(content[key])}
                  onChange={(e) =>
                    setContent({ ...content, [key]: e.target.value === "true" })
                  }
                >
                  <option value="">選択してください</option>
                  <option value="true">はい</option>
                  <option value="false">いいえ</option>
                </select>
              ) : (
                <input
                  disabled={busy}
                  value={String(content[key] ?? "")}
                  type={field.type === "string" ? "text" : "number"}
                  step={field.type === "integer" ? "1" : "any"}
                  onChange={(e) => {
                    const next = { ...content };
                    if (!e.target.value) delete next[key];
                    else
                      next[key] =
                        field.type === "string"
                          ? e.target.value
                          : Number(e.target.value);
                    setContent(next);
                  }}
                />
              )}
            </label>
          ),
        )}
      {rememberable && (
        <label className="remember-approval">
          <input
            type="checkbox"
            checked={remember}
            disabled={busy}
            onChange={(event) => setRemember(event.target.checked)}
          />
          {toolApproval
            ? "このツールを次回から自動で許可（全作業フォルダ）"
            : "同じ作業フォルダの同じ操作を次回から確認しない"}
        </label>
      )}
      <div className="interaction-actions">
        {question ? (
          <>
            <button
              type="button"
              disabled={
                busy || !p.questions?.every((q) => answers[q.id]?.trim())
              }
              onClick={() => void respond("answer")}
            >
              <Icon name="send" />
              回答を送信
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond("cancel")}
            >
              <Icon name="close" />
              回答しない
            </button>
          </>
        ) : mcp ? (
          <>
            <button
              type="button"
              disabled={busy || (p.mode !== "url" && !p.formSupported)}
              onClick={() => void respond("accept")}
            >
              <Icon name="check" />
              {p.mode === "url"
                ? "完了"
                : rememberable && remember
                  ? "許可して記憶"
                  : "回答を送信"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond("cancel")}
            >
              <Icon name="close" />
              キャンセル
            </button>
          </>
        ) : (
          <>
            {allowed("accept") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void respond("accept")}
              >
                <Icon name="check" />
                {rememberable && remember
                  ? "許可して記憶"
                  : permission
                    ? "このターンで許可"
                    : "今回のみ許可"}
              </button>
            )}
            {allowed("decline") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void respond("decline")}
              >
                <Icon name="close" />
                拒否
              </button>
            )}
            {!permission && allowed("cancel") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void respond("cancel")}
              >
                <Icon name="close" />
                キャンセル
              </button>
            )}
          </>
        )}
      </div>
      {busy && <p role="status">回答を送信中…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
