/**
 * `@vigylx/slm` — Vigyl's local inference service.
 *
 * Month 2, week 1. Day 1 ships the model fetcher only; the classifier and the
 * HTTP service land on days 3–5, and nothing in the daemon depends on this
 * package yet.
 */
export {
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
  checkSpace,
  downloadModel,
  formatBytes,
  getModelPath,
  modelPath,
  modelsDir,
  resolveModel,
} from './downloader';
export type { DownloadOptions, DownloadProgress, ModelSpec, SpaceCheck } from './downloader';

export { createTerminalProgress, renderDownloadBar } from './progress';

export {
  CLASSIFICATION_SCHEMA,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_MAX_LINES,
  ERROR_TYPES,
  SLMClassifier,
  buildPrompt,
  fastClassify,
  trimForModel,
} from './classifier';
export type {
  ClassificationResult,
  ClassificationSource,
  ClassifierOptions,
  ErrorType,
  PromptSession,
} from './classifier';
