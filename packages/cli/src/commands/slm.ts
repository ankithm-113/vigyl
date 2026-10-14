import chalk from 'chalk';
import {
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
  checkSpace,
  createTerminalProgress,
  downloadModel,
  formatBytes,
  getModelPath,
  modelsDir,
  resolveModel,
} from '@vigylx/slm';

export interface SlmDownloadOptions {
  model?: string;
  force?: boolean;
}

/**
 * `vigyl slm download` — fetch a GGUF model into ~/.vigyl/models.
 *
 * Resumable: a download interrupted halfway continues from where it stopped,
 * which matters for a 2.2 GB file on a laptop connection.
 */
export async function slmDownload(options: SlmDownloadOptions = {}): Promise<number> {
  const key = options.model ?? DEFAULT_MODEL;

  let spec;
  try {
    spec = resolveModel(key);
  } catch (error) {
    console.error(chalk.red(`✗ ${(error as Error).message}`));
    return 1;
  }

  const existing = await getModelPath(key);
  if (existing && !options.force) {
    console.log(chalk.green(`✓ ${spec.label} is already downloaded`));
    console.log(chalk.gray(`  ${existing}`));
    console.log(chalk.gray('  Use --force to download it again.'));
    return 0;
  }

  const space = await checkSpace(key);
  if (!space.ok) {
    console.error(chalk.red(`✗ Not enough room for ${spec.label}`));
    console.error(
      chalk.gray(
        `  needs ${formatBytes(space.neededBytes)}, ` +
          `${formatBytes(space.freeBytes)} free on ${modelsDir()}`,
      ),
    );
    console.error('');
    console.error(chalk.white('  Either put models on another drive:'));
    console.error(chalk.gray('    setx VIGYL_MODELS_DIR D:\\vigyl-models'));
    console.error(chalk.white('  or pick a smaller model:'));
    console.error(chalk.gray('    vigyl slm download --model llama3.2-1b-q4'));
    return 1;
  }

  console.log(chalk.white(`Downloading ${spec.label} (${formatBytes(spec.bytes)})`));
  console.log(chalk.gray(`  from ${new URL(spec.url).host}`));
  console.log(chalk.gray(`  to   ${modelsDir()}`));
  console.log(chalk.gray(`  ${formatBytes(space.freeBytes)} free on that drive`));
  console.log('');

  const startedAt = Date.now();
  try {
    const file = await downloadModel(key, {
      force: options.force,
      onProgress: createTerminalProgress(),
    });
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    console.log('');
    console.log(chalk.green(`✓ Downloaded in ${seconds}s`));
    console.log(chalk.gray(`  ${file}`));
    return 0;
  } catch (error) {
    console.log('');
    console.error(chalk.red(`✗ ${(error as Error).message}`));
    return 1;
  }
}

/** `vigyl slm status` — which models are on disk, and where they live. */
export async function slmStatus(): Promise<number> {
  const dir = modelsDir();
  const space = await checkSpace(DEFAULT_MODEL, dir);
  console.log(chalk.white('Local models'));
  console.log(chalk.gray(`  ${dir}`));
  if (Number.isFinite(space.freeBytes)) {
    console.log(chalk.gray(`  ${formatBytes(space.freeBytes)} free`));
  }
  if (!process.env.VIGYL_MODELS_DIR) {
    console.log(chalk.gray('  (set VIGYL_MODELS_DIR to keep models on another drive)'));
  }
  console.log('');

  let anyPresent = false;
  for (const spec of Object.values(SUPPORTED_MODELS)) {
    const present = await getModelPath(spec.key);
    anyPresent = anyPresent || present !== null;
    const mark = present ? chalk.green('✓') : chalk.gray('·');
    const size = chalk.gray(`(${formatBytes(spec.bytes)})`);
    const state = present ? chalk.green('downloaded') : chalk.gray('not downloaded');
    const isDefault = spec.key === DEFAULT_MODEL ? chalk.gray(' [default]') : '';
    console.log(`  ${mark} ${spec.key.padEnd(20)} ${size.padEnd(18)} ${state}${isDefault}`);
  }

  if (!anyPresent) {
    console.log('');
    console.log(chalk.gray('  Run: vigyl slm download'));
  }
  return 0;
}
