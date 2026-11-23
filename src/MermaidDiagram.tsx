import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { renderMermaid } from "./mermaidRenderer";

export default function MermaidDiagram({ source }: { source: string }) {
  const [zoom, setZoom] = useState(100);
  const viewport = useRef<HTMLDivElement>(null);
  function resetZoom() {
    setZoom(100);
    if (viewport.current) {
      viewport.current.scrollTop = 0;
      viewport.current.scrollLeft = 0;
    }
  }
  const [result, setResult] = useState<{
    source: string;
    url?: string;
    failed?: boolean;
  } | null>(null);
  const current = result?.source === source ? result : null;
  useEffect(() => {
    let disposed = false;
    // Coalesce streamed tokens and ignore any render that finishes after an edit.
    const timer = setTimeout(() => {
      void renderMermaid(source).then(
        (url) => {
          if (!disposed) setResult({ source, url });
        },
        () => {
          if (!disposed) setResult({ source, failed: true });
        },
      );
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [source]);
  return (
    <figure className="mermaid-diagram">
      {current?.url ? (
        <>
          <div
            className="mermaid-zoom-controls"
            role="group"
            aria-label="図の表示倍率"
          >
            <button
              type="button"
              className="icon-button"
              title="図を縮小"
              aria-label="図を縮小"
              disabled={zoom <= 25}
              onClick={() => setZoom((value) => Math.max(25, value - 25))}
            >
              <Icon name="zoomOut" />
            </button>
            <output aria-label="表示倍率" aria-live="polite">
              {zoom}%
            </output>
            <button
              type="button"
              className="icon-button"
              title="図を拡大"
              aria-label="図を拡大"
              disabled={zoom >= 400}
              onClick={() => setZoom((value) => Math.min(400, value + 25))}
            >
              <Icon name="zoomIn" />
            </button>
            <button
              type="button"
              className="icon-button"
              title="図を表示幅に合わせる（100%）"
              aria-label="図の表示倍率をリセット"
              onClick={resetZoom}
            >
              <Icon name="expand" />
            </button>
          </div>
          <div
            ref={viewport}
            className="mermaid-scroll"
            tabIndex={0}
            role="region"
            aria-label="Mermaid図"
          >
            <img
              src={current.url}
              alt="Mermaid図"
              style={{ width: `${zoom}%` }}
              onError={() => setResult({ source, failed: true })}
            />
          </div>
        </>
      ) : (
        <p role="status">
          {current?.failed
            ? "図を描画できませんでした。記法を確認してください。"
            : "図を描画中…"}
        </p>
      )}
      <details open={!current?.url}>
        <summary>Mermaidコード</summary>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </details>
    </figure>
  );
}
