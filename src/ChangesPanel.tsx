import { useMemo, useState } from "react";
import type { ChatMessage, FileChange } from "./api";
import Icon from "./Icon";

const statuses: Record<string, string> = {
  inProgress: "適用中・承認待ち",
  completed: "適用済み",
  failed: "失敗",
  declined: "却下",
};
const kinds: Record<string, string> = {
  add: "追加",
  delete: "削除",
  update: "変更",
};

// Count only patch body lines, not file headers or hunk headers.
export function diffLines(diff: string) {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  return diff.split(/\r?\n/).map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { text, type: "hunk", old: null, next: null };
    }
    if (oldLine !== null && newLine !== null) {
      if (text.startsWith("+"))
        return { text, type: "add", old: null, next: newLine++ };
      if (text.startsWith("-"))
        return { text, type: "delete", old: oldLine++, next: null };
      if (text.startsWith(" "))
        return { text, type: "context", old: oldLine++, next: newLine++ };
    }
    return { text, type: "meta", old: null, next: null };
  });
}

function FileDiff({ edit }: { edit: FileChange["changes"][number] }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(1000);
  const lines = useMemo(() => diffLines(edit.diff), [edit.diff]);
  const added = lines.filter((line) => line.type === "add").length;
  const removed = lines.filter((line) => line.type === "delete").length;
  return (
    <div className="file-diff">
      <button
        className="file-diff-heading"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "minimize" : "plus"} />
        <span className="file-diff-path">
          {edit.path}
          {edit.kind?.move_path && <span> → {edit.kind.move_path}</span>}
        </span>
        <span>{kinds[edit.kind?.type] ?? "変更"}</span>
        <span className="diff-added">+{added}</span>
        <span className="diff-removed">−{removed}</span>
      </button>
      {open &&
        (edit.diff ? (
          <>
            <pre
              className="diff-code"
              tabIndex={0}
              aria-label={`${edit.path}の差分`}
            >
              <code>
                {lines.slice(0, limit).map((line, index) => (
                  <span className={`diff-line diff-${line.type}`} key={index}>
                    <span className="diff-number" aria-hidden="true">
                      {line.old ?? ""}
                    </span>
                    <span className="diff-number" aria-hidden="true">
                      {line.next ?? ""}
                    </span>
                    <span>{line.text || " "}</span>
                  </span>
                ))}
              </code>
            </pre>
            {lines.length > limit && (
              <button
                type="button"
                onClick={() => setLimit((value) => value + 1000)}
              >
                続きを表示（残り{lines.length - limit}行）
              </button>
            )}
          </>
        ) : (
          <p className="changes-note">差分の本文が記録されていません。</p>
        ))}
    </div>
  );
}

export default function ChangesPanel({
  messages,
  hasMore,
  loading,
  onMore,
  onClose,
}: {
  messages: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  onClose: () => void;
}) {
  const entries = useMemo(() => {
    const unique = new Map(
      messages
        .filter((message) => message.fileChange)
        .map((message) => [message.id, message]),
    );
    return [...unique.values()].reverse();
  }, [messages]);
  const files = new Set(
    entries.flatMap((message) =>
      message.fileChange!.changes.map((edit) => edit.path),
    ),
  );
  return (
    <section className="changes-panel" aria-label="変更ファイルと差分">
      <header className="changes-heading">
        <strong>
          変更ファイル <span>{files.size}</span>
        </strong>
        <button
          type="button"
          className="icon-button"
          aria-label="差分パネルを閉じる"
          title="差分パネルを閉じる"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="changes-content">
        <p className="changes-note">
          会話に記録された編集を新しい順に表示します。現在のファイルとの差分ではありません。
        </p>
        {!entries.length && (
          <p className="changes-note">
            読み込んだ履歴にファイル変更はありません。
          </p>
        )}
        {entries.map((message) => (
          <div className="change-operation" key={message.id}>
            <p className="change-status">
              {statuses[message.fileChange!.status] ?? "状態不明"}
            </p>
            {message.fileChange!.changes.map((edit, index) => (
              <FileDiff key={`${edit.path}:${index}`} edit={edit} />
            ))}
          </div>
        ))}
        {hasMore && (
          <button type="button" disabled={loading} onClick={onMore}>
            {loading ? "読み込み中…" : "以前の履歴から変更を読み込む"}
          </button>
        )}
      </div>
    </section>
  );
}
