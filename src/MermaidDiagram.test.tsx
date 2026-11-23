import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import MarkdownMessage from "./MarkdownMessage";
import { renderMermaid } from "./mermaidRenderer";
vi.mock("./mermaidRenderer", () => ({ renderMermaid: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("renders Mermaid fences as images with source available, leaving ordinary code alone", async () => {
  vi.useFakeTimers();
  vi.mocked(renderMermaid).mockResolvedValue("data:image/svg+xml,test");
  const { container } = render(
    <MarkdownMessage
      text={"```mermaid\nflowchart LR\nA-->B\n```\n\n```js\nconst x = 1;\n```"}
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(
    screen.getByRole("img", { name: "Mermaid図" }).getAttribute("src"),
  ).toBe("data:image/svg+xml,test");
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector("code.language-js")?.textContent).toContain(
    "const x = 1;",
  );
});

it("shows code on parse failure and recovers as streamed content becomes valid", async () => {
  vi.useFakeTimers();
  vi.mocked(renderMermaid)
    .mockRejectedValueOnce(new Error("parse failed"))
    .mockResolvedValueOnce("data:image/svg+xml,fixed");
  const { rerender, container } = render(
    <MarkdownMessage text={"```mermaid\nflowchart LR\nA-->"} />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(screen.getByRole("status").textContent).toContain(
    "描画できませんでした",
  );
  expect(container.querySelector("details")?.open).toBe(true);
  rerender(<MarkdownMessage text={"```mermaid\nflowchart LR\nA-->B\n```"} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(screen.getByRole("img").getAttribute("src")).toContain("fixed");
});

it("ignores an obsolete render result after the source changes", async () => {
  vi.useFakeTimers();
  let finishOld!: (value: string) => void;
  vi.mocked(renderMermaid)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    )
    .mockResolvedValueOnce("data:image/svg+xml,new");
  const { rerender } = render(
    <MarkdownMessage text={"```mermaid\ngraph LR; A-->B\n```"} />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  rerender(<MarkdownMessage text={"```mermaid\ngraph LR; A-->C\n```"} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
    finishOld("data:image/svg+xml,old");
  });
  expect(screen.getByRole("img").getAttribute("src")).toContain("new");
});

it("zooms within limits and resets the image and scroll position without redrawing", async () => {
  vi.useFakeTimers();
  vi.mocked(renderMermaid).mockResolvedValue("data:image/svg+xml,test");
  render(<MarkdownMessage text={"```mermaid\ngraph LR; A-->B\n```"} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  const image = screen.getByRole("img") as HTMLImageElement;
  const zoomIn = screen.getByRole("button", {
    name: "図を拡大",
  }) as HTMLButtonElement;
  const zoomOut = screen.getByRole("button", {
    name: "図を縮小",
  }) as HTMLButtonElement;
  expect(image.style.width).toBe("100%");
  fireEvent.click(zoomIn);
  expect(image.style.width).toBe("125%");
  for (let i = 0; i < 20; i++) fireEvent.click(zoomIn);
  expect(image.style.width).toBe("400%");
  expect(zoomIn.disabled).toBe(true);
  for (let i = 0; i < 20; i++) fireEvent.click(zoomOut);
  expect(image.style.width).toBe("25%");
  expect(zoomOut.disabled).toBe(true);
  const viewport = screen.getByRole("region", { name: "Mermaid図" });
  viewport.scrollTop = 100;
  viewport.scrollLeft = 100;
  fireEvent.click(
    screen.getByRole("button", { name: "図の表示倍率をリセット" }),
  );
  expect(image.style.width).toBe("100%");
  expect(viewport.scrollTop).toBe(0);
  expect(viewport.scrollLeft).toBe(0);
  expect(renderMermaid).toHaveBeenCalledTimes(1);
});
