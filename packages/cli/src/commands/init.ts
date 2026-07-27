import * as fs from 'fs';
import * as path from 'path';
import boxen from 'boxen';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { CONFIG_FILENAME, runHeadless, runWizard } from '../config-wizard';

export interface InitOptions {
  /** Read credentials from the environment instead of prompting. */
  nonInteractive?: boolean;
}

export async function init(
  options: InitOptions = {},
  cwd: string = process.cwd(),
): Promise<number> {
  console.log(
    boxen(
      `${chalk.white.bold('Vigyl setup')}\n${chalk.gray('Your infrastructure, in your pocket.')}`,
      { padding: 1, borderColor: 'cyan', borderStyle: 'round' },
    ),
  );

  // A wizard needs somewhere to type. Fail with an instruction rather than
  // an inquirer stack trace when there is no terminal attached.
  const headless = options.nonInteractive === true || process.stdin.isTTY !== true;

  const configPath = path.join(cwd, CONFIG_FILENAME);
  if (fs.existsSync(configPath) && !headless) {
    const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `${CONFIG_FILENAME} already exists. Replace it?`,
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log(chalk.gray('\nLeft the existing config alone.\n'));
      return 0;
    }
  }

  if (headless && options.nonInteractive !== true) {
    console.log(
      chalk.yellow('No interactive terminal detected - using environment variables.'),
    );
  }
  const result = headless ? await runHeadless(cwd) : await runWizard(cwd);
  if (result === undefined) {
    console.log(
      chalk.yellow('\nSetup cancelled. Nothing was written.\n') +
        chalk.gray('Run `vigyl init` again when you have working credentials.\n'),
    );
    return 1;
  }

  const chatIds = (result.config['telegram'] as { allowed_chat_ids: number[] }).allowed_chat_ids;
  const lines = [
    chalk.green.bold('✓ Vigyl is configured'),
    '',
    `${chalk.white('Config:')}    ${chalk.gray(result.configPath)}`,
    `${chalk.white('Workspace:')} ${chalk.gray(String(result.config['workspace_root']))}`,
  ];
  if (result.botUsername !== undefined) {
    lines.push(`${chalk.white('Bot:')}       ${chalk.gray(`@${result.botUsername}`)}`);
  }
  lines.push(
    chatIds.length > 0
      ? `${chalk.white('Authorized:')} ${chalk.gray(chatIds.join(', '))}`
      : chalk.yellow('No chat authorized yet — add one before the bot will answer.'),
    '',
    chalk.white('Start it:'),
    chalk.cyan('  vigyl start'),
  );

  console.log(boxen(lines.join('\n'), { padding: 1, borderColor: 'green', borderStyle: 'round' }));

  if (chatIds.length === 0) {
    console.log(
      chalk.yellow(
        'Message the bot once it is running — it will reply with the chat ID to add.\n',
      ),
    );
  }
  return 0;
}
