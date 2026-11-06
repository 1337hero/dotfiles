// How wide the chat runs in its pane. No Herdr imports, so `node --test` can load this file.
// It takes most of a wide pane, but stops short of lines too long to read. A narrow pane just fills, because every
// column is a max width. Sizes are the app's own units, so a window's zoom doesn't change the share.
const SMALLEST = 800, SHARE = 0.85, LARGEST = 1400;

export const chatWidth = (pane) => Math.round(Math.min(LARGEST, Math.max(SMALLEST, pane * SHARE)));
