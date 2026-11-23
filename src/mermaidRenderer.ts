let engine: Promise<(typeof import("mermaid"))["default"]> | undefined;
let sequence = 0;

export async function renderMermaid(source: string): Promise<string> {
  if (source.length > 32_000) throw new Error("Diagram is too large");
  engine ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
      maxTextSize: 32_000,
      maxEdges: 500,
    });
    return mermaid;
  });
  const mermaid = await engine;
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1000px;visibility:hidden;pointer-events:none";
  host.setAttribute("aria-hidden", "true");
  document.body.append(host);
  try {
    const { svg } = await mermaid.render(
      `chat-mermaid-${++sequence}`,
      source,
      host,
    );
    // Render as an image: SVG scripts, links and event handlers cannot run in the chat DOM.
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } finally {
    host.remove();
  }
}
