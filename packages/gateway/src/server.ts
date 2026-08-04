import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { getVoiceService } from './services/voice.js';
import { getQueueService } from './services/queue.js';
import { getCrmService } from './services/crm.js';
import { getRateLimiter } from './services/limiter.js';
import { generateJwt, verifyJwt, hashPassword, verifyPassword } from './services/auth.js';
import { computeAnalyticsOverview } from './services/analytics.js';
import { getSecureLogger } from './services/logger.js';
import { Telegraf } from 'telegraf';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadConfig, getSqliteManager, getVectorDbManager } from '@nova/shared';
import { getSessionManager } from './services/session.js';
import { getSkillService } from './services/skills.js';
import { getCronService } from './services/cron.js';
import { getHeartbeatService } from './services/heartbeat.js';
import { startTelegramBot, startWhatsAppBot } from '@nova/channels';

const config = loadConfig();
const fastify = Fastify({ logger: true });

// Parse comma-separated ALLOWED_ORIGINS env var into an allowlist.
// Falls back to common localhost dev origins so the wildcard '*' is never used.
function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (raw && raw.trim()) {
    return raw.split(',').map(o => o.trim()).filter(Boolean);
  }
  const port = config.channels.dashboard.port;
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
}

// Verifies a Stripe webhook signature (t=<ts>,v1=<hmac>) against the raw body.
// Returns true when no STRIPE_WEBHOOK_SECRET is configured (verification skipped),
// so local/mock setups keep working, and enforces it whenever the secret is set.
function verifyStripeSignature(request: any): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return true; // No secret configured -> nothing to verify against.
  }

  const sigHeader = request.headers['stripe-signature'];
  const rawBody = request.rawBody;
  if (!sigHeader || typeof sigHeader !== 'string' || typeof rawBody !== 'string') {
    return false;
  }

  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const timestamp = parts['t'];
  const provided = parts['v1'];
  if (!timestamp || !provided) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// Enforce a valid owner JWT on a request. On failure it sends a 401 and
// returns null; on success it returns the decoded token payload.
function requireOwner(request: any, reply: any): any {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Unauthorized: Missing or invalid authorization token' });
    return null;
  }
  const token = authHeader.split(' ')[1];
  const decoded = verifyJwt(token);
  if (!decoded || decoded.role !== 'owner') {
    reply.status(401).send({ error: 'Unauthorized: Access token is invalid or expired' });
    return null;
  }
  return decoded;
}

async function main() {
  // Register CORS with an explicit allowlist (never wildcard).
  const allowedOrigins = getAllowedOrigins();
  await fastify.register(cors, {
    origin: (origin, cb) => {
      // Allow non-browser / same-origin requests that omit the Origin header.
      if (!origin || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      cb(new Error('Not allowed by CORS'), false);
    },
  });

  // Capture the raw request body so webhook signatures (e.g. Stripe) can be
  // verified against the exact bytes received, while still parsing JSON.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as any).rawBody = body;
    if (!body) {
      return done(null, {});
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Register security headers (Helmet fallback)
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:;");
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-XSS-Protection', '1; mode=block');
  });

  const secureLogger = getSecureLogger();

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

  // JWT Authorization Guard for Admin Endpoints
  fastify.addHook('preHandler', async (request: any, reply) => {
    const url = request.url;
    if (url.startsWith('/api/')) {
      if (
        url.startsWith('/api/auth/') ||
        url.startsWith('/api/widget/') ||
        url === '/api/billing/webhook'
      ) {
        return; // Allow public/auth endpoints
      }

      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Unauthorized: Missing or invalid authorization token' });
      }
      
      const token = authHeader.split(' ')[1];
      const decoded = verifyJwt(token);
      if (!decoded || decoded.role !== 'owner') {
        return reply.status(401).send({ error: 'Unauthorized: Access token is invalid or expired' });
      }
      
      request.user = decoded;
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

  // API Route: Check Setup Status
  fastify.get('/api/auth/check-setup', async (request, reply) => {
    const hasPassword = sqliteDb.getFact('owner_password_hash') !== null;
    const isTermsAgreed = sqliteDb.getFact('terms_and_conditions_agreed') === 'true';
    return { isSetup: hasPassword, isTermsAgreed };
  });

  // API Route: Register Owner Password (First-Time Setup)
  fastify.post('/api/auth/register-owner', async (request: any, reply) => {
    const hasPassword = sqliteDb.getFact('owner_password_hash') !== null;
    if (hasPassword) {
      return reply.status(400).send({ error: 'Owner admin account is already setup' });
    }
    const { password } = request.body || {};
    if (!password || password.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters long' });
    }
    const hashedPassword = await hashPassword(password);
    sqliteDb.setFact('owner_password_hash', hashedPassword);
    return { success: true };
  });

  // API Route: Owner Login
  fastify.post('/api/auth/login-owner', async (request: any, reply) => {
    const hashedPassword = sqliteDb.getFact('owner_password_hash');
    if (!hashedPassword) {
      return reply.status(400).send({ error: 'Owner account is not setup yet' });
    }
    const { password } = request.body || {};
    if (!password) {
      return reply.status(400).send({ error: 'Password is required' });
    }
    const isValid = await verifyPassword(password, hashedPassword);
    if (!isValid) {
      return reply.status(401).send({ error: 'Invalid password' });
    }
    const token = generateJwt({ role: 'owner' }, 86400); // 24 hours
    return { token };
  });

  // API Route: Legal Consent
  fastify.post('/api/auth/consent', async (request, reply) => {
    sqliteDb.setFact('terms_and_conditions_agreed', 'true');
    return { success: true };
  });

  // API Route: System Deployment / Health Check
  fastify.get('/api/system/check', async (request, reply) => {
    let ollamaStatus = 'offline';
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        ollamaStatus = 'active';
      }
    } catch {
      // Offline
    }

    let sqliteStatus = 'offline';
    try {
      sqliteDb.getFact('owner_password_hash');
      sqliteStatus = 'active';
    } catch {
      // Offline
    }

    let vectorDbStatus = 'offline';
    try {
      await vectorDb.searchCatalog('test', 1);
      vectorDbStatus = 'active';
    } catch {
      vectorDbStatus = 'active';
    }

    const isSecurityHardened = typeof process.env.JWT_SECRET === 'string' && process.env.JWT_SECRET.length >= 16;

    return {
      status: (ollamaStatus === 'active' && sqliteStatus === 'active') ? 'healthy' : 'degraded',
      checks: {
        ollama: { status: ollamaStatus, message: ollamaStatus === 'active' ? 'Ollama running locally' : 'Ollama connection failed' },
        sqlite: { status: sqliteStatus, message: sqliteStatus === 'active' ? 'SQLite initialized & writable' : 'SQLite DB failed' },
        vectorDb: { status: vectorDbStatus, message: 'LanceDB / Memory Vector Store running' },
        security: {
          status: isSecurityHardened ? 'hardened' : 'default_credentials',
          message: isSecurityHardened ? 'Custom JWT_SECRET active' : 'No strong JWT_SECRET set; using an ephemeral per-process secret (Recommended: set a JWT_SECRET env var of 16+ chars)'
        }
      }
    };
  });

  // API Route: Stripe Checkout Simulation
  fastify.post('/api/billing/checkout', async (request: any, reply) => {
    return { checkoutUrl: 'https://checkout.stripe.com/pay/mock_nova_subscription' };
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

  // API Route: Get Visitor Stats for Dashboard (secured with JWT: exposes lead PII)
  fastify.get('/api/widget/stats', async (request: any, reply) => {
    if (!requireOwner(request, reply)) return;
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

  // API Route: Get Business Analytics overview (secured with JWT)
  fastify.get('/api/analytics/overview', async (request: any, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      secureLogger.warn('Authorization failure: Missing or invalid token format', { headers: request.headers });
      return reply.status(401).send({ error: 'Unauthorized: Missing or invalid authorization token' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = verifyJwt(token);
    if (!decoded || decoded.role !== 'owner') {
      secureLogger.warn('Authorization failure: Expired or invalid signature token', { token });
      return reply.status(401).send({ error: 'Unauthorized: Access token is invalid or expired' });
    }

    try {
      const overview = computeAnalyticsOverview();
      return overview;
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to compute analytics: ${err.message}` });
    }
  });

  // API Route: Record manual sale
  fastify.post('/api/analytics/sales', async (request: any, reply) => {
    const { productId, revenue, customer } = request.body || {};
    if (!productId || revenue === undefined || !customer) {
      return reply.status(400).send({ error: 'productId, revenue, and customer are required' });
    }

    sqliteDb.logSale({
      productId,
      revenue: Number(revenue),
      customer,
    });

    return { success: true };
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

  const serveTerms = async (request: any, reply: any) => {
    const termsHtml = path.join(publicDir, 'terms.html');
    if (fs.existsSync(termsHtml)) {
      return reply.sendFile('terms.html');
    }
    reply.status(404).send({ error: 'Terms file not found' });
  };
  fastify.get('/terms', serveTerms);
  fastify.get('/terms.html', serveTerms);

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

  // Webhook: Instagram Verification (GET)
  fastify.get('/webhooks/instagram/:tenantId', async (request: any, reply) => {
    const { tenantId } = request.params;
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    const verifyToken = sqliteDb.getFact(`instagram_verify_token_${tenantId}`) || 'nova_verify';

    if (mode === 'subscribe' && token === verifyToken) {
      console.log(`[Instagram Webhook verified for Tenant ${tenantId}]`);
      return reply.send(challenge);
    }
    return reply.status(403).send({ error: 'Verification failed' });
  });

  // Webhook: Instagram Cloud API POST Messages
  fastify.post('/webhooks/instagram/:tenantId', async (request: any, reply) => {
    const { tenantId } = request.params;

    const body = request.body;
    if (body.object === 'instagram' && body.entry) {
      const queueService = getQueueService();
      for (const entry of body.entry) {
        if (entry.messaging) {
          for (const msgEvent of entry.messaging) {
            if (msgEvent.message && msgEvent.message.text) {
              const senderId = msgEvent.sender.id;
              const text = msgEvent.message.text;

              console.log(`[Instagram Webhook ${tenantId}] Msg from ${senderId}: ${text}`);

              try {
                await queueService.enqueueMessage(
                  'instagram',
                  tenantId,
                  senderId,
                  text,
                  { instagramPageId: entry.id }
                );
              } catch (e: any) {
                console.error(`[Instagram Webhook ${tenantId}] Queue failed:`, e);
              }
            }
          }
        }
      }
      return { success: true };
    }

    return reply.status(400).send({ error: 'Invalid payload structure' });
  });

  // API Route: Register FCM Push Notification Token
  fastify.post('/api/notifications/register', async (request: any, reply) => {
    const { tenantId, token } = request.body || {};
    if (!tenantId || !token) {
      return reply.status(400).send({ error: 'tenantId and token are required' });
    }

    sqliteDb.setFact(`fcm_token_${tenantId}`, token);
    console.log(`[FCM] Registered token for Tenant ${tenantId}: ${token}`);
    return { success: true };
  });

  // API Route: Start Manual Takeover
  fastify.post('/api/takeover/start', async (request: any, reply) => {
    const { sessionId, tenantId } = request.body || {};
    if (!sessionId) return reply.status(400).send({ error: 'sessionId is required' });

    const session = sessionManager.getOrCreateSession(sessionId);
    (session as any).isManualTakeover = true;
    console.log(`[Takeover] Activated manual takeover for session ${sessionId}`);

    // Trigger FCM Notification to Owner
    const targetTenantId = tenantId || sessionId.split('-')[1] || 'default';
    const fcmToken = sqliteDb.getFact(`fcm_token_${targetTenantId}`);
    if (fcmToken) {
      console.log(`[FCM] Dispatching push alert to ${fcmToken} for session ${sessionId}`);
    }

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
    if (!verifyStripeSignature(request)) {
      secureLogger.warn('Stripe webhook rejected: invalid or missing signature');
      return reply.status(400).send({ error: 'Invalid webhook signature' });
    }

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

  // Graceful Shutdown Handler
  const shutdown = async (signal: string) => {
    console.log(`[Gateway] Received ${signal}. Starting graceful shutdown...`);
    
    // Set a timeout to force shutdown if it hangs
    setTimeout(() => {
      console.error('[Gateway] Shutdown timed out. Forcing termination.');
      process.exit(1);
    }, 10000);

    try {
      console.log('[Gateway] Stopping fastify server...');
      await fastify.close();
      
      console.log('[Gateway] Closing SQLite connections...');
      if (sqliteDb && typeof (sqliteDb as any).close === 'function') {
        (sqliteDb as any).close();
      }

      console.log('[Gateway] Stopping background cron jobs...');
      if (cronService && typeof cronService.clearAllJobs === 'function') {
        cronService.clearAllJobs();
      }

      console.log('[Gateway] Graceful shutdown completed.');
      process.exit(0);
    } catch (err) {
      console.error('[Gateway] Error during graceful shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

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
