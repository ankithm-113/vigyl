import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as net from 'node:net';
import { describe, it } from 'node:test';

import {
  AlertThrottle,
  DEFAULT_THRESHOLDS,
  HealthMonitor,
  collectMetrics,
  diskUsagePercent,
  evaluate,
  evaluateServices,
  memoryUsagePercent,
  probeService,
  sampleCpuPercent,
  type HealthAlert,
  type HealthMetrics,
} from './health';

function metrics(overrides: Partial<HealthMetrics> = {}): HealthMetrics {
  return { cpuPercent: 10, memoryPercent: 20, diskPercent: 30, at: Date.now(), ...overrides };
}

describe('metric collection', () => {
  it('measures CPU without os.loadavg, which is zeros on Windows', async () => {
    const percent = await sampleCpuPercent(60);

    assert.ok(Number.isFinite(percent));
    assert.ok(percent >= 0 && percent <= 100, `got ${percent}`);
    if (process.platform === 'win32') {
      assert.deepEqual(os.loadavg(), [0, 0, 0], 'precondition: loadavg is useless here');
    }
  });

  it('measures memory as a percentage', () => {
    const percent = memoryUsagePercent();
    assert.ok(percent > 0 && percent <= 100, `got ${percent}`);
  });

  it('measures disk for a real directory', () => {
    const percent = diskUsagePercent(process.cwd());
    assert.ok(percent !== undefined);
    assert.ok(percent > 0 && percent <= 100, `got ${percent}`);
  });

  it('returns undefined for a path it cannot stat, rather than throwing', () => {
    assert.equal(diskUsagePercent('/definitely/not/a/real/path/xyzzy'), undefined);
  });

  it('collects every metric together', async () => {
    const collected = await collectMetrics(process.cwd());

    assert.ok(collected.cpuPercent >= 0);
    assert.ok(collected.memoryPercent > 0);
    assert.ok(typeof collected.at === 'number');
  });
});

describe('evaluate', () => {
  it('is quiet when everything is under threshold', () => {
    assert.deepEqual(evaluate(metrics(), DEFAULT_THRESHOLDS), []);
  });

  it('alerts on CPU above the threshold', () => {
    const alerts = evaluate(metrics({ cpuPercent: 95 }), DEFAULT_THRESHOLDS);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.metric, 'cpu');
    assert.match(alerts[0]?.message ?? '', /95%/);
  });

  it('alerts on disk above the threshold', () => {
    const alerts = evaluate(metrics({ diskPercent: 92 }), DEFAULT_THRESHOLDS);
    assert.equal(alerts[0]?.metric, 'disk');
  });

  it('does not alert exactly at the threshold, only above it', () => {
    assert.deepEqual(evaluate(metrics({ cpuPercent: 90 }), DEFAULT_THRESHOLDS), []);
  });

  it('reports several breaches at once', () => {
    const alerts = evaluate(
      metrics({ cpuPercent: 99, memoryPercent: 99, diskPercent: 99 }),
      DEFAULT_THRESHOLDS,
    );
    assert.equal(alerts.length, 3);
  });

  it('says nothing about disk when it could not be read', () => {
    const withoutDisk: HealthMetrics = { cpuPercent: 10, memoryPercent: 10, at: Date.now() };
    assert.deepEqual(evaluate(withoutDisk, DEFAULT_THRESHOLDS), []);
  });

  it('honours custom thresholds', () => {
    const alerts = evaluate(metrics({ cpuPercent: 50 }), {
      cpuPercent: 40,
      memoryPercent: 90,
      diskPercent: 85,
    });
    assert.equal(alerts.length, 1);
  });
});

describe('AlertThrottle', () => {
  const cpu: HealthAlert = { metric: 'cpu', value: 95, threshold: 90, message: 'CPU at 95%' };
  const disk: HealthAlert = { metric: 'disk', value: 95, threshold: 85, message: 'Disk at 95%' };

  it('lets the first alert through', () => {
    const throttle = new AlertThrottle(3600);
    assert.equal(throttle.select([cpu], 1_000).length, 1);
  });

  it('suppresses a repeat inside the cooldown', () => {
    // A disk that stays 90% full is one problem, not one every five minutes.
    const throttle = new AlertThrottle(3600);
    throttle.select([cpu], 0);

    assert.deepEqual(throttle.select([cpu], 60_000), []);
    assert.deepEqual(throttle.select([cpu], 3_599_000), []);
  });

  it('lets it through again once the cooldown elapses', () => {
    const throttle = new AlertThrottle(3600);
    throttle.select([cpu], 0);

    assert.equal(throttle.select([cpu], 3_600_000).length, 1);
  });

  it('throttles each metric independently', () => {
    const throttle = new AlertThrottle(3600);
    throttle.select([cpu], 0);

    // Disk has not been reported yet, so it goes out immediately.
    const due = throttle.select([cpu, disk], 1_000);
    assert.equal(due.length, 1);
    assert.equal(due[0]?.metric, 'disk');
  });

  it('clears a metric that recovers, so the next breach is immediate', () => {
    // Without this, a flapping machine goes quiet for an hour after
    // recovering — which is the dangerous direction to fail in.
    const throttle = new AlertThrottle(3600);
    throttle.select([cpu], 0);
    assert.deepEqual(throttle.suppressed, ['cpu']);

    throttle.select([], 10_000); // recovered
    assert.deepEqual(throttle.suppressed, []);

    assert.equal(throttle.select([cpu], 20_000).length, 1, 'next breach reports immediately');
  });

  it('treats a zero cooldown as no throttling', () => {
    const throttle = new AlertThrottle(0);
    assert.equal(throttle.select([cpu], 0).length, 1);
    assert.equal(throttle.select([cpu], 1).length, 1);
  });

  it('forgets everything on reset', () => {
    const throttle = new AlertThrottle(3600);
    throttle.select([cpu], 0);
    throttle.reset();
    assert.equal(throttle.select([cpu], 1).length, 1);
  });
});

describe('HealthMonitor lifecycle', () => {
  function makeMonitor(notified: HealthAlert[][] = []) {
    return new HealthMonitor({
      workspaceRoot: process.cwd(),
      intervalSeconds: 1,
      cooldownSeconds: 0,
      // Impossible thresholds so every tick fires, without needing a busy machine.
      thresholds: { cpuPercent: -1, memoryPercent: -1, diskPercent: -1 },
      notify: (_chatIds, alerts) => notified.push([...alerts]),
    });
  }

  it('starts and stops, clearing its timer', () => {
    const monitor = makeMonitor();

    assert.equal(monitor.isRunning, false);
    monitor.start();
    assert.equal(monitor.isRunning, true);

    monitor.stop();
    // The timer MUST be gone: a surviving interval keeps the libuv loop alive
    // and the daemon never exits.
    assert.equal(monitor.isRunning, false);
  });

  it('is idempotent on repeated start and stop', () => {
    const monitor = makeMonitor();
    monitor.start();
    monitor.start();
    assert.equal(monitor.isRunning, true);
    monitor.stop();
    monitor.stop();
    assert.equal(monitor.isRunning, false);
  });

  it('tracks subscribers per chat', () => {
    const monitor = makeMonitor();

    assert.equal(monitor.subscribe(111), true);
    assert.equal(monitor.subscribe(111), false, 'already subscribed');
    assert.equal(monitor.isSubscribed(111), true);
    assert.equal(monitor.isSubscribed(222), false);
    assert.equal(monitor.subscriberCount, 1);

    assert.equal(monitor.unsubscribe(111), true);
    assert.equal(monitor.unsubscribe(111), false);
    monitor.stop();
  });

  it('drops all subscribers on stop', () => {
    const monitor = makeMonitor();
    monitor.subscribe(111);
    monitor.subscribe(222);

    monitor.stop();

    assert.equal(monitor.subscriberCount, 0);
  });

  it('does not notify when nobody has opted in', async () => {
    const notified: HealthAlert[][] = [];
    const monitor = makeMonitor(notified);

    const sent = await monitor.runCheck();

    assert.ok(sent.length > 0, 'thresholds were breached');
    assert.equal(notified.length, 0, 'but nobody asked to hear about it');
    monitor.stop();
  });

  it('notifies subscribers when thresholds are breached', async () => {
    const notified: HealthAlert[][] = [];
    const monitor = makeMonitor(notified);
    monitor.subscribe(111);

    await monitor.runCheck();

    assert.equal(notified.length, 1);
    assert.ok((notified[0]?.length ?? 0) > 0);
    monitor.stop();
  });

  it('reports a snapshot without sending anything', async () => {
    const notified: HealthAlert[][] = [];
    const monitor = makeMonitor(notified);
    monitor.subscribe(111);

    const { metrics: readings, alerts } = await monitor.snapshot();

    assert.ok(readings.cpuPercent >= 0);
    assert.ok(alerts.length > 0);
    assert.equal(notified.length, 0, 'snapshot must not push alerts');
    monitor.stop();
  });
});

describe('service liveness (build guide Day 19: "or key service is down")', () => {
  it('reports a TCP port with nothing listening as down', async () => {
    // Port 1 on loopback: nothing legitimate listens there.
    const status = await probeService({ name: 'ghost', port: 1 }, 1_500);

    assert.equal(status.name, 'ghost');
    assert.equal(status.up, false);
    assert.ok(status.detail.length > 0);
  });

  it('reports a port that IS listening as up', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const status = await probeService({ name: 'local', port }, 1_500);
      assert.equal(status.up, true);
      assert.match(status.detail, /open/);
    } finally {
      server.close();
    }
  });

  it('treats a target with neither url nor port as down, not as a crash', async () => {
    const status = await probeService({ name: 'misconfigured' }, 500);
    assert.equal(status.up, false);
    assert.match(status.detail, /no url or port/);
  });

  it('raises one alert per down service and none for healthy ones', () => {
    const alerts = evaluateServices([
      { name: 'api', up: false, detail: 'ECONNREFUSED' },
      { name: 'web', up: true, detail: 'HTTP 200' },
      { name: 'worker', up: false, detail: 'timed out' },
    ]);

    assert.deepEqual(
      alerts.map((alert) => alert.metric),
      ['service:api', 'service:worker'],
    );
    assert.match(String(alerts[0]?.message), /api is DOWN \(ECONNREFUSED\)/);
  });

  it('cools down per service, and a recovered service alerts again at once', () => {
    const throttle = new AlertThrottle(3600);
    const down = evaluateServices([{ name: 'api', up: false, detail: 'ECONNREFUSED' }]);

    assert.equal(throttle.select(down, 0).length, 1);
    // Same service still down a minute later: suppressed.
    assert.equal(throttle.select(down, 60_000).length, 0);
    // Recovered (no alerts), which clears it...
    assert.equal(throttle.select([], 120_000).length, 0);
    // ...so the next failure reports immediately rather than waiting an hour.
    assert.equal(throttle.select(down, 121_000).length, 1);
  });

  it('keeps a down service from suppressing a CPU alert', () => {
    const throttle = new AlertThrottle(3600);
    const mixed = [
      ...evaluateServices([{ name: 'api', up: false, detail: 'down' }]),
      { metric: 'cpu' as const, value: 95, threshold: 90, message: 'CPU at 95%' },
    ];

    assert.equal(throttle.select(mixed, 0).length, 2);
  });
});
