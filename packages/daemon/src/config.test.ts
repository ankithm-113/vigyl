import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  CONFIG_FILENAME,
  ConfigError,
  DEFAULT_MODEL,
  DEFAULT_OPENAI_MODEL,
  getConfig,
  isConfigLoaded,
  loadConfig,
  resetConfig,
  resolveLlm,
} from './config';
import { getLogLevel, setLogLevel } from './logger';

const ENV_KEYS = [
  'VIGYL_CONFIG',
  'VIGYL_WORKSPACE',
  'TELEGRAM_BOT_TOKEN',
  'VIGYL_ALLOWED_CHAT_IDS',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'VIGYL_PROVIDER',
  'VIGYL_MODEL',
  'VIGYL_LOG_LEVEL',
  'VIGYL_HITL_TIMEOUT_SECONDS',
] as const;

let tmpDir: string;
let realTmpDir: string;
let configPath: string;
let savedEnv: Record<string, string | undefined>;

/** The minimum config that should validate. */
function validConfig(): Record<string, unknown> {
  return {
    workspace_root: tmpDir,
    telegram: { bot_token: '123456789:AAEhBOweik6ad9YvHRnpTHRnpTHRnpTHRnp', allowed_chat_ids: [42] },
    anthropic: { api_key: 'sk-ant-test-key-value' },
  };
}

function write(config: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigyl-test-'));
  realTmpDir = fs.realpathSync.native(tmpDir);
  configPath = path.join(tmpDir, CONFIG_FILENAME);
  resetConfig();
  setLogLevel('info');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetConfig();
});

describe('loadConfig', () => {
  it('accepts a minimal valid config and applies every default', () => {
    write(validConfig());
    const config = loadConfig(configPath);

    assert.equal(config.anthropic?.model, DEFAULT_MODEL);
    assert.equal(config.daemon.log_level, 'info');
    assert.equal(config.daemon.log_retention_days, 7);
    assert.equal(config.hitl.timeout_seconds, 300);
    assert.deepEqual(config.hitl.require_for, [
      'production',
      'env',
      'delete',
      'migrate',
      'push',
    ]);
    assert.equal(config.self_heal.enabled, true);
    assert.equal(config.self_heal.max_retries, 3);
    assert.equal(config.self_heal.context_lines, 80);
  });

  it('canonicalizes workspace_root to a real absolute path', () => {
    write({ ...validConfig(), workspace_root: path.join(tmpDir, 'sub', '..') });
    const config = loadConfig(configPath);

    assert.equal(config.workspace_root, realTmpDir);
    assert.ok(path.isAbsolute(config.workspace_root));
  });

  it('coerces string chat IDs to numbers and keeps negative group IDs', () => {
    write({
      ...validConfig(),
      telegram: { bot_token: '1:x', allowed_chat_ids: ['42', -1001234567890, ' 7 '] },
    });
    const config = loadConfig(configPath);

    assert.deepEqual(config.telegram.allowed_chat_ids, [42, -1001234567890, 7]);
  });

  it('lets environment variables override the file', () => {
    write(validConfig());
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-from-env';
    process.env['VIGYL_LOG_LEVEL'] = 'debug';
    process.env['VIGYL_ALLOWED_CHAT_IDS'] = '1,2, 3';

    const config = loadConfig(configPath);

    assert.equal(config.anthropic?.api_key, 'sk-ant-from-env');
    assert.equal(config.daemon.log_level, 'debug');
    assert.deepEqual(config.telegram.allowed_chat_ids, [1, 2, 3]);
  });

  it('loads from environment variables alone when no file exists', () => {
    process.env['VIGYL_WORKSPACE'] = tmpDir;
    process.env['TELEGRAM_BOT_TOKEN'] = '123:abc';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-only';

    const config = loadConfig(configPath);

    assert.equal(config.workspace_root, realTmpDir);
    assert.equal(config.anthropic?.api_key, 'sk-ant-env-only');
  });

  it('applies daemon.log_level to the logger', () => {
    write({ ...validConfig(), daemon: { log_level: 'error' } });
    loadConfig(configPath);

    assert.equal(getLogLevel(), 'error');
  });
});

describe('loadConfig error reporting', () => {
  it('names the missing field and the env var that would set it', () => {
    const config = validConfig();
    delete config['anthropic'];
    write(config);

    assert.throws(
      () => loadConfig(configPath),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        // With no LLM block at all the default provider, OpenAI, is required.
        assert.match(err.message, /openai\.api_key/);
        assert.match(err.message, /OPENAI_API_KEY/);
        assert.match(err.message, /vigyl init/);
        return true;
      },
    );
  });

  it('reports every problem at once, not just the first', () => {
    write({ workspace_root: path.join(tmpDir, 'does-not-exist'), telegram: {}, anthropic: {} });

    try {
      loadConfig(configPath);
      assert.fail('expected ConfigError');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.problems.length >= 3, `expected >=3 problems, got ${err.problems.length}`);
      assert.ok(err.problems.some((p) => p.startsWith('workspace_root:')));
      assert.ok(err.problems.some((p) => p.includes('TELEGRAM_BOT_TOKEN')));
      assert.ok(err.problems.some((p) => p.includes('ANTHROPIC_API_KEY')));
    }
  });

  it('rejects a workspace_root that is not a directory', () => {
    const filePath = path.join(tmpDir, 'a-file.txt');
    fs.writeFileSync(filePath, 'x');
    write({ ...validConfig(), workspace_root: filePath });

    assert.throws(() => loadConfig(configPath), /not a directory|does not exist/);
  });

  it('rejects unknown keys instead of silently ignoring them', () => {
    write({ ...validConfig(), telegram_bot_token: 'flat-shape-typo' });

    assert.throws(() => loadConfig(configPath), /Unrecognized key/);
  });

  it('rejects a non-integer chat ID', () => {
    write({ ...validConfig(), telegram: { bot_token: '1:x', allowed_chat_ids: ['not-a-number'] } });

    assert.throws(() => loadConfig(configPath), /not a valid Telegram chat ID/);
  });

  it('explains malformed JSON without dumping the file', () => {
    fs.writeFileSync(configPath, '{ "workspace_root": ', 'utf-8');

    assert.throws(() => loadConfig(configPath), /is not valid JSON/);
  });

  it('tells the user to run init when nothing is configured at all', () => {
    assert.throws(() => loadConfig(configPath), /vigyl init/);
  });
});

describe('getConfig', () => {
  it('throws before loadConfig has run', () => {
    assert.equal(isConfigLoaded(), false);
    assert.throws(() => getConfig(), /has not been loaded/);
  });

  it('returns the memoized config after loading, and resetConfig clears it', () => {
    write(validConfig());
    const loaded = loadConfig(configPath);

    assert.equal(isConfigLoaded(), true);
    assert.equal(getConfig(), loaded);

    resetConfig();
    assert.equal(isConfigLoaded(), false);
  });
});

describe('LLM provider selection', () => {
  function base(): Record<string, unknown> {
    const { anthropic: _dropped, ...rest } = validConfig();
    return rest;
  }

  it('defaults to OpenAI with gpt-4o-mini when OPENAI_API_KEY is set', () => {
    write(base());
    process.env['OPENAI_API_KEY'] = 'sk-proj-test';

    const config = loadConfig(configPath);

    assert.equal(config.provider, 'openai');
    assert.deepEqual(resolveLlm(config), {
      provider: 'openai',
      api_key: 'sk-proj-test',
      model: DEFAULT_OPENAI_MODEL,
    });
    assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-4o-mini');
  });

  it('prefers OpenAI when both keys are present', () => {
    write(validConfig());
    process.env['OPENAI_API_KEY'] = 'sk-proj-test';

    assert.equal(loadConfig(configPath).provider, 'openai');
  });

  it('falls back to Anthropic when it is the only key', () => {
    write(validConfig());

    const config = loadConfig(configPath);

    assert.equal(config.provider, 'anthropic');
    assert.equal(resolveLlm(config).model, DEFAULT_MODEL);
  });

  it('honours VIGYL_PROVIDER over auto-detection', () => {
    write(validConfig());
    process.env['OPENAI_API_KEY'] = 'sk-proj-test';
    process.env['VIGYL_PROVIDER'] = 'anthropic';

    assert.equal(loadConfig(configPath).provider, 'anthropic');
  });

  it('applies VIGYL_MODEL to the active provider only', () => {
    write(validConfig());
    process.env['OPENAI_API_KEY'] = 'sk-proj-test';
    process.env['VIGYL_MODEL'] = 'gpt-4o';

    const config = loadConfig(configPath);

    assert.equal(config.openai?.model, 'gpt-4o');
    assert.equal(config.anthropic?.model, DEFAULT_MODEL);
  });

  it('rejects an explicit provider whose block is missing', () => {
    write({ ...validConfig(), provider: 'openai' });

    assert.throws(
      () => loadConfig(configPath),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.problems.some((p) => p.includes('openai.api_key') && p.includes('OPENAI_API_KEY')));
        return true;
      },
    );
  });
});
