import chalk from 'chalk';
import ora from 'ora';
import { removePidFile, serviceState, terminate } from '../service';

export async function stop(cwd: string = process.cwd()): Promise<number> {
  const state = serviceState(cwd);

  if (state.state === 'stopped') {
    console.log(chalk.gray('Vigyl is not running.\n'));
    return 0;
  }

  if (state.state === 'stale') {
    // The pid file outlived the process — a crash, or a reboot.
    removePidFile(cwd);
    console.log(chalk.yellow(`Cleaned up a stale PID file (process ${state.record.pid} is gone).\n`));
    return 0;
  }

  const spinner = ora(`Stopping Vigyl (PID ${state.record.pid})...`).start();
  const stopped = await terminate(state.record.pid);
  removePidFile(cwd);

  if (stopped) {
    spinner.succeed(chalk.green('Vigyl stopped.'));
    return 0;
  }
  spinner.fail(chalk.red(`Could not stop PID ${state.record.pid}. Stop it manually.`));
  return 1;
}
