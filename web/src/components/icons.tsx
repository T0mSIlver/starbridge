// Line icons, 24px grid, drawn in currentColor.

type Props = { size?: number };

function Icon({ size = 22, children }: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const InboxIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4 13l2.5-7.5h11L20 13" />
    <path d="M4 13v5.5h16V13h-4.5a3.5 3.5 0 0 1-7 0H4z" />
  </Icon>
);

export const GaugeIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4.5 17a8.5 8.5 0 1 1 15 0" />
    <path d="M12 13l3.5-4" />
    <circle cx="12" cy="13" r="1.2" />
  </Icon>
);

export const DevicesIcon = (p: Props) => (
  <Icon {...p}>
    <rect x="3" y="5" width="13" height="10" rx="1.5" />
    <path d="M7 19h5" />
    <rect x="17" y="9" width="4.5" height="10" rx="1.2" />
  </Icon>
);

/** The space elevator (DESIGN.md, "Icon") without its ground: planet and tether in the text colour,
    the climber in amber. */
export const Mark = ({ size = 28 }: Props) => (
  <svg width={size} height={size} viewBox="22 22 64 64" aria-hidden="true">
    <path fill="var(--fg)" d="M0,88.97 A80,80 0 0 1 108,88.97 V108 H0 Z" />
    <path fill="var(--fg)" d="M51.75,0 H56.25 V72 H51.75 Z" />
    <path
      fill="var(--accent)"
      d="M48.5,39.5 A5.5,5.5 0 0 1 59.5,39.5 V48.5 A5.5,5.5 0 0 1 48.5,48.5 Z"
    />
  </svg>
);
