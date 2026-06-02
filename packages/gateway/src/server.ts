import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
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
