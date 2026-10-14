import { createWriteStream, promises as fsp } from 'node:fs';
import { get as httpsGet } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * A GGUF model Vigyl knows how to fetch.
 *
 * `bytes` is the real on-disk size, used to tell a finished download from a
 * truncated one. A half-written 2 GB file is otherwise indistinguishable from a
 * complete one until llama.cpp fails to load it, several minutes later.
 */
export interface ModelSpec {
  readonly key: string;
  readonly url: string;
  readonly filename: string;
  readonly bytes: number;
  readonly label: string;
}

/**
 * Sizes are the real content-length from the CDN, checked on 2026-10-14.
 *
 * The guide also listed `phi3-mini-128k-q4`; that repo is gated and answers 401
 * to an anonymous request, so offering it would be offering a download that
 * cannot work without a Hugging Face token. Left out until there is a reason to
 * add token support.
 */
export const SUPPORTED_MODELS: Readonly<Record<string, ModelSpec>> = {
  'phi3-mini-4k-q4': {
    key: 'phi3-mini-4k-q4',
    url: 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf',
    filename: 'phi3-mini-4k-q4.gguf',
    bytes: 2_393_231_072,
    label: 'Phi-3 mini 4k instruct (Q4)',
  },
  'qwen2.5-1.5b-q4': {
    key: 'qwen2.5-1.5b-q4',
    url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    filename: 'qwen2.5-1.5b-q4.gguf',
    bytes: 986_048_768,
    label: 'Qwen2.5 1.5B instruct (Q4_K_M)',
  },
  'llama3.2-1b-q4': {
    key: 'llama3.2-1b-q4',
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    filename: 'llama3.2-1b-q4.gguf',
    bytes: 807_694_464,
    label: 'Llama 3.2 1B instruct (Q4_K_M)',
  },
  'llama3.2-3b-q4': {
    key: 'llama3.2-3b-q4',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    filename: 'llama3.2-3b-q4.gguf',
    bytes: 2_019_377_696,
    label: 'Llama 3.2 3B instruct (Q4_K_M)',
  },
};

export const DEFAULT_MODEL = 'phi3-mini-4k-q4';

/** Redirects to follow before giving up. Hugging Face uses two: LFS, then CDN. */
const MAX_REDIRECTS = 5;

/** A partial download keeps this suffix until it is verified and renamed. */
const PART_SUFFIX = '.part';

export interface DownloadProgress {
  readonly receivedBytes: number;
  /** Total size from the server, or the spec's size when the server omits it. */
  readonly totalBytes: number;
  /** True when this run resumed an earlier partial file. */
  readonly resumed: boolean;
}

export interface DownloadOptions {
  /** Where models live. Defaults to `~/.vigyl/models`. */
  modelsDir?: string;
  /** Called at most every `progressIntervalMs`, plus once at the end. */
  onProgress?: (progress: DownloadProgress) => void;
  progressIntervalMs?: number;
  /** Re-download even if a complete file is already present. */
  force?: boolean;
  /** Test seam: swap the HTTPS getter. */
  fetchImpl?: typeof httpsGet;
}

/**
 * Where models live: `$VIGYL_MODELS_DIR`, else `~/.vigyl/models`.
 *
 * The env var exists so a multi-gigabyte file can be put on another drive, or
 * anywhere with room, without moving the rest of Vigyl's state.
 *
 * The guide used `process.env.HOME`, which is unset on Windows, so the model
 * would have been written into a directory literally named `~` next to
 * wherever the process happened to start.
 */
export function modelsDir(): string {
  const configured = process.env.VIGYL_MODELS_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(homedir(), '.vigyl', 'models');
}

/** Headroom to leave free after a download, so the disk does not end up full. */
const FREE_SPACE_MARGIN = 500 * 1024 * 1024;

export interface SpaceCheck {
  readonly ok: boolean;
  readonly freeBytes: number;
  readonly neededBytes: number;
}

/**
 * Is there room for this model, plus a margin?
 *
 * Checked before the request rather than after two gigabytes of download, and
 * reported rather than thrown so a caller can show the numbers.
 */
export async function checkSpace(
  key: string = DEFAULT_MODEL,
  dir: string = modelsDir(),
): Promise<SpaceCheck> {
  const spec = resolveModel(key);
  const already = await partialBytes(path.join(dir, spec.filename + PART_SUFFIX));
  const neededBytes = Math.max(0, spec.bytes - already);

  // statfs needs a path that exists; walk up to the nearest one.
  let probe = dir;
  for (;;) {
    try {
      await fsp.stat(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }

  try {
    const stats = await fsp.statfs(probe);
    const freeBytes = stats.bavail * stats.bsize;
    return { ok: freeBytes >= neededBytes + FREE_SPACE_MARGIN, freeBytes, neededBytes };
  } catch {
    // If the platform will not say, do not block the download over it.
    return { ok: true, freeBytes: Number.POSITIVE_INFINITY, neededBytes };
  }
}

export function resolveModel(key: string = DEFAULT_MODEL): ModelSpec {
  const spec = SUPPORTED_MODELS[key];
  if (!spec) {
    const known = Object.keys(SUPPORTED_MODELS).join(', ');
    throw new Error(`Unknown model: ${key}. Available: ${known}`);
  }
  return spec;
}

export function modelPath(key: string = DEFAULT_MODEL, dir: string = modelsDir()): string {
  return path.join(dir, resolveModel(key).filename);
}

/**
 * The path to an already-downloaded model, or null.
 *
 * A file whose size does not match the spec is treated as absent: it is either a
 * truncated download or an upstream change, and loading either one wastes
 * minutes before failing somewhere far less obvious.
 */
export async function getModelPath(
  key: string = DEFAULT_MODEL,
  dir: string = modelsDir(),
): Promise<string | null> {
  const spec = resolveModel(key);
  const target = path.join(dir, spec.filename);
  try {
    const stat = await fsp.stat(target);
    return stat.size === spec.bytes ? target : null;
  } catch {
    return null;
  }
}

/** Bytes already fetched into the `.part` file, or 0. */
async function partialBytes(partPath: string): Promise<number> {
  try {
    return (await fsp.stat(partPath)).size;
  } catch {
    return 0;
  }
}

/**
 * One GET, following redirects.
 *
 * `https.get` does not follow them, and Hugging Face answers 302 to a CDN host.
 * As the guide was written it would have saved a few hundred bytes of redirect
 * body, reported a complete download, and left llama.cpp to produce the
 * confusing error hours later.
 */
function getFollowing(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof httpsGet,
  redirectsLeft = MAX_REDIRECTS,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = fetchImpl(url, { headers }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;

      if (status >= 300 && status < 400 && location) {
        res.resume(); // drain, or the socket is never released
        if (redirectsLeft === 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        const next = new URL(location, url).toString();
        getFollowing(next, headers, fetchImpl, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (status !== 200 && status !== 206) {
        res.resume();
        reject(new Error(`Download failed: HTTP ${status} from ${url}`));
        return;
      }

      resolve(res);
    });
    req.on('error', reject);
  });
}

/**
 * Download a model into `~/.vigyl/models`, resuming a partial file if one is
 * there.
 *
 * Returns the final path. Safe to call when the model is already present: it
 * returns immediately unless `force` is set.
 */
export async function downloadModel(
  key: string = DEFAULT_MODEL,
  options: DownloadOptions = {},
): Promise<string> {
  const spec = resolveModel(key);
  const dir = options.modelsDir ?? modelsDir();
  const fetchImpl = options.fetchImpl ?? httpsGet;
  const interval = options.progressIntervalMs ?? 500;

  const target = path.join(dir, spec.filename);
  const partPath = target + PART_SUFFIX;

  await fsp.mkdir(dir, { recursive: true });

  if (!options.force) {
    const existing = await getModelPath(key, dir);
    if (existing) return existing;
  } else {
    await fsp.rm(target, { force: true });
    await fsp.rm(partPath, { force: true });
  }

  const space = await checkSpace(key, dir);
  if (!space.ok) {
    throw new Error(
      `Not enough free space for ${spec.key}: needs ${formatBytes(space.neededBytes)} ` +
        `plus headroom, ${formatBytes(space.freeBytes)} free on ${dir}. ` +
        'Set VIGYL_MODELS_DIR to a drive with room, or choose a smaller model.',
    );
  }

  const already = await partialBytes(partPath);
  const headers: Record<string, string> = { 'user-agent': 'vigyl-slm' };
  if (already > 0) headers['range'] = `bytes=${already}-`;

  const res = await getFollowing(spec.url, headers, fetchImpl);

  // A server that ignores Range answers 200 and starts from zero; appending to
  // the partial file in that case would corrupt it.
  const resumed = already > 0 && res.statusCode === 206;
  if (already > 0 && !resumed) await fsp.rm(partPath, { force: true });

  const startAt = resumed ? already : 0;
  const declared = Number(res.headers['content-length'] ?? 0);
  const totalBytes = declared > 0 ? startAt + declared : spec.bytes;

  let received = startAt;
  let lastEmit = 0;
  const emit = (): void => {
    options.onProgress?.({ receivedBytes: received, totalBytes, resumed });
  };

  res.on('data', (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastEmit >= interval) {
      lastEmit = now;
      emit();
    }
  });

  // pipeline resolves when the file stream has flushed, not when the response
  // ends. The guide resolved on the response's 'end', which returns before the
  // last chunks reach disk.
  await pipeline(res, createWriteStream(partPath, { flags: resumed ? 'a' : 'w' }));
  emit();

  const written = await partialBytes(partPath);
  if (written !== spec.bytes) {
    await fsp.rm(partPath, { force: true });
    throw new Error(
      `Download incomplete for ${spec.key}: got ${written} bytes, expected ${spec.bytes}. ` +
        'The partial file was removed; run the download again.',
    );
  }

  await fsp.rename(partPath, target);
  return target;
}

/** `2.2 GB`, for progress output. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
