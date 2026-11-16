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
  dot: <circle cx="12" cy="12" r="6" />,
  stop: <rect x="6" y="6" width="12" height="12" />,
} as const;

const SOLID = new Set(["play", "dot", "stop"]);

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  const solid = SOLID.has(name);
  return (
    <svg
      className="ic"
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
