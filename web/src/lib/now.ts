// Fake data is fixed relative to NOW so screenshots stay the same, until the
// web reads the server (#8).
export const NOW = new Date("2026-10-04T19:00:00Z");

export const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
export const ahead = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
