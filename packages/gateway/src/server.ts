import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { getVoiceService } from './services/voice.js';
import { getQueueService } from './services/queue.js';
import { getCrmService } from './services/crm.js';
import { getRateLimiter } from './services/limiter.js';
import { generateJwt, verifyJwt } from './services/auth.js';
import { Telegraf } from 'telegraf';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, getSqliteManager, getVectorDbManager } from '@nova/shared';
import { getSessionManager } from './services/session.js';
import { getSkillService } from './services/skills.js';
import { getCronService } from './services/cron.js';
import { getHeartbeatService } from './services/heartbeat.js';
import { startTelegramBot, startWhatsAppBot } from '@nova/channels';

const config = loadConfig();
const fastify = Fastify({ logger: true });

async function main() {
  // Register CORS
  await fastify.register(cors, {
    origin: '*',
  });

  // Register WebSockets
  await fastify.register(fastifyWebsocket);

  // Rate Limiting Hook (Abuse Protection)
  fastify.addHook('preHandler', async (request: any, reply) => {
    if (request.url.startsWith('/api/widget') || request.url.startsWith('/webhooks')) {
      const limiter = getRateLimiter();
      const ip = request.ip || 'global';
      const isLimited = await limiter.isRateLimited(ip, 60, 60); // 60 requests/min
      if (isLimited) {
        return reply.status(429).send({ error: 'Too Many Requests. Rate limit exceeded.' });
      }
    }
  });

  // Services Initialization
  const sessionManager = getSessionManager();
  const skillService = getSkillService();
  const cronService = getCronService();
  const heartbeatService = getHeartbeatService();
  const sqliteDb = getSqliteManager();
  const vectorDb = getVectorDbManager();

  // Start modular channel receivers
  startTelegramBot(sessionManager, heartbeatService);
  startWhatsAppBot(sessionManager, heartbeatService);

  // Create public directory for serving widget client assets
  const publicDir = path.join(process.cwd(), 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  // Serve static public folder (which contains widget script and dashboard builds)
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/public/',
  });

  // Serve the widget script directly at /widget.js
  fastify.get('/widget.js', async (request, reply) => {
    const scriptPath = path.join(publicDir, 'widget.js');
    if (fs.existsSync(scriptPath)) {
      reply.type('application/javascript');
      return fs.readFileSync(scriptPath, 'utf-8');
    }
    reply.status(404).send({ error: 'Widget file not built yet. Run build process.' });
  });

  // API Route: Personal Owner Chat
  fastify.post('/api/chat', async (request: any, reply) => {
    const { message, sessionId = 'owner-session' } = request.body || {};
    if (!message) {
      return reply.status(400).send({ error: 'Message field is required' });
    }
    const response = await sessionManager.handleUserMessage(sessionId, message, true, 'web');
    return { reply: response };
  });

  // API Route: Sandbox Guest Widget Chat (with RAG and context)
  fastify.post('/api/widget/chat', async (request: any, reply) => {
    const { message, sessionId } = request.body || {};
    if (!message || !sessionId) {
      return reply.status(400).send({ error: 'Message and sessionId are required' });
    }
    const response = await sessionManager.handleUserMessage(sessionId, message, false, 'widget');
    return { reply: response };
  });

  // API Route: Log Widget Visitor Track Events
  fastify.post('/api/widget/track', async (request: any, reply) => {
    const { sessionId, pageUrl, referrer = '', scrollDepth = 0, timeOnPage = 0 } = request.body || {};
    if (!sessionId || !pageUrl) {
      return reply.status(400).send({ error: 'sessionId and pageUrl are required' });
    }

    sqliteDb.logVisitorEvent({
      sessionId,
      pageUrl,
      referrer,
      scrollDepth: Number(scrollDepth),
      timeOnPage: Number(timeOnPage),
    });

    return { success: true };
  });

  // API Route: Capture Lead Email & Name
  fastify.post('/api/widget/lead', async (request: any, reply) => {
    const { sessionId, name, email } = request.body || {};
    if (!sessionId || !name || !email) {
      return reply.status(400).send({ error: 'sessionId, name, and email are required' });
    }

    sqliteDb.addLead({ sessionId, name, email });

    // Sync to HubSpot CRM (in background)
    const crmService = getCrmService();
    crmService.syncLeadToHubSpot(name, email).catch(err => {
      console.error('[HubSpot Sync Error]:', err);
    });

    return { success: true };
  });

  // API Route: Get Visitor Stats for Dashboard
  fastify.get('/api/widget/stats', async (request, reply) => {
    const logs = sqliteDb.getVisitorLogs();
    const leads = sqliteDb.getLeads();
    
    // Group analysis
    const uniqueSessions = new Set(logs.map(l => l.sessionId)).size;
    const leadsCount = leads.length;
    
    return {
      totalVisits: logs.length,
      uniqueVisitors: uniqueSessions,
      totalLeads: leadsCount,
      logs: logs.slice(0, 50),
      leads,
    };
  });

  // API Route: List loaded Skills
  fastify.get('/api/skills', async (request, reply) => {
    return skillService.getSkills().map(s => ({
      name: s.name,
      description: s.description,
      tools: s.tools,
    }));
  });

  // API Route: List Cron jobs & schedule new task
  fastify.get('/api/cron', async (request, reply) => {
    return cronService.getJobs();
  });

  fastify.post('/api/cron', async (request: any, reply) => {
    const { schedule, actionDescription } = request.body || {};
    if (!schedule || !actionDescription) {
      return reply.status(400).send({ error: 'schedule and actionDescription are required' });
    }
    cronService.scheduleTask(schedule, actionDescription);
    return { success: true };
  });

  fastify.delete('/api/cron', async (request, reply) => {
    cronService.clearAllJobs();
    return { success: true };
  });

  // API Route: List SQLite facts profile
  fastify.get('/api/facts', async (request, reply) => {
    return sqliteDb.getAllFacts();
  });

  fastify.post('/api/facts', async (request: any, reply) => {
    const { key, value } = request.body || {};
    if (!key || !value) {
      return reply.status(400).send({ error: 'key and value are required' });
    }
    sqliteDb.setFact(key, value);
    return { success: true };
  });

  // API Route: RAG Document Upload / Training Endpoint
  fastify.post('/api/rag/upload', async (request: any, reply) => {
    const { documents } = request.body || {}; // array of { text, source }
    if (!documents || !Array.isArray(documents)) {
      return reply.status(400).send({ error: 'documents array is required' });
    }

    for (const doc of documents) {
      if (doc.text) {
        await vectorDb.addCatalogDoc(doc.text, { source: doc.source || 'manual' });
      }
    }

    return { success: true, count: documents.length };
  });

  fastify.delete('/api/rag/clear', async (request, reply) => {
    vectorDb.clearCatalog();
    return { success: true };
  });

  // Register Web UI Mock Dashboard Route if React dashboard is built
  fastify.get('/', async (request, reply) => {
    const landingHtml = path.join(publicDir, 'index.html');
    if (fs.existsSync(landingHtml)) {
      return reply.sendFile('index.html');
    }
    
    // Sleek default fall-back HTML welcoming dashboard
    reply.type('text/html');
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>NOVA Assistant Server</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Outfit', sans-serif;
            background: linear-gradient(135deg, #0f0c1b, #201a30);
            color: #fff;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
            overflow: hidden;
          }
          .card {
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            padding: 40px;
            text-align: center;
            max-width: 500px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
            animation: fadeIn 1s ease-out;
          }
          h1 {
            background: linear-gradient(90deg, #a855f7, #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 10px;
            font-size: 2.5rem;
          }
          p {
            color: #94a3b8;
            font-size: 1.1rem;
            line-height: 1.6;
          }
          .badge {
            background: rgba(168, 85, 247, 0.2);
            border: 1px solid #a855f7;
            color: #d8b4fe;
            padding: 5px 15px;
            border-radius: 50px;
            display: inline-block;
            margin-top: 15px;
            font-size: 0.9rem;
          }
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>NOVA</h1>
          <p>Next-gen Obedient Virtual Assistant. Gateway control plane server is running smoothly on port ${config.channels.dashboard.port}.</p>
          <span class="badge">Ollama Endpoint: ${config.ollamaUrl}</span>
        </div>
      </body>
      </html>
    `;
  });

  const serveDashboard = async (request: any, reply: any) => {
    const dashboardHtml = path.join(publicDir, 'dashboard.html');
    if (fs.existsSync(dashboardHtml)) {
      return reply.sendFile('dashboard.html');
    }
    reply.status(404).send({ error: 'Dashboard file not found' });
  };
  fastify.get('/dashboard', serveDashboard);
  fastify.get('/dashboard.html', serveDashboard);

  // API Route: Low-latency WebSockets Voice Assistant Stream
  fastify.get('/api/voice', { websocket: true }, (connection, req) => {
    let audioChunks: Buffer[] = [];
    const voiceService = getVoiceService();

    connection.socket.on('message', async (message: any) => {
      try {
        const msgStr = message.toString();
        let payload: any = {};
        try {
          payload = JSON.parse(msgStr);
        } catch {
          // If not valid JSON, treat it as raw binary audio chunks
          if (Buffer.isBuffer(message)) {
            audioChunks.push(message);
          }
          return;
        }

        if (payload.type === 'audio_chunk') {
          const chunk = Buffer.from(payload.data, 'base64');
          audioChunks.push(chunk);
        } else if (payload.type === 'clear') {
          audioChunks = [];
        } else if (payload.type === 'transcribe_request') {
          if (audioChunks.length === 0) {
            connection.socket.send(JSON.stringify({ type: 'error', error: 'No audio chunks received' }));
            return;
          }

          const fullBuffer = Buffer.concat(audioChunks);
          audioChunks = []; // Clear for next input

          // 1. Transcribe speech to text
          connection.socket.send(JSON.stringify({ type: 'status', status: 'Transcribing...' }));
          const transcript = await voiceService.transcribeAudio(fullBuffer, payload.mimeType || 'audio/wav');
          connection.socket.send(JSON.stringify({ type: 'transcript', text: transcript }));

          // 2. Route message to LLM assistant
          connection.socket.send(JSON.stringify({ type: 'status', status: 'Thinking...' }));
          const responseText = await sessionManager.handleUserMessage(
            payload.sessionId || 'voice-session',
            transcript,
            payload.isOwner !== false,
            'voice'
          );
          connection.socket.send(JSON.stringify({ type: 'text_response', text: responseText }));

          // 3. Synthesize response to voice
          connection.socket.send(JSON.stringify({ type: 'status', status: 'Synthesizing voice...' }));
          const voiceBuffer = await voiceService.synthesizeSpeech(responseText);
          const audioBase64 = voiceBuffer.toString('base64');

          connection.socket.send(JSON.stringify({
            type: 'audio_response',
            audio: audioBase64,
            mimeType: 'audio/wav',
          }));
          connection.socket.send(JSON.stringify({ type: 'status', status: 'Ready' }));
        }
      } catch (err: any) {
        console.error('[VoiceWS] Processing error:', err);
        connection.socket.send(JSON.stringify({ type: 'error', error: err.message }));
      }
    });
  });

  // Multi-Tenant Telegram Bot Cache and Helper
  const telegrafInstances: Map<string, Telegraf> = new Map();

  function getOrCreateTelegramBot(tenantId: string, token: string, sessionManager: any): Telegraf {
    if (telegrafInstances.has(tenantId)) {
      return telegrafInstances.get(tenantId)!;
    }

    const bot = new Telegraf(token);

    bot.start((ctx) => {
      ctx.reply(`NOVA bot is active for Tenant ${tenantId}!`);
    });

    bot.command('clear', (ctx) => {
      const chatId = ctx.chat.id.toString();
      sessionManager.clearSession(`telegram-${tenantId}-${chatId}`);
      ctx.reply('Conversation history cleared.');
    });

    bot.on('text', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const messageText = ctx.message.text;
      ctx.sendChatAction('typing');

      try {
        const queueService = getQueueService();
        await queueService.enqueueMessage('telegram', tenantId, chatId, messageText);
      } catch (err: any) {
        console.error(`[Telegram Webhook ${tenantId}] Queue failed:`, err);
        ctx.reply(`Error: ${err.message}`);
      }
    });

    telegrafInstances.set(tenantId, bot);
    return bot;
  }

  // Webhook: Telegram Multi-Tenant updates
  fastify.post('/webhooks/telegram/:tenantId', async (request: any, reply) => {
    const { tenantId } = request.params;
    const sqliteDb = getSqliteManager();
    const tenant = sqliteDb.getTenant(tenantId);

    if (!tenant || !tenant.telegramEnabled || !tenant.telegramToken) {
      return reply.status(404).send({ error: 'Tenant or Telegram channel not found' });
    }

    if (tenant.stripeStatus !== 'active') {
      return reply.status(403).send({ error: 'Subscription past due' });
    }

    try {
      const bot = getOrCreateTelegramBot(tenantId, tenant.telegramToken, sessionManager);
      await bot.handleUpdate(request.body);
      return { success: true };
    } catch (err: any) {
      console.error(`[Telegram Webhook Error for ${tenantId}]:`, err);
      return reply.status(500).send({ error: err.message });
    }
  });

  // Webhook: WhatsApp Cloud API GET Verification
  fastify.get('/webhooks/whatsapp/:tenantId', async (request: any, reply) => {
    const { tenantId } = request.params;
    const sqliteDb = getSqliteManager();
    const tenant = sqliteDb.getTenant(tenantId);

    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    if (mode === 'subscribe' && token === (tenant.whatsappToken || 'nova_verify')) {
      console.log(`[WhatsApp Webhook verified for Tenant ${tenantId}]`);
      return reply.send(challenge);
    }
    return reply.status(403).send({ error: 'Verification failed' });
  });

  // Webhook: WhatsApp Cloud API POST Messages
  fastify.post('/webhooks/whatsapp/:tenantId', async (request: any, reply) => {
    const { tenantId } = request.params;
    const sqliteDb = getSqliteManager();
    const tenant = sqliteDb.getTenant(tenantId);

    if (!tenant || !tenant.whatsappEnabled) {
      return reply.status(404).send({ error: 'Tenant or WhatsApp channel not active' });
    }

    if (tenant.stripeStatus !== 'active') {
      return reply.status(403).send({ error: 'Subscription past due' });
    }

    const body = request.body;
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const message = change?.messages?.[0];

      if (message && message.type === 'text') {
        const fromNum = message.from;
        const bodyText = message.text.body;
        const phoneId = change.metadata?.phone_number_id;

        console.log(`[WhatsApp Webhook ${tenantId}] Msg from ${fromNum}: ${bodyText}`);

        try {
          const queueService = getQueueService();
          await queueService.enqueueMessage('whatsapp', tenantId, fromNum, bodyText, { phoneId });
        } catch (e: any) {
          console.error(`[WhatsApp Webhook ${tenantId}] Queue failed:`, e);
        }
      }
      return { success: true };
    }

    return reply.status(400).send({ error: 'Invalid payload structure' });
  });

  // API Route: Start Manual Takeover
  fastify.post('/api/takeover/start', async (request: any, reply) => {
    const { sessionId } = request.body || {};
    if (!sessionId) return reply.status(400).send({ error: 'sessionId is required' });

    const session = sessionManager.getOrCreateSession(sessionId);
    (session as any).isManualTakeover = true;
    console.log(`[Takeover] Activated manual takeover for session ${sessionId}`);
    return { success: true };
  });

  // API Route: Stop Manual Takeover
  fastify.post('/api/takeover/stop', async (request: any, reply) => {
    const { sessionId } = request.body || {};
    if (!sessionId) return reply.status(400).send({ error: 'sessionId is required' });

    const session = sessionManager.getOrCreateSession(sessionId);
    (session as any).isManualTakeover = false;
    console.log(`[Takeover] Deactivated manual takeover for session ${sessionId}`);
    return { success: true };
  });

  // API Route: Send Manual Message (Takeover reply)
  fastify.post('/api/takeover/send', async (request: any, reply) => {
    const { sessionId, message } = request.body || {};
    if (!sessionId || !message) return reply.status(400).send({ error: 'sessionId and message are required' });

    const session = sessionManager.getOrCreateSession(sessionId);
    session.history.push({ role: 'assistant', content: message });

    // Send the manual reply to the specific bot channel if applicable
    if (sessionId.startsWith('telegram-')) {
      const parts = sessionId.split('-');
      const tenantId = parts[1];
      const chatId = parts[2];
      const sqliteDb = getSqliteManager();
      const tenant = sqliteDb.getTenant(tenantId);
      if (tenant) {
        const bot = new Telegraf(tenant.telegramToken);
        await bot.telegram.sendMessage(chatId, message);
        console.log(`[Takeover] Sent manual Telegram reply to ${chatId}`);
      }
    } else if (sessionId.startsWith('whatsapp-')) {
      const parts = sessionId.split('-');
      const tenantId = parts[1];
      const fromNum = parts[2];
      const sqliteDb = getSqliteManager();
      const tenant = sqliteDb.getTenant(tenantId);
      if (tenant && tenant.whatsappToken) {
        // Meta Graph API send call
        await fetch(`https://graph.facebook.com/v18.0/me/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tenant.whatsappToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: fromNum,
            text: { body: message }
          })
        });
        console.log(`[Takeover] Sent manual WhatsApp reply to ${fromNum}`);
      }
    }

    return { success: true };
  });

  // Stripe Billing Webhook
  fastify.post('/api/billing/webhook', async (request: any, reply) => {
    const sqliteDb = getSqliteManager();
    const event = request.body;

    console.log(`[Stripe Webhook] Received billing event: ${event.type}`);

    try {
      if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const status = subscription.status;

        const tenants = sqliteDb.getAllTenants();
        const matchedTenant = tenants.find(t => t.stripeStatus === customerId || t.name.includes(customerId));
        if (matchedTenant) {
          matchedTenant.stripeStatus = status === 'active' || status === 'trialing' ? 'active' : 'inactive';
          sqliteDb.addTenant(matchedTenant);
          console.log(`[Stripe Billing] Updated tenant "${matchedTenant.name}" status to "${matchedTenant.stripeStatus}"`);
        }
      }
      return { received: true };
    } catch (e: any) {
      console.error('[Stripe Webhook Error]:', e);
      return reply.status(500).send({ error: e.message });
    }
  });

  // Start Server
  try {
    const address = await fastify.listen({ port: config.channels.dashboard.port, host: '0.0.0.0' });
    console.log(`[Gateway] NOVA Gateway Server started successfully at ${address}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[Gateway] Fatal error in server startup:', err);
});
