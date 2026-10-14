/**
 * Foreground daemon process.
 *
 * `vigyl start` re-executes the CLI with `run` in a detached child, so this is
 * the single place the daemon is actually constructed — foreground and
 * background differ only in who owns the terminal.
 */
import chalk from 'chalk';
import {
  ConfigError,
  TelegramInterface,
  VigylDaemon,
  VigylWebSocketServer,
  loadConfig,
  logger,
} from '@vigylx/daemon';
import { removePidFile, writePidRecord } from './service';

export async function runForeground(cwd: string = process.cwd()): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(chalk.red(`\n${err instanceof ConfigError ? err.message : String(err)}\n`));
    return 1;
  }

  const daemon = new VigylDaemon(config);
  const bot = new TelegramInterface(config, daemon, (reason) => {
    // Telegram is the only interface in Month 1. Without it this process is a
    // no-op holding a pid file, so exit loudly and let the operator (or a
    // process supervisor) decide whether to restart.
    const nl = String.fromCharCode(10);
    console.error(chalk.red(nl + '✗ Telegram polling stopped: ' + reason));
    console.error(chalk.gray('  The daemon cannot be reached. Exiting.' + nl));
    removePidFile(cwd);
    process.exit(1);
  });

  await daemon.start();
  await bot.start();

  // The WebSocket interface runs beside Telegram, not instead of it. It is off
  // unless configured, and a failure to bind is not fatal: the daemon is still
  // reachable from Telegram, and killing a working interface because an
  // optional one could not start would be the wrong trade.
  let ws: VigylWebSocketServer | undefined;
  if (config.ws.enabled) {
    ws = new VigylWebSocketServer(daemon, {
      port: config.ws.port,
      host: config.ws.host,
      workspaceRoot: config.workspace_root,
    });
    try {
      await ws.start();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error('WebSocket server could not start', { reason });
      console.error(chalk.yellow(`\n⚠ WebSocket server did not start: ${reason}`));
      console.error(chalk.gray('  Telegram still works.\n'));
      ws = undefined;
    }
  }

  // The detached child writes its own record: `vigyl start` writes one for the
  // child pid it spawned, but in foreground mode nobody else knows we exist.
  writePidRecord(
    {
      pid: process.pid,
      startedAt: Date.now(),
      workspaceRoot: config.workspace_root,
      version: '0.1.0',
    },
    cwd,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    void (async () => {
      try {
        await bot.stop();
        if (ws) await ws.stop();
        await daemon.stop();
      } catch (err) {
        logger.warn('Error during shutdown', {
          reason: err instanceof Error ? err.message : String(err),
        });
      } finally {
        removePidFile(cwd);
        // node-pty keeps a libuv handle open after its child exits, so the
        // event loop will not drain on its own. Exit explicitly.
        process.exit(0);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { reason: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });

  console.log(chalk.green('\n✓ Vigyl is running'));
  console.log(chalk.gray(`  Workspace: ${config.workspace_root}`));
  console.log(chalk.gray('  Message your Telegram bot to control this server.'));
  if (ws) {
    console.log(
      chalk.gray(`  WebSocket: ws://${config.ws.host}:${config.ws.port} (${ws.deviceCount} device(s))`),
    );
    if (ws.deviceCount === 0) {
      console.log(chalk.yellow('  No authorized devices yet — run: vigyl device add'));
    }
  }
  console.log(chalk.gray('  Ctrl-C to stop.\n'));

  // Resolves only on shutdown; the signal handlers call process.exit.
  return new Promise<number>(() => {
    /* intentionally never resolves */
  });
}
