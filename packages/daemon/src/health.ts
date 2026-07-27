/**
 * Background health monitoring.
 *
 * The first thing in Vigyl that speaks without being spoken to, which changes
 * what "correct" means:
 *
 *   - Opt-in per chat. Nobody gets unsolicited messages because someone else
 *     turned monitoring on.
 *   - De-duplicated. A disk that sits at 90% full is one problem, not one
 *     problem every five minutes. Each alert has a cooldown, and a metric that
 *     recovers resets so the NEXT breach is reported immediately rather than
 *     being swallowed by a cooldown started an hour ago.
 *   - Stoppable. The interval is cleared in stop(). An un-cleared timer keeps
 *     the libuv loop alive and the daemon never exits — exactly the failure we
 *     hit with Telegram polling on Day 9.
 *
 * os.loadavg() is deliberately not used: it returns [0,0,0] on Windows, so it
 * would silently report a permanently idle machine there.
 */
import * as fs from 'fs';
import * as os from 'os';
import { logger } from './logger';

export type MetricId = 'cpu' | 'memory' | 'disk';

export interface HealthThresholds {
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  cpuPercent: 90,
  memoryPercent: 90,
  diskPercent: 85,
};

export interface HealthMetrics {
  cpuPercent: number;
  memoryPercent: number;
  /** Undefined when the filesystem could not be queried. */
  diskPercent?: number;
  at: number;
}

export interface HealthAlert {
  metric: MetricId;
  value: number;
  threshold: number;
  message: string;
}

/** Sample CPU busy-time across all cores over `windowMs`. */
export async function sampleCpuPercent(windowMs = 250): Promise<number> {
  const snapshot = (): { idle: number; total: number } => {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
      for (const value of Object.values(cpu.times)) total += value;
      idle += cpu.times.idle;
    }
    return { idle, total };
  };

  const first = snapshot();
  await new Promise((resolve) => setTimeout(resolve, Math.max(50, windowMs)));
  const second = snapshot();

  const idleDelta = second.idle - first.idle;
  const totalDelta = second.total - first.total;
  if (totalDelta <= 0) return 0;

  return clampPercent((1 - idleDelta / totalDelta) * 100);
}

export function memoryUsagePercent(): number {
  const total = os.totalmem();
  if (total <= 0) return 0;
  return clampPercent((1 - os.freemem() / total) * 100);
}

/** Disk usage for the filesystem holding `target`, or undefined if unavailable. */
export function diskUsagePercent(target: string): number | undefined {
  try {
    const stats = fs.statfsSync(target);
    const total = stats.blocks * stats.bsize;
    if (total <= 0) return undefined;
    const available = stats.bavail * stats.bsize;
    return clampPercent((1 - available / total) * 100);
  } catch (err) {
    logger.debug('Could not read disk usage', {
      target,
      reason: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

export async function collectMetrics(workspaceRoot: string): Promise<HealthMetrics> {
  const [cpuPercent] = await Promise.all([sampleCpuPercent()]);
  const disk = diskUsagePercent(workspaceRoot);
  return {
    cpuPercent,
    memoryPercent: memoryUsagePercent(),
    ...(disk === undefined ? {} : { diskPercent: disk }),
    at: Date.now(),
  };
}

/** Compare metrics against thresholds. Pure, so the policy is testable. */
export function evaluate(
  metrics: HealthMetrics,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  if (metrics.cpuPercent > thresholds.cpuPercent) {
    alerts.push({
      metric: 'cpu',
      value: metrics.cpuPercent,
      threshold: thresholds.cpuPercent,
      message: `CPU at ${metrics.cpuPercent}% (threshold ${thresholds.cpuPercent}%)`,
    });
  }
  if (metrics.memoryPercent > thresholds.memoryPercent) {
    alerts.push({
      metric: 'memory',
      value: metrics.memoryPercent,
      threshold: thresholds.memoryPercent,
      message: `Memory at ${metrics.memoryPercent}% (threshold ${thresholds.memoryPercent}%)`,
    });
  }
  if (metrics.diskPercent !== undefined && metrics.diskPercent > thresholds.diskPercent) {
    alerts.push({
      metric: 'disk',
      value: metrics.diskPercent,
      threshold: thresholds.diskPercent,
      message: `Disk at ${metrics.diskPercent}% (threshold ${thresholds.diskPercent}%)`,
    });
  }

  return alerts;
}

/**
 * Decides which alerts are worth sending.
 *
 * Two rules working together:
 *   - a firing metric is re-sent only after the cooldown elapses
 *   - a metric that drops back below its threshold is CLEARED, so the next
 *     breach reports immediately instead of waiting out a cooldown that
 *     started during the previous incident
 *
 * Without the second rule, a machine that flaps either spams or goes quiet
 * for an hour after recovering — and "goes quiet" is the dangerous one.
 */
export class AlertThrottle {
  private readonly lastSent = new Map<MetricId, number>();
  private cooldownMs: number;

  constructor(cooldownSeconds: number) {
    this.cooldownMs = Math.max(0, cooldownSeconds) * 1_000;
  }

  setCooldown(cooldownSeconds: number): void {
    this.cooldownMs = Math.max(0, cooldownSeconds) * 1_000;
  }

  /** Filter alerts to those due, and clear any metric no longer firing. */
  select(alerts: readonly HealthAlert[], now: number = Date.now()): HealthAlert[] {
    const firing = new Set(alerts.map((alert) => alert.metric));

    for (const metric of [...this.lastSent.keys()]) {
      if (!firing.has(metric)) this.lastSent.delete(metric);
    }

    const due: HealthAlert[] = [];
    for (const alert of alerts) {
      const previous = this.lastSent.get(alert.metric);
      if (previous !== undefined && now - previous < this.cooldownMs) continue;
      this.lastSent.set(alert.metric, now);
      due.push(alert);
    }
    return due;
  }

  /** Metrics currently considered "already reported". */
  get suppressed(): MetricId[] {
    return [...this.lastSent.keys()];
  }

  reset(): void {
    this.lastSent.clear();
  }
}

export type AlertNotifier = (chatIds: readonly number[], alerts: readonly HealthAlert[]) => void;

export interface MonitorOptions {
  workspaceRoot: string;
  intervalSeconds: number;
  cooldownSeconds: number;
  thresholds: HealthThresholds;
  notify: AlertNotifier;
}

export class HealthMonitor {
  private readonly options: MonitorOptions;
  private readonly throttle: AlertThrottle;
  private readonly subscribers = new Set<number>();
  private timer: NodeJS.Timeout | undefined;
  private checking = false;

  constructor(options: MonitorOptions) {
    this.options = options;
    this.throttle = new AlertThrottle(options.cooldownSeconds);
  }

  get isRunning(): boolean {
    return this.timer !== undefined;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Opt a chat in. Returns false if it was already subscribed. */
  subscribe(chatId: number): boolean {
    if (this.subscribers.has(chatId)) return false;
    this.subscribers.add(chatId);
    logger.info('Health monitoring enabled for a chat', { chatId });
    return true;
  }

  /** Opt a chat out. Returns false if it was not subscribed. */
  unsubscribe(chatId: number): boolean {
    const removed = this.subscribers.delete(chatId);
    if (removed) logger.info('Health monitoring disabled for a chat', { chatId });
    return removed;
  }

  isSubscribed(chatId: number): boolean {
    return this.subscribers.has(chatId);
  }

  start(): void {
    if (this.timer !== undefined) return;
    const intervalMs = Math.max(1_000, this.options.intervalSeconds * 1_000);

    this.timer = setInterval(() => {
      void this.runCheck();
    }, intervalMs);

    logger.info('Health monitor started', {
      intervalSeconds: this.options.intervalSeconds,
      cooldownSeconds: this.options.cooldownSeconds,
    });
  }

  /**
   * Stop the timer.
   *
   * Explicit, and called from daemon.stop(). A surviving interval keeps the
   * event loop alive and the process never exits.
   */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info('Health monitor stopped');
    }
    this.throttle.reset();
    this.subscribers.clear();
  }

  /** Run one check now. Returns the alerts that were actually sent. */
  async runCheck(): Promise<HealthAlert[]> {
    // Skip rather than queue: a slow check must not stack up behind itself.
    if (this.checking) return [];
    this.checking = true;

    try {
      const metrics = await collectMetrics(this.options.workspaceRoot);
      const breaches = evaluate(metrics, this.options.thresholds);
      const due = this.throttle.select(breaches);

      if (due.length > 0 && this.subscribers.size > 0) {
        logger.warn('Health thresholds breached', {
          alerts: due.map((alert) => alert.message),
          subscribers: this.subscribers.size,
        });
        this.options.notify([...this.subscribers], due);
      }
      return due;
    } catch (err) {
      logger.warn('Health check failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return [];
    } finally {
      this.checking = false;
    }
  }

  /** Current readings, for /monitor status. */
  async snapshot(): Promise<{ metrics: HealthMetrics; alerts: HealthAlert[] }> {
    const metrics = await collectMetrics(this.options.workspaceRoot);
    return { metrics, alerts: evaluate(metrics, this.options.thresholds) };
  }
}
