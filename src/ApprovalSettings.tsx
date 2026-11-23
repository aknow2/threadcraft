import { useState } from "react";
import {
  forgetApproval,
  savedApprovals,
  toolApprovalMode,
  saveToolApprovalMode,
  type ToolApprovalMode,
} from "./approvalPreferences";
import Icon from "./Icon";

export default function ApprovalSettings() {
  const [entries, setEntries] = useState(savedApprovals);
  const [error, setError] = useState("");
  const [mode, setMode] = useState(toolApprovalMode);
  return (
    <section aria-label="記憶した許可">
      <h3>記憶した許可（{entries.length}）</h3>
      <label className="field">
        外部ツールの承認モード
        <select
          value={mode}
          onChange={(event) => {
            const value = event.target.value as ToolApprovalMode;
            if (saveToolApprovalMode(value)) {
              setMode(value);
              setError("");
            } else setError("承認モードを保存できませんでした。");
          }}
        >
          <option value="remember">一度許可したツールは自動で許可</option>
          <option value="ask">毎回確認する</option>
        </select>
      </label>
      <p className="caption">
        外部ツールは接続先・ツールごとに記憶します。コマンドとファイル操作は作業フォルダと実行権限ごとに保存します。解除すると次回は再確認します。
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="archive-list">
        {entries.map((entry) => (
          <article className="archive-entry" key={entry.key}>
            <div>
              <h3>{entry.label}</h3>
              <p>{entry.workspace}</p>
            </div>
            <button
              className="icon-button"
              type="button"
              title="許可を解除"
              aria-label={`${entry.label} の許可を解除`}
              onClick={() => {
                if (forgetApproval(entry.key)) {
                  setEntries(savedApprovals());
                  setError("");
                } else
                  setError(
                    "許可を解除できませんでした。もう一度お試しください。",
                  );
              }}
            >
              <Icon name="trash" />
            </button>
          </article>
        ))}
        {!entries.length && (
          <p className="caption">記憶した許可はありません。</p>
        )}
      </div>
    </section>
  );
}
