#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { VERSION, loadDotenv } from '@vigyl/daemon';
import { doctor } from './commands/doctor';
import { init } from './commands/init';
import { start } from './commands/start';
import { status } from './commands/status';
import { stop } from './commands/stop';
import { logFilePath, readLogTail } from './service';

// Before anything else: `vigyl init` needs credentials from .env, and it
// runs before any config file exists for loadConfig() to read.
loadDotenv();

const program = new Command();

program
  .name('vigyl')
  .description('Vigyl — your infrastructure, in your pocket.')
  .version(VERSION);

/** Commander does not await actions, so set the exit code rather than return it. */
function finish(code: number): void {
  process.exitCode = code;
}

program
  .command('init')
  .description('Interactive setup: validates your credentials, then writes vigyl.config.json')
  .option(
    '--non-interactive',
    'read ANTHROPIC_API_KEY and TELEGRAM_BOT_TOKEN from the environment instead of prompting',
  )
  .action(async (options: { nonInteractive?: boolean }) => {
    finish(await init(options));
  });

program
  .command('doctor')
  .description('Check everything Vigyl needs, including live credential checks')
  .option('--offline', 'skip the checks that need the network or cost tokens')
  .action(async (options: { offline?: boolean }) => {
    finish(await doctor(options));
  });

program
  .command('start')
  .description('Start the Vigyl daemon in the background')
  .option('-f, --foreground', 'run in this terminal instead of detaching')
  .option('--skip-checks', 'skip the live credential checks')
  .action(async (options: { foreground?: boolean; skipChecks?: boolean }) => {
    finish(await start(options));
  });

program
  .command('stop')
  .description('Stop the running daemon')
  .action(async () => {
    finish(await stop());
  });

program
  .command('status')
  .description('Show whether the daemon is running')
  .action(() => {
    finish(status());
  });

program
  .command('logs')
  .description('Show recent daemon log lines')
  .option('-n, --tail <lines>', 'how many lines to show', '50')
  .action((options: { tail: string }) => {
    const requested = Number.parseInt(options.tail, 10);
    const count = Number.isInteger(requested) && requested > 0 ? requested : 50;
    const lines = readLogTail(count);

    if (lines.length === 0) {
      console.log(chalk.gray(`No log entries yet (${logFilePath()}).`));
      return;
    }
    // Deliberately not `tail -f`: the build guide shells out to it, which does
    // not exist on Windows and would make `vigyl logs` platform-specific.
    for (const line of lines) console.log(line);
  });

program
  .command('run', { hidden: true })
  .description('Run the daemon in the foreground (used internally by `start`)')
  .action(async () => {
    const { runForeground } = await import('./run');
    finish(await runForeground());
  });

program.parse();
