import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import MarkdownMessage from "./MarkdownMessage";

import { openUrl } from "@tauri-apps/plugin-opener";
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("renders headings, nested lists, GFM tables, tasks, quotes, and code", () => {
  const { container } = render(
    <MarkdownMessage
      text={
        '## 結果\n\n**強調**と`inline`\n\n- 親\n  - 子\n\n- [x] 完了\n\n> 引用\n\n| 項目 | 値 |\n| --- | --- |\n| A | 1 |\n\n```ts\nconst x = "<tag>";\n```'
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "結果", level: 2 })).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("強調");
  expect(container.querySelector("ul ul")?.textContent).toContain("子");
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("table")).toBeTruthy();
  expect(container.querySelector("blockquote")?.textContent).toContain("引用");
  expect(container.querySelector("pre code")?.textContent).toBe(
    'const x = "<tag>";\n',
  );
});

it("keeps raw HTML inert and does not create executable links or fetch images", () => {
  const { container } = render(
    <MarkdownMessage
      text={
        "<script>alert(1)</script>\n\n[危険](javascript:alert)\n\n[資料](https://example.com)\n\n![外部画像](https://example.com/pixel.png)"
      }
    />,
  );
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(screen.queryByRole("link", { name: "危険" })).toBeNull();
  const link = screen.getByRole("link", { name: "資料" });
  expect(link.getAttribute("href")).toBe("https://example.com");
  expect(link.getAttribute("rel")).toContain("noopener");
});

it("updates unfinished streamed Markdown as more text arrives", () => {
  const { container, rerender } = render(
    <MarkdownMessage text={"```js\nconst value ="} />,
  );
  expect(container.querySelector("pre code")?.textContent).toContain(
    "const value =",
  );
  rerender(
    <MarkdownMessage text={"```js\nconst value = 1;\n```\n\n**完了**"} />,
  );
  expect(container.querySelector("pre code")?.textContent).toBe(
    "const value = 1;\n",
  );
  expect(container.querySelector("strong")?.textContent).toBe("完了");
});

it("opens links through the OS handler and reports launch failures", async () => {
  vi.mocked(openUrl).mockRejectedValue(new Error("unavailable"));
  render(<MarkdownMessage text="[資料](https://example.com)" />);
  const link = screen.getByRole("link", { name: "資料" });
  expect(fireEvent.click(link)).toBe(false);
  await waitFor(() =>
    expect(openUrl).toHaveBeenCalledWith("https://example.com"),
  );
  await screen.findByRole("alert");
});
