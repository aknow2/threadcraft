const paths = {
  archive: "M3 4h18v4H3ZM5 8v12h14V8M10 12h4",
  restore: "M3 4h18v4H3ZM5 8v12h14V8M12 17v-6m-3 3 3-3 3 3",
  diff: "M5 3h10l4 4v14H5ZM9 9h6m-3-3v6m-3 5h6",
  zoomIn: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6M7 10h6m-3-3v6",
  zoomOut: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6M7 10h6",
  refresh:
    "M20 7v5h-5 M4 17v-5h5 M6.1 6.1A8 8 0 0 1 20 12 M4 12a8 8 0 0 0 13.9 5.9",
  settings:
    "M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  terminal: "m5 7 5 5-5 5m8 0h6",
  plus: "M12 5v14M5 12h14",
  folder: "M3 7V5h6l2 2h10v13H3Z M12 10v7m-3-3.5h6",
  close: "m6 6 12 12M6 18 18 6",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  edit: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z",
  left: "m14 5-7 7 7 7",
  right: "m10 5 7 7-7 7",
  external: "M14 3h7v7m0-7L10 14M10 4H4v16h16v-6",
  send: "m3 3 19 9-19 9 4-9ZM7 12h15",
  stop: "M6 6h12v12H6Z",
  queue: "M4 5h16M4 10h16M4 15h8m5-1v7m-3-3.5h6",
  steer: "M5 20v-8a5 5 0 0 1 5-5h9m-5-5 5 5-5 5",
  play: "m8 4 12 8-12 8Z",
  fork: "M6 3v12a5 5 0 0 0 10 0V3M3 6l3-3 3 3m4 0 3-3 3 3",
  check: "m5 12 4 4L19 6",
  minimize: "M5 12h14",
  expand: "M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6",
  collapse: "M3 9h6V3m6 0v6h6M9 21v-6H3m12 6v-6h6",
  history: "M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2",
  grip: "M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z",
  attach: "m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2m-8 14 10-10",
};
export type IconName = keyof typeof paths;
export default function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="action-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
