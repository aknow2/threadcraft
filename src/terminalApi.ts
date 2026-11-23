import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

export type TerminalEvent =
  | { type: "data"; bytes: number[] }
  | { type: "exit" }
  | { type: "error"; message: string };

export const terminalApi = {
  open(
    cwd: string,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ) {
    if (!isTauri())
      return Promise.reject(
        new Error("ターミナルはデスクトップアプリで利用できます。"),
      );
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    return invoke<string>("terminal_open", {
      cwd,
      cols,
      rows,
      onEvent: channel,
    });
  },
  write: (id: string, bytes: Uint8Array) =>
    invoke<void>("terminal_write", { id, bytes: Array.from(bytes) }),
  resize: (id: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  close: (id: string) => invoke<void>("terminal_close", { id }),
};
