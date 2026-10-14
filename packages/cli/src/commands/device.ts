/**
 * `vigyl device` — the secrets an app uses to connect over WebSocket.
 *
 * A device secret is equivalent to a shell on the server, so these commands
 * treat it that way: the secret is printed once and never again, the file is
 * owner-readable only, and revoking says plainly that an open connection
 * survives until it reconnects.
 */
import chalk from 'chalk';
import { ConfigError, addDevice, devicesPath, listDevices, loadConfig, revokeDevice } from '@vigylx/daemon';

/** The workspace the device file belongs to, or a message saying why not. */
function workspace(): { root: string } | { error: string } {
  try {
    const config = loadConfig();
    return { root: config.workspace_root };
  } catch (err) {
    return {
      error: err instanceof ConfigError ? err.message : String(err),
    };
  }
}

export async function deviceAdd(label?: string): Promise<number> {
  const found = workspace();
  if ('error' in found) {
    console.error(chalk.red(`✗ ${found.error}`));
    return 1;
  }

  let device;
  try {
    device = await addDevice(found.root, label);
  } catch (err) {
    console.error(chalk.red(`✗ Could not write the device file: ${(err as Error).message}`));
    return 1;
  }

  const nl = String.fromCharCode(10);
  console.log(chalk.green(nl + '✓ Device added'));
  if (label) console.log(chalk.gray(`  Label:     ${label}`));
  console.log(`  Device ID: ${chalk.white(device.deviceId)}`);
  console.log(`  Secret:    ${chalk.white(device.secret)}`);
  console.log('');
  // Said plainly, because the secret is not recoverable: it is only on disk in
  // the file this command just wrote, and that file is the daemon's copy.
  console.log(chalk.yellow('  Copy the secret now — it is not shown again.'));
  console.log(chalk.gray('  Anyone holding it can run commands on this machine.'));
  console.log(chalk.gray(`  Stored in ${devicesPath(found.root)}`));
  console.log('');
  return 0;
}

export function deviceList(): number {
  const found = workspace();
  if ('error' in found) {
    console.error(chalk.red(`✗ ${found.error}`));
    return 1;
  }

  const devices = listDevices(found.root);
  if (devices.length === 0) {
    console.log(chalk.gray('No authorized devices.'));
    console.log(chalk.gray('  Run: vigyl device add "my phone"'));
    return 0;
  }

  console.log(chalk.white(`${devices.length} authorized device(s)`));
  console.log(chalk.gray(`  ${devicesPath(found.root)}`));
  console.log('');
  for (const device of devices) {
    // Secrets are never printed here, only ids.
    console.log(`  ${chalk.white(device.deviceId)}  ${chalk.gray(device.label ?? '')}`);
  }
  console.log('');
  return 0;
}

export async function deviceRevoke(deviceId: string): Promise<number> {
  const found = workspace();
  if ('error' in found) {
    console.error(chalk.red(`✗ ${found.error}`));
    return 1;
  }

  const id = deviceId?.trim() ?? '';
  if (id === '') {
    console.error(chalk.red('✗ Which device? Pass its id — see: vigyl device list'));
    return 1;
  }

  let removed: boolean;
  try {
    removed = await revokeDevice(found.root, id);
  } catch (err) {
    console.error(chalk.red(`✗ Could not write the device file: ${(err as Error).message}`));
    return 1;
  }

  if (!removed) {
    console.error(chalk.red(`✗ No device with id ${id}`));
    console.error(chalk.gray('  See: vigyl device list'));
    return 1;
  }

  console.log(chalk.green(`✓ Revoked ${id}`));
  console.log(chalk.gray('  A device already connected stays connected until it reconnects.'));
  console.log(chalk.gray('  Restart the daemon to drop it now.'));
  return 0;
}
