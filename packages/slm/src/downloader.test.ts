import { strict as assert } from 'node:assert';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
  downloadModel,
  formatBytes,
  getModelPath,
  modelPath,
  checkSpace,
  modelsDir,
  resolveModel,
  type DownloadProgress,
} from './downloader';
import { renderDownloadBar } from './progress';

/**
 * The real downloader speaks HTTPS; the tests speak HTTP to a local server and
 * inject the getter. The shapes match, so the cast is the whole adapter.
 */
type Getter = typeof import('node:https').get;

const BODY = Buffer.from('GGUF' + 'x'.repeat(2044)); // 2048 bytes, like a tiny model

interface Scenario {
  /** How many redirects to answer before serving the body. */
  redirects?: number;
  /** Serve only this many bytes, then end — a truncated download. */
  truncateTo?: number;
  /** Answer 200 and ignore a Range header, as some mirrors do. */
  ignoreRange?: boolean;
  status?: number;
}

let server: http.Server;
let baseUrl: string;
let scenario: Scenario = {};
const requests: Array<{ url: string; range?: string }> = [];

before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', range: req.headers.range });

    if (scenario.status && scenario.status !== 200) {
      res.writeHead(scenario.status);
      res.end('nope');
      return;
    }

    const hop = Number(new URL(req.url ?? '/', baseUrl).searchParams.get('hop') ?? 0);
    const wanted = scenario.redirects ?? 0;
    if (hop < wanted) {
      res.writeHead(302, { location: `${baseUrl}/model?hop=${hop + 1}` });
      res.end();
      return;
    }

    const range = scenario.ignoreRange ? undefined : req.headers.range;
    const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const full = BODY.subarray(from);
    const body = scenario.truncateTo === undefined ? full : full.subarray(0, scenario.truncateTo);

    res.writeHead(from > 0 && !scenario.ignoreRange ? 206 : 200, {
      'content-length': String(body.length),
    });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A model spec pointing at the local server, registered under a test key. */
function registerTestModel(key: string, bytes = BODY.length): void {
  (SUPPORTED_MODELS as Record<string, unknown>)[key] = {
    key,
    url: `${baseUrl}/model`,
    filename: `${key}.gguf`,
    bytes,
    label: 'test model',
  };
}

async function freshDir(name: string): Promise<string> {
  const dir = path.join(tmpdir(), `vigyl-slm-${name}-${Date.now()}`);
  await fsp.rm(dir, { recursive: true, force: true });
  return dir;
}

describe('model registry', () => {
  it('knows the Phi-3 default', () => {
    const spec = resolveModel();
    assert.equal(spec.key, DEFAULT_MODEL);
    assert.equal(spec.filename, 'phi3-mini-4k-q4.gguf');
    assert.ok(spec.url.startsWith('https://huggingface.co/'));
    assert.ok(spec.bytes > 1_000_000_000, 'a 3B Q4 model is over a gigabyte');
  });

  it('offers a model small enough for a tight disk', () => {
    const small = Object.values(SUPPORTED_MODELS)
      .filter((m) => !m.key.startsWith('test-'))
      .sort((a, b) => a.bytes - b.bytes)[0];
    assert.ok(small);
    assert.ok(small.bytes < 1_000_000_000, 'the smallest option should be under a gigabyte');
  });

  it('names the alternatives when asked for one it does not have', () => {
    assert.throws(() => resolveModel('gpt-5-mini-q4'), /Unknown model.*Available:.*phi3-mini-4k-q4/s);
  });

  it('puts models under the real home directory, not a folder named ~', () => {
    // The guide used process.env.HOME, which is unset on Windows.
    const dir = modelsDir();
    assert.equal(dir, path.join(homedir(), '.vigyl', 'models'));
    assert.ok(!dir.includes('~'), `models dir should not contain a literal ~: ${dir}`);
    assert.ok(path.isAbsolute(dir));
  });

  it('honours VIGYL_MODELS_DIR so a big file can live on another drive', () => {
    const previous = process.env.VIGYL_MODELS_DIR;
    try {
      process.env.VIGYL_MODELS_DIR = path.join(tmpdir(), 'vigyl-elsewhere');
      assert.equal(modelsDir(), path.resolve(path.join(tmpdir(), 'vigyl-elsewhere')));

      process.env.VIGYL_MODELS_DIR = '   ';
      assert.equal(modelsDir(), path.join(homedir(), '.vigyl', 'models'), 'blank falls back');
    } finally {
      if (previous === undefined) delete process.env.VIGYL_MODELS_DIR;
      else process.env.VIGYL_MODELS_DIR = previous;
    }
  });

  it('builds a full path for a model', () => {
    assert.equal(modelPath(DEFAULT_MODEL, '/models'), path.join('/models', 'phi3-mini-4k-q4.gguf'));
  });
});

describe('checkSpace', () => {
  it('reports what a model needs against what is free', async () => {
    const check = await checkSpace(DEFAULT_MODEL, tmpdir());
    assert.equal(check.neededBytes, resolveModel(DEFAULT_MODEL).bytes);
    assert.ok(check.freeBytes > 0, 'should read free space on this platform');
    assert.equal(typeof check.ok, 'boolean');
  });

  it('counts only the bytes still missing when resuming', async () => {
    const key = 'test-space-resume';
    registerTestModel(key, 10_000);
    const dir = await freshDir('space-resume');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${key}.gguf.part`), Buffer.alloc(4_000));

    const check = await checkSpace(key, dir);
    assert.equal(check.neededBytes, 6_000);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('works out space for a directory that does not exist yet', async () => {
    const dir = path.join(tmpdir(), 'vigyl-not-created-yet', 'nested', 'deeper');
    const check = await checkSpace(DEFAULT_MODEL, dir);
    assert.ok(check.freeBytes > 0, 'should walk up to a path that exists');
  });

  it('refuses a download that cannot fit', async () => {
    const key = 'test-too-big';
    // Larger than any real disk, so this fails everywhere the tests run.
    registerTestModel(key, Number.MAX_SAFE_INTEGER);
    const dir = await freshDir('too-big');

    await assert.rejects(
      () => downloadModel(key, { modelsDir: dir, fetchImpl: http.get as Getter }),
      /Not enough free space.*VIGYL_MODELS_DIR/s,
    );
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('downloadModel', () => {
  it('follows redirects to the CDN', async () => {
    const key = 'test-redirects';
    registerTestModel(key);
    const dir = await freshDir('redirects');
    scenario = { redirects: 2 };
    requests.length = 0;

    const file = await downloadModel(key, { modelsDir: dir, fetchImpl: http.get as Getter });

    assert.equal(requests.length, 3, 'two redirects then the body');
    const written = await fsp.readFile(file);
    assert.deepEqual(written, BODY);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('rejects a truncated download and removes the partial file', async () => {
    const key = 'test-truncated';
    registerTestModel(key);
    const dir = await freshDir('truncated');
    scenario = { truncateTo: 100 };

    await assert.rejects(
      () => downloadModel(key, { modelsDir: dir, fetchImpl: http.get as Getter }),
      /Download incomplete.*got 100 bytes, expected 2048/s,
    );

    const left = await fsp.readdir(dir);
    assert.deepEqual(left, [], 'no .part file should survive a failed download');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('resumes from a partial file instead of starting again', async () => {
    const key = 'test-resume';
    registerTestModel(key);
    const dir = await freshDir('resume');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${key}.gguf.part`), BODY.subarray(0, 1000));

    scenario = {};
    requests.length = 0;
    const seen: DownloadProgress[] = [];

    const file = await downloadModel(key, {
      modelsDir: dir,
      fetchImpl: http.get as Getter,
      progressIntervalMs: 0,
      onProgress: (p) => seen.push(p),
    });

    assert.equal(requests[0]?.range, 'bytes=1000-', 'should ask for the rest only');
    assert.deepEqual(await fsp.readFile(file), BODY);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((p) => p.resumed), 'progress should report the resume');
    assert.equal(seen.at(-1)?.receivedBytes, BODY.length, 'final progress counts the whole file');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('restarts cleanly when the server ignores the Range header', async () => {
    // Appending a full body onto a partial file would corrupt it silently.
    const key = 'test-norange';
    registerTestModel(key);
    const dir = await freshDir('norange');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${key}.gguf.part`), BODY.subarray(0, 1000));

    scenario = { ignoreRange: true };
    const file = await downloadModel(key, { modelsDir: dir, fetchImpl: http.get as Getter });

    assert.deepEqual(await fsp.readFile(file), BODY, 'file is the model, not 1000 extra bytes');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when the model is already there', async () => {
    const key = 'test-cached';
    registerTestModel(key);
    const dir = await freshDir('cached');
    scenario = {};

    await downloadModel(key, { modelsDir: dir, fetchImpl: http.get as Getter });
    requests.length = 0;
    const again = await downloadModel(key, { modelsDir: dir, fetchImpl: http.get as Getter });

    assert.equal(requests.length, 0, 'should not hit the network for a model it has');
    assert.ok(again.endsWith(`${key}.gguf`));
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('reports a failing status rather than saving the error page', async () => {
    const key = 'test-404';
    registerTestModel(key);
    const dir = await freshDir('404');
    scenario = { status: 404 };

    await assert.rejects(
      () => downloadModel(key, { modelsDir: dir, fetchImpl: http.get as Getter }),
      /HTTP 404/,
    );
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('treats a wrong-sized existing file as absent', async () => {
    const key = 'test-wrongsize';
    registerTestModel(key);
    const dir = await freshDir('wrongsize');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${key}.gguf`), Buffer.alloc(10));

    assert.equal(await getModelPath(key, dir), null);

    scenario = {};
    const file = await downloadModel(key, { modelsDir: dir, fetchImpl: http.get as Getter });
    assert.deepEqual(await fsp.readFile(file), BODY);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('progress rendering', () => {
  it('draws a bar that fills with the download', () => {
    const empty = renderDownloadBar({ receivedBytes: 0, totalBytes: 1000, resumed: false }, 1000);
    const half = renderDownloadBar({ receivedBytes: 500, totalBytes: 1000, resumed: false }, 1000);
    const full = renderDownloadBar({ receivedBytes: 1000, totalBytes: 1000, resumed: false }, 1000);

    assert.match(empty, /0%/);
    assert.match(half, /50%/);
    assert.match(full, /100%/);

    const filled = String.fromCharCode(0x25b0);
    assert.equal(empty.split(filled).length - 1, 0);
    assert.equal(full.split(filled).length - 1, 24);
  });

  it('shows a rate and notes a resume', () => {
    const line = renderDownloadBar({ receivedBytes: 2_097_152, totalBytes: 4_194_304, resumed: true }, 2000);
    assert.match(line, /1\.0 MB\/s/);
    assert.match(line, /\(resumed\)/);
  });

  it('survives a zero total without dividing by it', () => {
    const line = renderDownloadBar({ receivedBytes: 0, totalBytes: 0, resumed: false }, 0);
    assert.match(line, /0%/);
    assert.ok(!line.includes('NaN'));
  });
});

describe('formatBytes', () => {
  it('scales to a readable unit', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(2_393_231_072), '2.2 GB');
  });
});
