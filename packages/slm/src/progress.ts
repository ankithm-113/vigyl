import { formatBytes, type DownloadProgress } from './downloader';

// Escape sequences do not survive editing in this repo (see CLAUDE.md), so the
// control characters are built from their codes.
const CR = String.fromCharCode(13);
const FILLED = String.fromCharCode(0x25b0); // ▰, same glyphs as the Telegram bar
const EMPTY = String.fromCharCode(0x25b1); // ▱

const CELLS = 24;

/**
 * One line of download progress: a bar, a percentage, bytes, and a rate.
 *
 * Returned rather than printed so it can be asserted on in tests.
 */
export function renderDownloadBar(progress: DownloadProgress, elapsedMs: number): string {
  const { receivedBytes, totalBytes, resumed } = progress;
  const ratio = totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 0;
  const filled = Math.round(ratio * CELLS);
  const bar = FILLED.repeat(filled) + EMPTY.repeat(CELLS - filled);
  const percent = String(Math.floor(ratio * 100)).padStart(3, ' ');

  const seconds = elapsedMs / 1000;
  const rate = seconds > 0 ? receivedBytes / seconds : 0;
  const rateText = rate > 0 ? `${formatBytes(rate)}/s` : '--';

  const size = `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`;
  const tail = resumed ? ' (resumed)' : '';
  return `  ${bar} ${percent}%  ${size}  ${rateText}${tail}`;
}

/**
 * A progress callback that redraws one line in place.
 *
 * Falls back to a plain line per update when stdout is not a TTY, so piping to
 * a file or a CI log does not produce a single unreadable line of carriage
 * returns.
 */
export function createTerminalProgress(
  write: (text: string) => void = (text) => process.stdout.write(text),
  isTty: boolean = process.stdout.isTTY === true,
): (progress: DownloadProgress) => void {
  const startedAt = Date.now();
  let lastLength = 0;

  return (progress) => {
    const line = renderDownloadBar(progress, Date.now() - startedAt);
    if (!isTty) {
      write(line.trim() + '\n');
      return;
    }
    const padding = ' '.repeat(Math.max(0, lastLength - line.length));
    lastLength = line.length;
    write(CR + line + padding);
  };
}
