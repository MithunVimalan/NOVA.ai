import { getSqliteManager } from '@nova/shared';

export interface CronJob {
  id: string;
  schedule: string; // e.g. "every 10m", "every 1h", "daily"
  actionDescription: string;
  lastRun?: Date;
}

export class CronService {
  private jobs: CronJob[] = [];
  private intervals: NodeJS.Timeout[] = [];

  constructor() {
    this.loadJobs();
  }

  private loadJobs() {
    console.log(`[Cron] Initializing Cron Service...`);
    // In a production setup, we load scheduled jobs from SQLite:
    const sqliteDb = getSqliteManager();
    const serializedJobs = sqliteDb.getFact('scheduled_cron_jobs');
    if (serializedJobs) {
      try {
        this.jobs = JSON.parse(serializedJobs);
        console.log(`[Cron] Restored ${this.jobs.length} scheduled jobs.`);
        this.startAllJobs();
      } catch (err) {
        console.error('[Cron] Stored job definitions are corrupt, discarding all scheduled jobs:', err);
        this.jobs = [];
      }
    }
  }

  private saveJobs() {
    const sqliteDb = getSqliteManager();
    sqliteDb.setFact('scheduled_cron_jobs', JSON.stringify(this.jobs));
  }

  private startAllJobs() {
    // Clear any active intervals
    this.intervals.forEach(clearInterval);
    this.intervals = [];

    for (const job of this.jobs) {
      this.runJobSchedule(job);
    }
  }

  private runJobSchedule(job: CronJob) {
    // Basic schedule parser: "every Xm", "every Xh", "daily"
    let intervalMs = 60000 * 10; // default 10m
    const matchMin = job.schedule.match(/every (\d+)m/);
    const matchHour = job.schedule.match(/every (\d+)h/);

    if (matchMin) {
      intervalMs = parseInt(matchMin[1]) * 60000;
    } else if (matchHour) {
      intervalMs = parseInt(matchHour[1]) * 3600000;
    } else if (job.schedule === 'daily') {
      intervalMs = 24 * 3600000;
    } else if (job.schedule.startsWith('*/')) {
      // standard crontab fallback */10 * * * *
      const val = job.schedule.split(' ')[0].replace('*/', '');
      const parsed = parseInt(val);
      if (!isNaN(parsed)) intervalMs = parsed * 60000;
    }

    console.log(`[Cron] Starting Job: "${job.actionDescription}" triggers every ${intervalMs / 1000}s`);

    const timer = setInterval(async () => {
      console.log(`[Cron] Triggering scheduled job: "${job.actionDescription}"`);
      job.lastRun = new Date();
      this.saveJobs();

      // Trigger the background action using the Session Manager
      try {
        const sessionManager = require('./session.js').getSessionManager();
        // Run as a special session ID
        const result = await sessionManager.handleUserMessage(
          'cron-autonomous-session',
          `Automated Check: ${job.actionDescription}. Check and output status.`,
          true,
          'web'
        );
        console.log(`[Cron] Job complete. Response length: ${result.length}`);
        
        // Push result report to owner notification hooks (e.g. active Telegram or WhatsApp sockets)
        const heartbeatService = require('./heartbeat.js').getHeartbeatService();
        heartbeatService.notifyOwner(`[Cron Alert] Task Triggered: ${job.actionDescription}\n\n${result}`);
      } catch (err) {
        console.error(`[Cron] Execution error:`, err);
      }
    }, intervalMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.intervals.push(timer);
  }

  public scheduleTask(schedule: string, actionDescription: string): void {
    const newJob: CronJob = {
      id: `cron-${Date.now()}`,
      schedule,
      actionDescription,
    };
    this.jobs.push(newJob);
    this.saveJobs();
    this.runJobSchedule(newJob);
  }

  public getJobs(): CronJob[] {
    return this.jobs;
  }

  public clearAllJobs(): void {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    this.jobs = [];
    this.saveJobs();
    console.log(`[Cron] All cron jobs cleared.`);
  }
}

let cronServiceInstance: CronService | null = null;
export function getCronService(): CronService {
  if (!cronServiceInstance) {
    cronServiceInstance = new CronService();
  }
  return cronServiceInstance;
}
