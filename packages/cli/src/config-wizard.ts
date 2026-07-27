/**
 * Interactive setup wizard.
 *
 * Every credential is checked against the live service before anything is
 * written. The alternative — write the file, then find out from a silent
 * background process that the key was wrong — is the difference between a
 * five-minute setup and an evening of guessing.
 */
import * as fs from 'fs';
import * as path from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import {
  captureChatId,
  checkAnthropicKey,
  checkCommandParsing,
  checkTelegramToken,
  DEFAULT_MODEL,
  type CheckResult,
} from '@vigyl/daemon';

export const CONFIG_FILENAME = 'vigyl.config.json';

export interface WizardResult {
  configPath: string;
  config: Record<string, unknown>;
  botUsername?: string;
}

/** Run a check with a spinner. Returns whether it passed. */
async function withSpinner(label: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
  const spinner = ora(label).start();
  const result = await run();
  if (result.ok) spinner.succeed(chalk.green(result.detail));
  else spinner.fail(chalk.red(result.detail));
  return result;
}

/** Ask until the answer passes a live check, or the user gives up. */
async function promptUntilValid(
  question: { name: string; message: string; validateShape?: (value: string) => true | string },
  check: (value: string) => Promise<CheckResult>,
): Promise<{ value: string; result: CheckResult } | undefined> {
  for (;;) {
    const answers = await inquirer.prompt<Record<string, string>>([
      {
        type: 'password',
        mask: '*',
        name: question.name,
        message: question.message,
        validate: (value: string) => {
          const trimmed = value.trim();
          if (trimmed === '') return 'Required.';
          return question.validateShape?.(trimmed) ?? true;
        },
      },
    ]);

    const value = (answers[question.name] ?? '').trim();
    const result = await withSpinner('Checking...', () => check(value));
    if (result.ok) return { value, result };

    const { retry } = await inquirer.prompt<{ retry: boolean }>([
      { type: 'confirm', name: 'retry', message: 'Try a different value?', default: true },
    ]);
    if (!retry) return undefined;
  }
}

/**
 * Headless setup, for CI and for any shell without a TTY.
 *
 * Reads both credentials from the environment rather than prompting, runs the
 * same live checks, and writes the same config. Secrets come from env so they
 * never land in shell history or a terminal transcript.
 */
export async function runHeadless(cwd: string = process.cwd()): Promise<WizardResult | undefined> {
  const apiKey = (process.env['ANTHROPIC_API_KEY'] ?? '').trim();
  const botToken = (process.env['TELEGRAM_BOT_TOKEN'] ?? '').trim();
  const workspace = (process.env['VIGYL_WORKSPACE'] ?? cwd).trim();

  const missing: string[] = [];
  if (apiKey === '') missing.push('ANTHROPIC_API_KEY');
  if (botToken === '') missing.push('TELEGRAM_BOT_TOKEN');

  if (missing.length > 0) {
    console.error(chalk.red('Missing required environment variable(s): ' + missing.join(', ')));
    console.error(chalk.gray('Set them, or run `vigyl init` in a terminal.'));
    return undefined;
  }

  const resolvedWorkspace = fs.realpathSync.native(path.resolve(workspace));
  console.log(chalk.gray('  Workspace: ' + resolvedWorkspace));

  const keyCheck = await withSpinner('Checking Anthropic API key...', () =>
    checkAnthropicKey(apiKey, DEFAULT_MODEL),
  );
  if (!keyCheck.ok) return undefined;

  // The check that actually proves structured outputs work end to end.
  const parseCheck = await withSpinner('Testing structured-output command parsing...', () =>
    checkCommandParsing(apiKey, DEFAULT_MODEL, resolvedWorkspace),
  );
  if (!parseCheck.ok) return undefined;

  const tokenCheck = await withSpinner('Checking Telegram bot token...', () =>
    checkTelegramToken(botToken),
  );
  if (!tokenCheck.ok) return undefined;
  const botUsername = String(tokenCheck.info?.['username'] ?? '');

  console.log(chalk.yellow('  Message @' + botUsername + ' on Telegram now to authorize your chat.'));
  const spinner = ora('Waiting for a message (2 minutes)...').start();
  const captured = await captureChatId(botToken);
  if (captured.ok && captured.chatId !== undefined) spinner.succeed(chalk.green(captured.detail));
  else spinner.warn(chalk.yellow(captured.detail));

  const allowedChatIds = captured.chatId === undefined ? [] : [captured.chatId];

  const config = {
    workspace_root: resolvedWorkspace,
    telegram: { bot_token: botToken, allowed_chat_ids: allowedChatIds },
    anthropic: { api_key: apiKey, model: DEFAULT_MODEL },
    hitl: {
      require_for: ['production', 'env', 'delete', 'migrate', 'push'],
      timeout_seconds: 300,
    },
    self_heal: { enabled: true, max_retries: 3, context_lines: 80 },
    daemon: { log_level: 'info', log_retention_days: 7 },
  };

  const configPath = path.join(cwd, CONFIG_FILENAME);
  writeConfig(configPath, config);
  ensureGitignored(cwd);

  return { configPath, config, ...(botUsername === '' ? {} : { botUsername }) };
}

export async function runWizard(cwd: string = process.cwd()): Promise<WizardResult | undefined> {
  // ---- workspace -----------------------------------------------------------
  const { workspaceRoot } = await inquirer.prompt<{ workspaceRoot: string }>([
    {
      type: 'input',
      name: 'workspaceRoot',
      message: 'Project directory Vigyl may control:',
      default: cwd,
      validate: (value: string) => {
        const resolved = path.resolve(value.trim());
        if (!fs.existsSync(resolved)) return `No such directory: ${resolved}`;
        if (!fs.statSync(resolved).isDirectory()) return `Not a directory: ${resolved}`;
        return true;
      },
    },
  ]);
  const resolvedWorkspace = fs.realpathSync.native(path.resolve(workspaceRoot.trim()));
  console.log(chalk.gray(`  Vigyl will be confined to ${resolvedWorkspace}\n`));

  // ---- Anthropic -----------------------------------------------------------
  const anthropic = await promptUntilValid(
    {
      name: 'apiKey',
      message: 'Anthropic API key:',
      validateShape: (value) =>
        value.startsWith('sk-ant-') ? true : 'That does not look like an Anthropic key (sk-ant-…).',
    },
    (value) => checkAnthropicKey(value, DEFAULT_MODEL),
  );
  if (anthropic === undefined) return undefined;

  // The only check that proves structured outputs actually work end to end.
  const parseCheck = await withSpinner('Testing command parsing (uses a few tokens)...', () =>
    checkCommandParsing(anthropic.value, DEFAULT_MODEL, resolvedWorkspace),
  );
  if (!parseCheck.ok) {
    const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
      {
        type: 'confirm',
        name: 'proceed',
        message: 'Command parsing failed. Save the config anyway?',
        default: false,
      },
    ]);
    if (!proceed) return undefined;
  }

  // ---- Telegram ------------------------------------------------------------
  console.log(chalk.gray('\n  Create a bot with @BotFather in Telegram, then paste its token.\n'));
  const telegram = await promptUntilValid(
    {
      name: 'botToken',
      message: 'Telegram bot token:',
      validateShape: (value) =>
        /^\d+:/.test(value) ? true : 'A BotFather token looks like 123456789:AA…',
    },
    checkTelegramToken,
  );
  if (telegram === undefined) return undefined;

  const botUsername = String(telegram.result.info?.['username'] ?? '');

  // ---- chat id -------------------------------------------------------------
  console.log(
    chalk.yellow(
      `\n  Now open Telegram, message @${botUsername}, and send it anything.\n` +
        '  Waiting for your message (2 minutes)...\n',
    ),
  );
  const spinner = ora('Listening...').start();
  const captured = await captureChatId(telegram.value);
  if (captured.ok && captured.chatId !== undefined) {
    spinner.succeed(chalk.green(captured.detail));
  } else {
    spinner.fail(chalk.red(captured.detail));
  }

  let allowedChatIds: number[] = captured.chatId === undefined ? [] : [captured.chatId];
  if (captured.chatId === undefined) {
    const { manual } = await inquirer.prompt<{ manual: string }>([
      {
        type: 'input',
        name: 'manual',
        message: 'Enter your chat ID manually (or leave blank to add it later):',
        validate: (value: string) =>
          value.trim() === '' || Number.isInteger(Number(value.trim()))
            ? true
            : 'A chat ID is a whole number.',
      },
    ]);
    if (manual.trim() !== '') allowedChatIds = [Number(manual.trim())];
  }

  if (allowedChatIds.some((id) => id < 0)) {
    console.log(
      chalk.yellow(
        '\n  ⚠ That is a group chat. EVERY member of it will be able to run\n' +
          '    commands on this server. Use a direct message unless you mean that.\n',
      ),
    );
  }

  // ---- write ---------------------------------------------------------------
  const config = {
    workspace_root: resolvedWorkspace,
    telegram: { bot_token: telegram.value, allowed_chat_ids: allowedChatIds },
    anthropic: { api_key: anthropic.value, model: DEFAULT_MODEL },
    hitl: {
      require_for: ['production', 'env', 'delete', 'migrate', 'push'],
      timeout_seconds: 300,
    },
    self_heal: { enabled: true, max_retries: 3, context_lines: 80 },
    daemon: { log_level: 'info', log_retention_days: 7 },
  };

  const configPath = path.join(cwd, CONFIG_FILENAME);
  writeConfig(configPath, config);
  ensureGitignored(cwd);

  return { configPath, config, ...(botUsername === '' ? {} : { botUsername }) };
}

/** Write the config with owner-only permissions — it holds two live secrets. */
export function writeConfig(configPath: string, config: unknown): void {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf-8' });
  try {
    // No-op on Windows, meaningful everywhere else.
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Non-fatal: a config that exists beats one that failed on a permissions quirk.
  }
}

/** Keep the config and runtime state out of git. Never rewrites existing rules. */
export function ensureGitignored(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const needed = [CONFIG_FILENAME, '.vigyl/'];

  let existing = '';
  if (fs.existsSync(gitignorePath)) existing = fs.readFileSync(gitignorePath, 'utf-8');

  const missing = needed.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length === 0) return;

  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(gitignorePath, `${prefix}\n# Vigyl — contains live credentials\n${missing.join('\n')}\n`);
}
