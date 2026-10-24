/** Minimal 24px line icons (1.75 stroke). Decorative: always paired with a text label. */
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  budget: 'M4 5h16v14H4z M4 9h16 M8 13h3 M8 16h5',
  inbox: 'M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z M3 13h5l1.5 3h5L16 13h5',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3.5 6h.01 M3.5 12h.01 M3.5 18h.01',
  upload: 'M12 15V3 M7 8l5-5 5 5 M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  bank: 'M3 9.5 12 4l9 5.5 M5 10v8 M9.5 10v8 M14.5 10v8 M19 10v8 M3 20h18',
  tag: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z M7.5 7.5h.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  rules: 'M4 6h10 M4 12h7 M4 18h10 M17 9l4 3-4 3',
  chart: 'M3 3v18h18 M7 15l4-5 3 3 6-7',
  insights: 'M4 20V10 M10 20V4 M16 20v-7 M21 20H3',
  lock: 'M6 11h12v10H6z M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6 6 18',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
