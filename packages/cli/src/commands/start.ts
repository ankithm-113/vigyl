import chalk from 'chalk';
import ora from 'ora';
import { checkLlmKey, checkTelegramToken, resolveLlm, ConfigError, loadConfig } from '@vigylx/daemon';
import { isAlive, serviceState, spawnDetached, stdioLogPath, writePidRecord } from '../service';

export interface StartOptions {
  /** Run in this terminal instead of detaching. */
  foreground?: boolean;
  /** Skip the live credential checks. */
  skipChecks?: boolean;
}

export async function start(options: StartOptions = {}, cwd: string = process.cwd()): Promise<number> {
  const existing = serviceState(cwd);
  if (existing.state === 'running') {
    console.log(chalk.yellow(`Vigyl is already running (PID ${existing.record.pid}).`));
    console.log(chalk.gray('Use `vigyl stop` first, or `vigyl status` to inspect it.\n'));
    return 1;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(chalk.red(`\n${err instanceof ConfigError ? err.message : String(err)}\n`));
    return 1;
  }

  // Check credentials HERE, in the terminal, where the user can read the
  // failure. Once the process detaches, a bad key looks identical to a bot
  // that is simply not replying.
  if (options.skipChecks !== true) {
    const checks = [
      [`${config.provider} API key`, () => checkLlmKey(resolveLlm(config))],
      ['Telegram bot token', () => checkTelegramToken(config.telegram.bot_token)],
    ] as const;

    for (const [label, run] of checks) {
      const spinner = ora(`Checking ${label}...`).start();
      const result = await run();
      if (result.ok) {
        spinner.succeed(chalk.green(result.detail));
      } else {
        spinner.fail(chalk.red(`${label}: ${result.detail}`));
        console.error(chalk.gray('\nFix it, or re-run with --skip-checks to start anyway.\n'));
        return 1;
      }
    }

    if (config.telegram.allowed_chat_ids.length === 0) {
      console.log(
        chalk.yellow('\n⚠ No authorized chats. The bot will refuse everyone until you add one.\n'),
      );
    }
  }

  if (options.foreground === true) {
    const { runForeground } = await import('../run');
    return runForeground(cwd);
  }

  const spawned = spawnDetached(cwd);
  writePidRecord(
    {
      pid: spawned.pid,
      startedAt: Date.now(),
      workspaceRoot: config.workspace_root,
      version: '0.2.0',
    },
    cwd,
  );

  // Give it long enough to fall over. A bad Telegram token surfaces as a 401
  // roughly two seconds in, and reporting "running" just before the process
  // dies is worse than taking an extra moment to be sure.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  if (!isAlive(spawned.pid)) {
    console.error(chalk.red('\n✗ The daemon exited immediately after starting.'));
    console.error(chalk.gray(`  Check ${stdioLogPath(cwd)}\n`));
    return 1;
  }

  console.log(chalk.green(`\n✓ Vigyl is running in the background (PID ${spawned.pid})`));
  console.log(chalk.gray(`  Workspace: ${config.workspace_root}`));
  console.log(chalk.gray(`  Logs:      vigyl logs`));
  console.log(chalk.gray('  Message your Telegram bot to control this server.\n'));
  return 0;
}
