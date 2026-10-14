/**
 * Live benchmark: how good is a local model at naming a build failure the
 * regex rules could not, and how long does it take on this CPU?
 *
 * Run with a downloaded model:
 *   node packages/slm/dist/bench/run.js llama3.2-1b-q4 phi3-mini-4k-q4
 *
 * Not a test. Needs real models and real time, so it lives outside the suite.
 */
import { performance } from 'node:perf_hooks';

import { SLMClassifier, fastClassify } from '../classifier';
import { getModelPath, resolveModel } from '../downloader';
import { CORPUS, MODEL_CASES, RULE_CASES, type BenchCase } from './corpus';

const NL = String.fromCharCode(10);

interface CaseResult {
  readonly name: string;
  readonly expected: string;
  readonly got: string;
  readonly correct: boolean;
  readonly confidence: number;
  readonly source: string;
  readonly latencyMs: number;
  readonly summary: string;
}

export interface ModelReport {
  readonly model: string;
  readonly sizeBytes: number;
  readonly loadMs: number;
  readonly results: readonly CaseResult[];
  readonly accuracy: number;
  readonly medianLatencyMs: number;
  readonly p90LatencyMs: number;
  readonly meanLatencyMs: number;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? 0;
}

async function benchmarkModel(key: string, cases: readonly BenchCase[]): Promise<ModelReport> {
  const spec = resolveModel(key);
  const path = await getModelPath(key);
  if (!path) throw new Error(`${key} is not downloaded. Run: vigyl slm download --model ${key}`);

  process.stdout.write(`${NL}Loading ${spec.label}...${NL}`);
  const classifier = new SLMClassifier({ modelPath: path, timeoutMs: 120_000 });

  const loadStart = performance.now();
  await classifier.init();
  const loadMs = Math.round(performance.now() - loadStart);
  process.stdout.write(`  loaded in ${(loadMs / 1000).toFixed(1)}s, context ${classifier.loadedContextSize}${NL}${NL}`);

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const started = performance.now();
    const result = await classifier.classify(testCase.log);
    const latencyMs = Math.round(performance.now() - started);
    const correct = result.errorType === testCase.expect;

    results.push({
      name: testCase.name,
      expected: testCase.expect,
      got: result.errorType,
      correct,
      confidence: result.confidence,
      source: result.source,
      latencyMs,
      summary: result.summary,
    });

    const mark = correct ? 'ok  ' : 'MISS';
    const detail = correct ? result.errorType : `${result.errorType} (wanted ${testCase.expect})`;
    process.stdout.write(
      `  ${mark} ${String(latencyMs).padStart(6)}ms  ${testCase.name.padEnd(46)} ${detail}${NL}`,
    );
  }

  await classifier.dispose();

  const latencies = results.map((r) => r.latencyMs);
  const correct = results.filter((r) => r.correct).length;

  return {
    model: key,
    sizeBytes: spec.bytes,
    loadMs,
    results,
    accuracy: results.length === 0 ? 0 : correct / results.length,
    medianLatencyMs: percentile(latencies, 0.5),
    p90LatencyMs: percentile(latencies, 0.9),
    meanLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)),
  };
}

/** The fast path, measured on the cases it is supposed to answer. */
function benchmarkRules(): { accuracy: number; meanMicros: number } {
  let correct = 0;
  const times: number[] = [];

  for (const testCase of RULE_CASES) {
    const started = performance.now();
    const result = fastClassify(testCase.log);
    times.push((performance.now() - started) * 1000);
    if (result?.errorType === testCase.expect) correct += 1;
  }

  return {
    accuracy: correct / RULE_CASES.length,
    meanMicros: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
  };
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const models = requested.length > 0 ? requested : ['llama3.2-1b-q4', 'phi3-mini-4k-q4'];

  process.stdout.write(`Corpus: ${CORPUS.length} cases ` +
    `(${RULE_CASES.length} answered by rules, ${MODEL_CASES.length} needing the model)${NL}`);

  const rules = benchmarkRules();
  process.stdout.write(
    `${NL}Fast path: ${(rules.accuracy * 100).toFixed(0)}% on its ${RULE_CASES.length} cases, ` +
      `mean ${rules.meanMicros}µs, no model${NL}`,
  );

  const reports: ModelReport[] = [];
  for (const model of models) {
    try {
      reports.push(await benchmarkModel(model, MODEL_CASES));
    } catch (error) {
      process.stdout.write(`${NL}Skipping ${model}: ${(error as Error).message}${NL}`);
    }
  }

  process.stdout.write(`${NL}${'='.repeat(78)}${NL}Summary — ${MODEL_CASES.length} cases the rules could not name${NL}${NL}`);
  process.stdout.write(
    `  ${'model'.padEnd(20)} ${'size'.padEnd(8)} ${'load'.padEnd(8)} ` +
      `${'accuracy'.padEnd(10)} ${'median'.padEnd(10)} ${'p90'.padEnd(10)} mean${NL}`,
  );
  for (const report of reports) {
    process.stdout.write(
      `  ${report.model.padEnd(20)} ` +
        `${(report.sizeBytes / 1e9).toFixed(1).padEnd(7)}G ` +
        `${(report.loadMs / 1000).toFixed(1).padEnd(7)}s ` +
        `${((report.accuracy * 100).toFixed(0) + '%').padEnd(10)} ` +
        `${(report.medianLatencyMs + 'ms').padEnd(10)} ` +
        `${(report.p90LatencyMs + 'ms').padEnd(10)} ` +
        `${report.meanLatencyMs}ms${NL}`,
    );
  }

  process.stdout.write(`${NL}Misses:${NL}`);
  for (const report of reports) {
    for (const result of report.results.filter((r) => !r.correct)) {
      process.stdout.write(
        `  ${report.model}: ${result.name}${NL}` +
          `    wanted ${result.expected}, got ${result.got} ` +
          `(confidence ${result.confidence.toFixed(2)}, via ${result.source})${NL}` +
          `    "${result.summary}"${NL}`,
      );
    }
  }

  process.stdout.write(`${NL}${JSON.stringify({ rules, reports: reports.map((r) => ({
    model: r.model,
    loadMs: r.loadMs,
    accuracy: r.accuracy,
    medianLatencyMs: r.medianLatencyMs,
    p90LatencyMs: r.p90LatencyMs,
    meanLatencyMs: r.meanLatencyMs,
  })) })}${NL}`);
}

main().catch((error) => {
  process.stderr.write(String(error) + NL);
  process.exit(1);
});
