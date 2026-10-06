import { type ModelOption, type SendOptions } from "./api";

const effortLabels: Record<string, string> = {
  none: "None（推論なし）",
  minimal: "Minimal（最小）",
  low: "Low（低）",
  medium: "Medium（中）",
  high: "High（高）",
  xhigh: "XHigh（より高い）",
  max: "Max（最大）",
  ultra: "Ultra（最高）",
};

export default function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  loading,
  error,
  reload,
}: {
  models: ModelOption[];
  value: SendOptions;
  onChange: (value: SendOptions) => void;
  disabled: boolean;
  loading: boolean;
  error: string;
  reload: () => void;
}) {
  const selected = models.find((m) => m.model === value.model);
  return (
    <div className="model-settings">
      <div className="model-selectors">
        <label>
          モデル
          <select
            value={value.model ?? ""}
            disabled={disabled || loading}
            onChange={(e) => {
              const model = models.find((m) => m.model === e.target.value);
              onChange(
                model
                  ? {
                      ...value,
                      model: model.model,
                      effort: model.supportedReasoningEfforts.length
                        ? model.defaultReasoningEffort
                        : null,
                    }
                  : { ...value, model: null, effort: null },
              );
            }}
          >
            <option value="">スレッドの設定を使用</option>
            {value.model && !selected ? (
              <option value={value.model}>{value.model}（未確認）</option>
            ) : null}
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.displayName}
                {m.isDefault ? "（標準）" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          推論強度（グレード）
          <select
            value={value.effort ?? ""}
            disabled={
              disabled || loading || !selected?.supportedReasoningEfforts.length
            }
            onChange={(e) => onChange({ ...value, effort: e.target.value })}
          >
            {selected?.supportedReasoningEfforts.length &&
            !selected.supportedReasoningEfforts.some(
              (e) => e.reasoningEffort === value.effort,
            ) ? (
              <option value={value.effort ?? ""}>
                {value.effort ?? "未選択"}（未確認）
              </option>
            ) : null}
            {!selected?.supportedReasoningEfforts.length ? (
              <option value={value.effort ?? ""}>
                {value.model ? "設定なし" : "スレッドの設定を使用"}
              </option>
            ) : null}
            {selected?.supportedReasoningEfforts.map((e) => (
              <option
                key={e.reasoningEffort}
                value={e.reasoningEffort}
                title={e.description}
              >
                {effortLabels[e.reasoningEffort] ?? e.reasoningEffort}
                {e.reasoningEffort === selected.defaultReasoningEffort
                  ? " · 標準"
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="permission-selector">
          実行権限
          <select
            value={value.permission ?? "read-only"}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...value,
                permission: e.target.value as SendOptions["permission"],
              })
            }
          >
            <option value="read-only">読み取り専用</option>
            <option value="workspace-write">ワークスペースへの書き込み</option>
            <option value="danger-full-access">フルアクセス</option>
          </select>
        </label>
        <button
          type="button"
          className="model-reload"
          title={loading ? "モデル一覧を取得中…" : "モデル一覧を更新"}
          aria-label="モデル一覧を更新"
          disabled={disabled || loading}
          onClick={reload}
        >
          ↻
        </button>
      </div>
      {error ? (
        <p className="chat-error" role="alert">
          モデル一覧を取得できませんでした。{error}{" "}
          スレッドの設定を使う場合はそのまま送信できます。
        </p>
      ) : null}
    </div>
  );
}
