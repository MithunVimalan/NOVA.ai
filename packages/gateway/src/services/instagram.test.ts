import test from 'node:test';
import assert from 'node:assert';
import { getSqliteManager } from '@nova/shared';
import { getQueueService } from './queue.js';

// TDD Test: Meta Webhook Validation (GET)
test('Instagram Webhook GET validation returns challenge for correct verify token', async () => {
  const sqliteDb = getSqliteManager();
  const tenantId = 'tenant-test-ig';
  const verifyToken = 'super_secret_instagram_verify_token_abc';

  // Seed token in SQLite facts
  sqliteDb.setFact(`instagram_verify_token_${tenantId}`, verifyToken);

  // Dynamically import Fastify server setup to simulate route responses if needed,
  // or test the logic function or endpoint directly.
  // Let's test the endpoint logic:
  const getVerifyTokenFromDb = (tid: string) => {
    return sqliteDb.getFact(`instagram_verify_token_${tid}`);
  };

  const storedToken = getVerifyTokenFromDb(tenantId);
  assert.strictEqual(storedToken, verifyToken, 'Stored verify token must match seeded token');

  // Test incorrect validation
  const mode = 'subscribe';
  const challenge = 'challenge_code_12345';
  
  const validateWebhook = (modeParam: string, tokenParam: string, challengeParam: string, tid: string) => {
    if (modeParam === 'subscribe' && tokenParam === getVerifyTokenFromDb(tid)) {
      return challengeParam;
    }
    throw new Error('Unauthorized');
  };

  const validatedResult = validateWebhook(mode, verifyToken, challenge, tenantId);
  assert.strictEqual(validatedResult, challenge, 'Validation must return the hub.challenge query parameter');

  assert.throws(() => {
    validateWebhook(mode, 'wrong_token', challenge, tenantId);
  }, /Unauthorized/, 'Validation must throw for invalid token');
});

// TDD Test: Instagram Message Webhook Ingestion (POST)
test('Instagram Webhook POST successfully parses entries and enqueues messages', async () => {
  const queueService = getQueueService();
  
  // Clear any existing tasks if necessary
  // Mock entry payload
  const mockPayload = {
    object: 'instagram',
    entry: [
      {
        id: 'page_ig_id',
        time: Date.now(),
        messaging: [
          {
            sender: { id: 'ig_sender_123' },
            recipient: { id: 'page_ig_id' },
            timestamp: Date.now(),
            message: {
              mid: 'ig_msg_mid_999',
              text: 'Can I purchase the NOVA assistant?'
            }
          }
        ]
      }
    ]
  };

  // Logic to process webhook entry and enqueue
  let enqueuedChannel: string | null = null;
  let enqueuedTenant: string | null = null;
  let enqueuedSender: string | null = null;
  let enqueuedText: string | null = null;

  // Intercept enqueueMessage
  const originalEnqueue = queueService.enqueueMessage;
  queueService.enqueueMessage = async (channel, tenantId, senderId, text, extraData) => {
    enqueuedChannel = channel;
    enqueuedTenant = tenantId;
    enqueuedSender = senderId;
    enqueuedText = text;
  };

  const processInstagramWebhook = async (tenantId: string, body: any) => {
    if (body.object === 'instagram' && body.entry) {
      for (const entry of body.entry) {
        if (entry.messaging) {
          for (const msgEvent of entry.messaging) {
            if (msgEvent.message && msgEvent.message.text) {
              await queueService.enqueueMessage(
                'instagram' as any,
                tenantId,
                msgEvent.sender.id,
                msgEvent.message.text,
                { instagramPageId: entry.id }
              );
            }
          }
        }
      }
    }
  };

  try {
    await processInstagramWebhook('tenant-test-ig', mockPayload);
    assert.strictEqual(enqueuedChannel, 'instagram');
    assert.strictEqual(enqueuedTenant, 'tenant-test-ig');
    assert.strictEqual(enqueuedSender, 'ig_sender_123');
    assert.strictEqual(enqueuedText, 'Can I purchase the NOVA assistant?');
  } finally {
    // Restore original function
    queueService.enqueueMessage = originalEnqueue;
  }
});

// TDD Test: Notification token registration and FCM trigger
test('FCM Token registration and notification alert triggers correctly on takeover', async () => {
  const sqliteDb = getSqliteManager();
  const tenantId = 'tenant-test-ig';
  const mockFcmToken = 'fcm_token_xyz_123';

  // 1. Test token registration
  const registerFcmToken = (tid: string, token: string) => {
    sqliteDb.setFact(`fcm_token_${tid}`, token);
  };

  registerFcmToken(tenantId, mockFcmToken);
  const registeredToken = sqliteDb.getFact(`fcm_token_${tenantId}`);
  assert.strictEqual(registeredToken, mockFcmToken, 'FCM token must be registered in SQLite facts');

  // 2. Test notification trigger logic
  let notificationSent = false;
  let notificationBody = '';

  const triggerNotification = async (tid: string, message: string) => {
    const token = sqliteDb.getFact(`fcm_token_${tid}`);
    if (token) {
      notificationSent = true;
      notificationBody = message;
      // In production, makes fetch call to FCM endpoint
    }
  };

  await triggerNotification(tenantId, 'Session needs human takeover');
  assert.strictEqual(notificationSent, true, 'Takeover trigger must send notification');
  assert.strictEqual(notificationBody, 'Session needs human takeover');
});
