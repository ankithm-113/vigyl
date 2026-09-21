import chalk from 'chalk';
import { ConfigError, loadConfig, resolveLlm } from '@vigyl/daemon';
import { logFilePath, removePidFile, serviceState } from '../service';

function humanUptime(sinceMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function status(cwd: string = process.cwd()): number {
  const state = serviceState(cwd);

  if (state.state === 'stale') {
    removePidFile(cwd);
    console.log(chalk.red('✗ Vigyl is not running') + chalk.gray(' (removed a stale PID file)'));
    return 1;
  }

  if (state.state === 'stopped') {
    console.log(chalk.red('✗ Vigyl is not running'));
    console.log(chalk.gray('  Start it with `vigyl start`\n'));
    return 1;
  }

  console.log(chalk.green(`✓ Vigyl is running (PID ${state.record.pid})`));
  if (state.record.startedAt > 0) {
    console.log(chalk.gray(`  Uptime:    ${humanUptime(state.record.startedAt)}`));
  }
  if (state.record.workspaceRoot !== '') {
    console.log(chalk.gray(`  Workspace: ${state.record.workspaceRoot}`));
  }

  try {
    const config = loadConfig();
    console.log(chalk.gray(`  Model:     ${resolveLlm(config).model} (${config.provider})`));
    console.log(chalk.gray(`  Chats:     ${config.telegram.allowed_chat_ids.length} authorized`));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.log(chalk.yellow('  Config could not be read from this directory.'));
    }
  }

  console.log(chalk.gray(`  Logs:      ${logFilePath(cwd)}\n`));
  return 0;
}
