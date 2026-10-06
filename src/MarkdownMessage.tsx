import { memo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { openUrl } from "@tauri-apps/plugin-opener";

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const [error, setError] = useState(false);
  async function open() {
    setError(false);
    try {
      await openUrl(href);
    } catch {
      setError(true);
    }
  }
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          void open();
        }}
        onAuxClick={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            void open();
          }
        }}
      >
        {children}
      </a>
      {error && (
        <span role="alert" className="chat-error">
          リンクを開けませんでした。もう一度クリックしてください。
        </span>
      )}
    </>
  );
}

const plugins = [remarkGfm];
const components: Components = {
  a: ({ href, children }) =>
    href && /^(https?:\/\/|mailto:)/i.test(href) ? (
      <ExternalLink href={href}>{children}</ExternalLink>
    ) : (
      <span title={href}>{children}</span>
    ),
  // Remote images are not fetched automatically by the desktop app.
  img: ({ alt, src }) => <span title={src}>{alt || "画像"}</span>,
  table: ({ children }) => (
    <div
      className="markdown-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="表"
    >
      <table>{children}</table>
    </div>
  ),
};

const MarkdownMessage = memo(function MarkdownMessage({
  text,
}: {
  text: string;
}) {
  return (
    <div className="message-text markdown-message">
      <Markdown remarkPlugins={plugins} components={components}>
        {text || "（テキストなし）"}
      </Markdown>
    </div>
  );
});
export default MarkdownMessage;
