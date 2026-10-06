import { useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type InteractionRequest } from "./api";

export default function InteractionCard({
  threadId,
  request,
}: {
  threadId: string;
  request: InteractionRequest;
}) {
  const { params: p, method } = request;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [content, setContent] = useState<
    Record<string, string | number | boolean>
  >({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  async function respond(action: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api.respondToRequest(threadId, request.id, {
        action,
        answers,
        content,
      });
    } catch (error) {
      setError(errorMessage(error));
      lock.current = false;
      setBusy(false);
    }
  }
  const question = method === "item/tool/requestUserInput";
  const mcp = method === "mcpServer/elicitation/request";
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
      {(p.permissions || p.additionalPermissions || p.changes) ? (
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
              回答を送信
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond("cancel")}
            >
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
              {p.mode === "url" ? "完了" : "回答を送信"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond("cancel")}
            >
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
                {permission ? "このターンで許可" : "今回のみ許可"}
              </button>
            )}
            {allowed("decline") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void respond("decline")}
              >
                拒否
              </button>
            )}
            {!permission && allowed("cancel") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void respond("cancel")}
              >
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
