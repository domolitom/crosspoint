/**
 * Values lifted from the app, not invented for the video.
 *
 * The canvas is a light UI; the film is dark so the captured footage reads as a lit screen
 * in a dark room. Everything that is *not* footage borrows the app's own accent and slate
 * so the titles and the product look like one thing.
 */
export const theme = {
  bg: '#080c17',
  bgLift: '#0f1626',
  ink: '#f2f5fa',
  inkDim: '#98a3b8',
  inkFaint: '#5a6478',
  accent: '#2563eb',
  accentLift: '#60a5fa',
  // The app's node border colours, so a callout about "red" is the app's red.
  red: '#dc2626',
  amber: '#d97706',
  green: '#16a34a',
  violet: '#7c3aed',
  slate: '#94a3b8',
  border: '#1e293b',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
} as const;

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
