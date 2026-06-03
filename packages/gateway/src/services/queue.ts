import { getSessionManager } from './session.js';
import { getSqliteManager } from '@nova/shared';

export interface QueueJob {
  id: string;
  channel: 'telegram' | 'whatsapp' | 'instagram';
  tenantId: string;
  senderId: string;
  text: string;
  extraData?: any;
  retries: number;
  createdAt: number;
}

export class QueueService {
  private memoryQueue: QueueJob[] = [];
  private isProcessing: boolean = false;
  private maxRetries: number = 3;

  // Optional BullMQ resources
  private bullQueue: any = null;

  constructor() {
    this.initializeQueue();
  }

  private async initializeQueue() {
    try {
      const redisUrl = process.env.REDIS_URL;
      if (redisUrl) {
        console.log(`[QueueService] Connecting to Redis: ${redisUrl}`);
        // Attempt dynamic import of bullmq
        const { Queue, Worker } = await import('bullmq');
        const IoRedisClass = (await import('ioredis')).default;
        const RedisConstructor: any = (IoRedisClass as any).Redis || IoRedisClass;
        const connection = new RedisConstructor(redisUrl, { maxRetriesPerRequest: null });
        this.bullQueue = new Queue('nova-messages', { connection });

        // Instantiate worker to process jobs asynchronously
        new Worker('nova-messages', async (job) => {
          const { channel, tenantId, senderId, text, extraData } = job.data;
          await this.processMessageTask(channel, tenantId, senderId, text, extraData);
        }, { connection });

        console.log('[QueueService] BullMQ Queue initialized successfully on Redis.');
      } else {
        console.info('[QueueService] Redis URL not found. Running with high-reliability local in-memory queue.');
        this.startMemoryQueueProcessor();
      }
    } catch (e: any) {
      console.warn('[QueueService] Failed to load BullMQ/Redis, using local in-memory fallback.', e.message);
      this.startMemoryQueueProcessor();
    }
  }

  /**
   * Enqueues a message processing job
   */
  async enqueueMessage(
    channel: 'telegram' | 'whatsapp' | 'instagram',
    tenantId: string,
    senderId: string,
    text: string,
    extraData?: any
  ): Promise<void> {
    if (this.bullQueue) {
      await this.bullQueue.add(`${channel}-${tenantId}-${senderId}`, {
        channel,
        tenantId,
        senderId,
        text,
        extraData,
      }, {
        attempts: this.maxRetries,
        backoff: { type: 'exponential', delay: 2000 },
      });
      console.log(`[QueueService] Enqueued message job via BullMQ for Tenant ${tenantId}`);
    } else {
      const job: QueueJob = {
        id: Math.random().toString(36).substring(2, 9) + '-' + Date.now(),
        channel,
        tenantId,
        senderId,
        text,
        extraData,
        retries: 0,
        createdAt: Date.now(),
      };
      this.memoryQueue.push(job);
      console.log(`[QueueService] Enqueued message job in-memory for Tenant ${tenantId}. Queue Size: ${this.memoryQueue.length}`);
    }
  }

  /**
   * Periodically checks and processes the in-memory queue sequentially
   */
  private startMemoryQueueProcessor() {
    const timer = setInterval(async () => {
      if (this.isProcessing || this.memoryQueue.length === 0) return;
      this.isProcessing = true;

      const job = this.memoryQueue.shift();
      if (job) {
        try {
          await this.processMessageTask(job.channel, job.tenantId, job.senderId, job.text, job.extraData);
        } catch (e: any) {
          console.error(`[QueueService] Error processing job ${job.id}:`, e.message);
          
          if (job.retries < this.maxRetries) {
            job.retries += 1;
            // Delay re-insertion
            setTimeout(() => {
              this.memoryQueue.push(job);
            }, 1000 * job.retries);
            console.log(`[QueueService] Re-queued job ${job.id} (Attempt ${job.retries}/${this.maxRetries})`);
          } else {
            console.error(`[QueueService] Job ${job.id} failed after ${this.maxRetries} attempts. Discarding.`);
          }
        }
      }

      this.isProcessing = false;
    }, 100);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  /**
   * The actual task runner that calls handleUserMessage and delivers the response
   */
  private async processMessageTask(
    channel: 'telegram' | 'whatsapp' | 'instagram',
    tenantId: string,
    senderId: string,
    text: string,
    extraData?: any
  ): Promise<void> {
    const sessionManager = getSessionManager();
    const sqliteDb = getSqliteManager();
    const tenant = sqliteDb.getTenant(tenantId);

    if (!tenant) {
      console.warn(`[QueueProcessor] Skipping job. Tenant ${tenantId} not found.`);
      return;
    }

    console.log(`[QueueProcessor] Executing Complete completion loop for Tenant ${tenantId} on channel ${channel}...`);
    
    // Process chat response
    const replyText = await sessionManager.handleUserMessage(
      `${channel}-${tenantId}-${senderId}`,
      text,
      false, // default guest user
      channel
    );

    // Deliver response
    if (channel === 'telegram') {
      const Telegraf = (await import('telegraf')).Telegraf;
      const bot = new Telegraf(tenant.telegramToken);
      await bot.telegram.sendMessage(senderId, replyText);
      console.log(`[QueueProcessor] Sent Telegram message reply to sender ${senderId}`);
    } else if (channel === 'whatsapp') {
      const phoneId = extraData?.phoneId;
      if (tenant.whatsappToken && phoneId) {
        const response = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tenant.whatsappToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: senderId,
            text: { body: replyText },
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Meta Graph API returned HTTP ${response.status}: ${errText}`);
        }
        console.log(`[QueueProcessor] Sent WhatsApp Cloud API reply to sender ${senderId}`);
      } else {
        throw new Error('Missing Meta Whatsapp credentials or phone ID in task data');
      }
    } else if (channel === 'instagram') {
      const instagramToken = tenant.whatsappToken || extraData?.instagramToken;
      if (instagramToken) {
        const response = await fetch(`https://graph.facebook.com/v18.0/me/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${instagramToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient: { id: senderId },
            message: { text: replyText },
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Meta Instagram API returned HTTP ${response.status}: ${errText}`);
        }
        console.log(`[QueueProcessor] Sent Instagram message reply to sender ${senderId}`);
      } else {
        throw new Error('Missing Meta Instagram access token');
      }
    }
  }
}

let queueServiceInstance: QueueService | null = null;
export function getQueueService(): QueueService {
  if (!queueServiceInstance) {
    queueServiceInstance = new QueueService();
  }
  return queueServiceInstance;
}
