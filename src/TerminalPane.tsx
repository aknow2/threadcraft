import Icon from "./Icon";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { terminalApi } from "./terminalApi";
import { errorMessage } from "./api";

export default function TerminalPane({
  cwd,
  visible,
  onHide,
  onClose,
}: {
  cwd: string;
  visible: boolean;
  onHide: () => void;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const focus = useRef<(() => void) | null>(null);
  const session = useRef<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState("起動中…");
  const [error, setError] = useState("");
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const element = host.current!;
    let disposed = false;
    let ended = false;
    let id: string | null = null;
    let input = Promise.resolve();
    let frame = 0;
    setStatus("起動中…");
    setError("");
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      scrollback: 5000,
      disableStdin: true,
      theme: { background: "#0d1216", foreground: "#dce4e8" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    const report = (reason: unknown) => {
      if (!disposed) setError(errorMessage(reason));
    };
    function resize() {
      if (disposed || !element.clientWidth || !element.clientHeight) return;
      const dimensions = fit.proposeDimensions();
      if (!dimensions) return;
      const cols = Math.max(2, Math.min(500, dimensions.cols));
      const rows = Math.max(1, Math.min(200, dimensions.rows));
      if (term.cols === cols && term.rows === rows) return;
      term.resize(cols, rows);
      if (id && !ended) void terminalApi.resize(id, cols, rows).catch(report);
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(element);
    resize();
    focus.current = () => {
      resize();
      term.focus();
    };
    const data = term.onData((value) => {
      if (!id || ended || disposed) return;
      const bytes = new TextEncoder().encode(value);
      // Preserve input order and UTF-8 bytes even when a paste spans IPC chunks.
      input = input
        .then(async () => {
          for (let offset = 0; offset < bytes.length; offset += 4096) {
            if (disposed || ended || !id) return;
            await terminalApi.write(id, bytes.slice(offset, offset + 4096));
          }
        })
        .catch(report);
    });
    void terminalApi
      .open(cwd, term.cols, term.rows, (event) => {
        if (disposed) return;
        if (event.type === "data") term.write(new Uint8Array(event.bytes));
        if (event.type === "error") report(event.message);
        if (event.type === "exit") {
          ended = true;
          term.options.disableStdin = true;
          setStatus("終了しました");
        }
      })
      .then(async (openedId) => {
        id = openedId;
        if (disposed) {
          await terminalApi.close(openedId);
          return;
        }
        session.current = openedId;
        if (!ended) {
          term.options.disableStdin = false;
          setStatus("実行中");
          // The pane may have resized while shell startup was in progress.
          await terminalApi.resize(openedId, term.cols, term.rows);
          if (!disposed) term.focus();
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setStatus("起動に失敗しました");
          report(reason);
        }
      });
    return () => {
      disposed = true;
      session.current = null;
      focus.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      data.dispose();
      term.dispose();
      if (id) void terminalApi.close(id).catch(() => {});
    };
  }, [cwd, generation]);
  useEffect(() => {
    if (visible) focus.current?.();
  }, [visible]);

  async function close() {
    setClosing(true);
    try {
      if (session.current) await terminalApi.close(session.current);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
      setClosing(false);
    }
  }
  return (
    <section
      className="terminal-pane"
      aria-label="ターミナル"
      hidden={!visible}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="terminal-toolbar">
        <strong>ターミナル</strong>
        <span className="terminal-cwd" title={`開始フォルダ: ${cwd}`}>
          {cwd}
        </span>
        <span role="status">{status}</span>
        <button
          type="button"
          onClick={() => setGeneration((n) => n + 1)}
          disabled={closing || status === "起動中…" || status === "実行中"}
          className="icon-button"
          title="再起動"
        >
          <Icon name="refresh" />
          <span className="sr-only">再起動</span>
        </button>
        <button
          type="button"
          aria-label="ターミナルを隠す"
          onClick={onHide}
          className="icon-button"
          title="ターミナルを隠す"
        >
          <Icon name="minimize" />
          <span className="sr-only">縮小</span>
        </button>
        <button
          type="button"
          onClick={() => void close()}
          disabled={closing}
          className="icon-button"
          title="終了して閉じる"
        >
          <Icon name="close" />
          <span className="sr-only">終了して閉じる</span>
        </button>
      </div>
      <small className="terminal-hint">
        ローカルシェル · Ctrl+C で中断 · チャットの実行権限とは別に動作します
      </small>
      {error && (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      )}
      <div ref={host} className="terminal-host" />
    </section>
  );
}
