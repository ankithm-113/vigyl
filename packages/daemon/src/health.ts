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
import * as net from 'net';
import * as os from 'os';
import { logger } from './logger';

export type MetricId = 'cpu' | 'memory' | 'disk';

/**
 * Identity of an alert. Machine metrics are fixed; a service alert carries the
 * service's name so the cooldown and the recovery-clears rule apply per
 * service rather than to "services" as a lump.
 */
export type AlertId = MetricId | string;

/**
 * A service to check liveness of. Either an HTTP(S) url or a TCP host/port —
 * the two things you can check without assuming systemd, pm2 or Docker.
 */
export interface ServiceTarget {
  name: string;
  /** HTTP(S) endpoint. Any status under 500 counts as up. */
  url?: string;
  /** TCP port; `host` defaults to 127.0.0.1. */
  port?: number;
  host?: string;
}

export interface ServiceStatus {
  name: string;
  up: boolean;
  /** One line, safe to show: status code, or why the connection failed. */
  detail: string;
}

/** How long a single service probe may take before it counts as down. */
export const SERVICE_PROBE_TIMEOUT_MS = 5_000;

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
  metric: AlertId;
  /** Absent for service alerts, which are up/down rather than a reading. */
  value?: number;
  threshold?: number;
  message: string;
}

/** Alert id for a service, namespaced so it cannot collide with a metric. */
export function serviceAlertId(name: string): string {
  return `service:${name}`;
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

/**
 * Check one service. Never throws: a failed probe IS the result.
 *
 * HTTP: any response under 500 means something is listening and answering, so
 * a 404 counts as up — the check is "is the service alive", not "is this route
 * correct". 5xx means it is up but broken, which is worth an alert.
 */
export async function probeService(
  target: ServiceTarget,
  timeoutMs = SERVICE_PROBE_TIMEOUT_MS,
): Promise<ServiceStatus> {
  if (target.url !== undefined && target.url !== '') {
    try {
      const response = await fetch(target.url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.status >= 500
        ? { name: target.name, up: false, detail: `HTTP ${response.status}` }
        : { name: target.name, up: true, detail: `HTTP ${response.status}` };
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { name: target.name, up: false, detail: 'timed out' };
      }
      // fetch wraps the real failure: bare "fetch failed" in an alert tells
      // nobody anything, where ECONNREFUSED does.
      const cause =
        err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
      const reason = err instanceof Error ? err.message : String(err);
      const because = cause?.code ?? cause?.message;
      const detail = because === undefined ? reason : `${reason}: ${because}`;
      return { name: target.name, up: false, detail };
    }
  }

  if (target.port !== undefined) {
    const host = target.host === undefined || target.host === '' ? '127.0.0.1' : target.host;
    return await new Promise<ServiceStatus>((resolve) => {
      const socket = new net.Socket();
      const settle = (status: ServiceStatus): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(status);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => settle({ name: target.name, up: true, detail: `port ${target.port!} open` }));
      socket.once('timeout', () => settle({ name: target.name, up: false, detail: 'timed out' }));
      socket.once('error', (err: Error) => settle({ name: target.name, up: false, detail: err.message }));
      socket.connect(target.port!, host);
    });
  }

  return { name: target.name, up: false, detail: 'no url or port configured' };
}

export function probeServices(
  targets: readonly ServiceTarget[],
  timeoutMs = SERVICE_PROBE_TIMEOUT_MS,
): Promise<ServiceStatus[]> {
  return Promise.all(targets.map((target) => probeService(target, timeoutMs)));
}

/** One alert per service that is down. Pure, so the policy is testable. */
export function evaluateServices(statuses: readonly ServiceStatus[]): HealthAlert[] {
  return statuses
    .filter((status) => !status.up)
    .map((status) => ({
      metric: serviceAlertId(status.name),
      message: `Service ${status.name} is DOWN (${status.detail})`,
    }));
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
  private readonly lastSent = new Map<AlertId, number>();
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
  get suppressed(): AlertId[] {
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
  /** Services to check for liveness each tick. Empty by default. */
  services?: readonly ServiceTarget[];
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
      const services = this.options.services ?? [];
      // Probed every tick alongside the metrics: a service that is down is the
      // alert people actually want, and it is cheap to check.
      const statuses = services.length === 0 ? [] : await probeServices(services);
      const breaches = [...evaluate(metrics, this.options.thresholds), ...evaluateServices(statuses)];
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
