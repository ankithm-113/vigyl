/**
 * `vigyl doctor` — everything that must be true before the daemon can work,
 * checked in one pass with a readable verdict.
 *
 * Built to be run BEFORE the first real end-to-end session. Each check is
 * independent and none of them throw: a broken environment should produce a
 * list of problems, not a stack trace at the first one.
 *
 * The LLM (OpenAI or Anthropic) and Telegram checks hit the live services. The
 * structured-output check costs a few hundred tokens; everything else is free.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import {
  ConfigError,
  checkCommandParsing,
  checkLlmKey,
  resolveLlm,
  checkTelegramToken,
  diskUsagePercent,
  loadConfig,
  ptyStatus,
  resolveShell,
  type CheckResult,
  type VigylConfig,
} from '@vigyl/daemon';
import { serviceState } from '../service';

export type Verdict = 'pass' | 'warn' | 'fail';

export interface CheckOutcome {
  status: Verdict;
  detail: string;
}

export interface DoctorOptions {
  /** Skip the checks that cost tokens or need the network. */
  offline?: boolean;
}

const MIN_NODE_MAJOR = 20;

const ICON: Readonly<Record<Verdict, string>> = {
  pass: chalk.green('✓'),
  warn: chalk.yellow('!'),
  fail: chalk.red('✗'),
};

function nodeVersion(): CheckOutcome {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= MIN_NODE_MAJOR) {
    return { status: 'pass', detail: `Node ${process.versions.node}` };
  }
  return {
    status: 'fail',
    detail: `Node ${process.versions.node} — Vigyl needs ${MIN_NODE_MAJOR} or newer.`,
  };
}

function shellAvailable(): CheckOutcome {
  try {
    const shell = resolveShell();
    return { status: 'pass', detail: `Commands will run through ${shell.label}` };
  } catch (err) {
    return { status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

function ptyAvailable(): CheckOutcome {
  // Asked of the daemon package, which is the one that depends on node-pty.
  const result = ptyStatus();
  return result.ok
    ? { status: 'pass', detail: 'node-pty is loadable' }
    : { status: 'fail', detail: `node-pty could not be loaded: ${result.reason}` };
}

function workspaceWritable(config: VigylConfig): CheckOutcome {
  const probe = path.join(config.workspace_root, `.vigyl-write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    return { status: 'pass', detail: config.workspace_root };
  } catch (err) {
    return {
      status: 'fail',
      detail: `Cannot write to ${config.workspace_root}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function diskHeadroom(config: VigylConfig): CheckOutcome {
  const used = diskUsagePercent(config.workspace_root);
  if (used === undefined) return { status: 'warn', detail: 'Could not read disk usage.' };
  if (used >= 95) return { status: 'fail', detail: `Disk ${used}% full — logs will not fit.` };
  if (used >= 85) return { status: 'warn', detail: `Disk ${used}% full.` };
  return { status: 'pass', detail: `Disk ${used}% used` };
}

function chatsAuthorized(config: VigylConfig): CheckOutcome {
  const ids = config.telegram.allowed_chat_ids;
  if (ids.length === 0) {
    return {
      status: 'fail',
      detail: 'No authorized chats — the bot will refuse everyone. Run `vigyl init`.',
    };
  }
  const groups = ids.filter((id) => id < 0);
  if (groups.length > 0) {
    return {
      status: 'warn',
      detail: `${ids.length} authorized, of which ${groups.length} are GROUP chats — every member of those groups can run commands.`,
    };
  }
  return { status: 'pass', detail: `${ids.length} chat(s) authorized` };
}

function daemonState(): CheckOutcome {
  const state = serviceState();
  if (state.state === 'running') {
    return { status: 'pass', detail: `Running (PID ${state.record.pid})` };
  }
  if (state.state === 'stale') {
    return { status: 'warn', detail: 'A stale PID file is present; `vigyl stop` will clear it.' };
  }
  return { status: 'warn', detail: 'Not running — start it with `vigyl start`.' };
}

/** Preflight reports ok/detail; doctor grades pass/warn/fail. */
function fromCheck(result: CheckResult): CheckOutcome {
  return { status: result.ok ? 'pass' : 'fail', detail: result.detail };
}

function line(name: string, outcome: CheckOutcome): string {
  const colour = outcome.status === 'pass' ? chalk.gray : outcome.status === 'warn' ? chalk.yellow : chalk.red;
  return `  ${ICON[outcome.status]} ${name.padEnd(26)} ${colour(outcome.detail)}`;
}

export async function doctor(options: DoctorOptions = {}): Promise<number> {
  console.log(chalk.white.bold('\nVigyl doctor\n'));

  const results: Array<{ name: string; outcome: CheckOutcome }> = [];
  const add = (name: string, outcome: CheckOutcome): void => {
    results.push({ name, outcome });
    console.log(line(name, outcome));
  };

  // --- environment, no config needed ---------------------------------------
  add('Node version', nodeVersion());
  add('Shell', shellAvailable());
  add('PTY support', ptyAvailable());
  add('Platform', { status: 'pass', detail: `${os.platform()} ${os.arch()}` });

  // --- config ---------------------------------------------------------------
  let config: VigylConfig | undefined;
  try {
    config = loadConfig();
    add('Config file', { status: 'pass', detail: 'Loaded and valid' });
  } catch (err) {
    const detail = err instanceof ConfigError ? err.message.split('\n')[0] ?? err.message : String(err);
    add('Config file', { status: 'fail', detail });
  }

  if (config !== undefined) {
    add('Workspace writable', workspaceWritable(config));
    add('Disk headroom', diskHeadroom(config));
    add('Authorized chats', chatsAuthorized(config));
    add('Daemon', daemonState());

    if (options.offline === true) {
      console.log(chalk.gray('\n  Skipping live credential checks (--offline).'));
    } else {
      const llm = resolveLlm(config);
      const label = llm.provider === 'openai' ? 'OpenAI key' : 'Anthropic key';
      add(label, fromCheck(await checkLlmKey(llm)));
      add('Telegram token', fromCheck(await checkTelegramToken(config.telegram.bot_token)));

      // The only check that proves structured outputs work end to end. Costs
      // a few hundred tokens on a small model, which is why it is called out.
      console.log(chalk.gray('  … testing command parsing (uses a few tokens)'));
      add(
        'Command parsing',
        fromCheck(
          await checkCommandParsing(llm, config.workspace_root),
        ),
      );
    }
  }

  // --- verdict --------------------------------------------------------------
  const failures = results.filter((r) => r.outcome.status === 'fail').length;
  const warnings = results.filter((r) => r.outcome.status === 'warn').length;

  console.log('');
  if (failures > 0) {
    console.log(chalk.red.bold(`  ${failures} problem(s) must be fixed before Vigyl will work.`));
    if (warnings > 0) console.log(chalk.yellow(`  ${warnings} warning(s).`));
    console.log('');
    return 1;
  }
  if (warnings > 0) {
    console.log(chalk.yellow.bold(`  Ready, with ${warnings} warning(s).`));
    console.log('');
    return 0;
  }
  console.log(chalk.green.bold('  Everything checks out. Vigyl is ready.'));
  console.log('');
  return 0;
}
