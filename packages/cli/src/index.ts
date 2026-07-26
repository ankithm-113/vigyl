#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { VERSION } from '@vigyl/daemon';

const program = new Command();

program
  .name('vigyl')
  .description('Vigyl — your infrastructure, in your pocket.')
  .version(VERSION);

/** Placeholder for commands whose implementation lands on a later day. */
function notYet(command: string, day: string): void {
  console.error(chalk.yellow(`\n  ${command} is not implemented yet (lands on ${day}).\n`));
  process.exitCode = 1;
}

program
  .command('init')
  .description('Interactive setup wizard: writes vigyl.config.json')
  .action(() => notYet('vigyl init', 'Day 9-10'));

program
  .command('start')
  .description('Start the Vigyl daemon and Telegram bot')
  .action(() => notYet('vigyl start', 'Day 11-12'));

program
  .command('stop')
  .description('Stop a running daemon')
  .action(() => notYet('vigyl stop', 'Day 11-12'));

program
  .command('status')
  .description('Check whether the daemon is running')
  .action(() => notYet('vigyl status', 'Day 11-12'));

program
  .command('logs')
  .description('Tail the daemon log')
  .option('-n, --tail <n>', 'number of lines', '50')
  .action(() => notYet('vigyl logs', 'Day 11-12'));

program.parse();
