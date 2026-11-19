// Path data copied from docs/design/avant-garde/icons.md. Square caps, miter joins, no fill
// (play, dot and stop are solid). Never swap in an icon library with soft caps.
const PATHS = {
  play: <path d="M7 4.5v15l12-7.5z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  zoomadd: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21M10.5 8v5M8 10.5h5" />
    </>
  ),
  cut: (
    <>
      <circle cx="6" cy="6.5" r="2.5" />
      <circle cx="6" cy="17.5" r="2.5" />
      <path d="M8 8l12 9M8 16L20 7" />
    </>
  ),
  auto: (
    <>
      <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6" />,
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-4" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 000 12h4" />
    </>
  ),
  down: <path d="M12 4v13M6 12l6 6 6-6" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  layers: (
    <>
      <path d="M12 4l9 5-9 5-9-5z" />
      <path d="M3 14l9 5 9-5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17.2v.01" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  folder: <path d="M3 7h6l2 2h10v10H3z" />,
  contrast: <path d="M4 4h16v16H4zM12 4v16M12 8h8M12 12h8M12 16h8" />,
  archive: <path d="M3 4h18v5H3zM5 9v11h14V9M10 13h4" />,
  fullscreen: <rect x="3" y="5" width="18" height="14" />,
  portrait: <rect x="7" y="3" width="10" height="18" />,
  window: (
    <>
      <rect x="3" y="5" width="18" height="14" />
      <path d="M3 9h18" />
    </>
  ),
  region: <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />,
  exact: (
    <>
      <rect x="3" y="8" width="18" height="8" />
      <path d="M7 8v3M11 8v4M15 8v3M19 8v4" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" />
      <path d="M5 11a7 7 0 0014 0M12 18v3" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="5" width="18" height="14" />
      <path d="M14 5v14" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="6" width="13" height="12" />
      <path d="M16 10l5-3v10l-5-3" />
    </>
  ),
  cursor: <path d="M5 3l13 6-5.5 1.8L10 16z" />,
  eyeoff: (
    <>
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
      <path d="M4 4l16 16" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  dot: <circle cx="12" cy="12" r="6" />,
  stop: <rect x="6" y="6" width="12" height="12" />,
  micoff: (
    <>
      <rect x="9" y="3" width="6" height="11" />
      <path d="M5 11a7 7 0 0014 0M12 18v3M4 4l16 16" />
    </>
  ),
  ai: <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" />,
  captions: (
    <>
      <rect x="3" y="6" width="18" height="12" />
      <path d="M7 14h4M13 14h4M7 10h10" />
    </>
  ),
  split: <path d="M12 3v18M3 8h5v8H3M21 8h-5v8h5" />,
  join: (
    <>
      <rect x="3" y="8" width="18" height="8" />
      <path d="M9 12h6" />
    </>
  ),
  speaker: <path d="M4 9h4l5-4v14l-5-4H4zM16.5 9.5a3.5 3.5 0 010 5M19 7a7 7 0 010 10" />,
  zoomout: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21M8 10.5h5" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  list: <path d="M4 6h3v3H4zM4 15h3v3H4zM11 7.5h9M11 16.5h9" />,
  pen: <path d="M4 20l1.5-5L16 4.5l3.5 3.5L9 18.5zM14 6.5l3.5 3.5" />,
  highlight: <path d="M8 15l8.5-11L20 7 9 15.5zM8 15l-1 4h4l-2-3.5M4 21h16" />,
  arrow: <path d="M5 19L18 6M10 5h9v9" />,
  box: <rect x="4" y="6" width="16" height="12" />,
  oval: <ellipse cx="12" cy="12" rx="9" ry="6" />,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  erase: <path d="M8 20l-4-4L14 6l6 6-8 8zM9 11l5 5M12 20h8" />,
} as const;

const SOLID = new Set(["play", "dot", "stop"]);

export type IconName = keyof typeof PATHS;

/** `turn` rotates the icon, as the mockups do for the "Open" arrow (down turned -90). */
export function Icon({ name, size = 15, turn }: { name: IconName; size?: number; turn?: number }) {
  const solid = SOLID.has(name);
  return (
    <svg
      className="ic"
      style={turn ? { transform: `rotate(${turn}deg)` } : undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={solid ? "currentColor" : "none"}
      stroke={solid ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      {PATHS[name]}
    </svg>
  );
}
