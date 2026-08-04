import test from 'node:test';
import assert from 'node:assert';
import { getSqliteManager } from '@nova/shared';
import { CronService, getCronService } from './cron.js';

test.after(() => {
  getCronService().clearAllJobs();
});

test('getCronService returns a shared singleton instance', () => {
  assert.strictEqual(getCronService(), getCronService());
});

test('scheduleTask registers a job and persists it to the fact store', () => {
  const service = new CronService();
  service.clearAllJobs();

  service.scheduleTask('every 5m', 'Check the order backlog');

  const jobs = service.getJobs();
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].schedule, 'every 5m');
  assert.strictEqual(jobs[0].actionDescription, 'Check the order backlog');
  assert.match(jobs[0].id, /^cron-\d+$/);

  const persisted = JSON.parse(getSqliteManager().getFact('scheduled_cron_jobs') || '[]');
  assert.strictEqual(persisted.length, 1);
  assert.strictEqual(persisted[0].actionDescription, 'Check the order backlog');

  service.clearAllJobs();
});

test('Scheduled jobs accumulate and clearAllJobs empties both memory and storage', () => {
  const service = new CronService();
  service.clearAllJobs();

  service.scheduleTask('every 1h', 'Hourly report');
  service.scheduleTask('daily', 'Daily digest');
  assert.strictEqual(service.getJobs().length, 2);

  service.clearAllJobs();
  assert.deepStrictEqual(service.getJobs(), []);
  assert.strictEqual(getSqliteManager().getFact('scheduled_cron_jobs'), '[]');
});

test('Persisted jobs are restored when the service restarts', () => {
  const seed = new CronService();
  seed.clearAllJobs();
  seed.scheduleTask('every 10m', 'Restored job');

  const restarted = new CronService();
  const jobs = restarted.getJobs();

  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].actionDescription, 'Restored job');

  restarted.clearAllJobs();
});

test('Corrupted job storage is ignored instead of crashing the service', () => {
  getSqliteManager().setFact('scheduled_cron_jobs', '{not valid json');

  const service = new CronService();

  assert.deepStrictEqual(service.getJobs(), [], 'Unparsable job state must reset to an empty schedule');
  service.clearAllJobs();
});

test('Supported schedule expressions are all accepted', () => {
  const service = new CronService();
  service.clearAllJobs();

  for (const schedule of ['every 15m', 'every 2h', 'daily', '*/10 * * * *', 'nonsense-schedule']) {
    service.scheduleTask(schedule, `Job for ${schedule}`);
  }

  assert.deepStrictEqual(
    service.getJobs().map(j => j.schedule),
    ['every 15m', 'every 2h', 'daily', '*/10 * * * *', 'nonsense-schedule']
  );

  service.clearAllJobs();
});
