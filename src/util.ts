/** Small helpers with no Obsidian or Dropbox knowledge. */

/** Matches every character outside the printable-ASCII range. */
const NON_ASCII = /[\u007F-\uFFFF]/g;

/**
 * Dropbox's content endpoints carry their parameters in the `Dropbox-API-Arg`
 * HTTP header, and HTTP headers are ASCII-only. Any non-ASCII character in a
 * filename (accents, CJK, emoji) must be sent as a \uXXXX escape or Dropbox
 * rejects the request. This is the single most common cause of "it worked until
 * someone named a note in Japanese".
 */
export function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(
    NON_ASCII,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Debounce that also exposes a way to cancel a pending call on unload. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): { call: (...args: A) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call(...args: A) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, waitMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Run tasks with a bounded number in flight. Sync is network-bound, so some
 * parallelism matters a lot, but Dropbox starts returning 429 if we open the
 * floodgates.
 */
export async function pool<T>(
  limit: number,
  tasks: Array<() => Promise<T>>,
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, tasks.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= tasks.length) return;
        try {
          results[index] = { status: "fulfilled", value: await tasks[index]() };
        } catch (err) {
          results[index] = { status: "rejected", reason: err };
        }
      }
    },
  );

  await Promise.all(workers);
  return results;
}

/** Timestamp suffix for conflict copies: `2026-11-01 14-32-07`. */
export function conflictStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
