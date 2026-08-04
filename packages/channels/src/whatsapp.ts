import { loadConfig, getSqliteManager } from '@nova/shared';
import { registerOwnerHeartbeat } from './heartbeat.js';

export function startWhatsAppBot(sessionManager: any, heartbeatService: any): void {
  const config = loadConfig();
  if (!config.channels.whatsapp.enabled) {
    console.log('[WhatsApp] Channel disabled in config. Skipping WhatsApp initialization.');
    return;
  }

  console.log('[WhatsApp] Loading Baileys Client library...');

  try {
    const makeWASocket = require('@whiskeysockets/baileys').default;
    const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
    const qrcode = require('qrcode-terminal');
    const path = require('node:path');

    const authFolder = path.join(config.paths.memory, 'whatsapp-auth');

    async function connectToWhatsApp() {
      const { state, saveCreds } = await useMultiFileAuthState(authFolder);

      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Custom print to capture/log nicely
      });

      sock.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
          console.log('[WhatsApp] SCAN THIS QR CODE WITH YOUR WHATSAPP APP TO CONNECT:');
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
          const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
          console.log('[WhatsApp] Connection closed due to', lastDisconnect?.error, ', reconnecting:', shouldReconnect);
          if (shouldReconnect) {
            connectToWhatsApp();
          }
        } else if (connection === 'open') {
          console.log('[WhatsApp] Opened WhatsApp connection successfully.');
          
          // Register heartbeat listener
          registerOwnerHeartbeat(heartbeatService, 'whatsapp', 'owner_whatsapp_jid', (ownerJid, message) =>
            sock.sendMessage(ownerJid, { text: message })
          );
        }
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('messages.upsert', async (m: any) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
          if (!msg.key.fromMe && msg.message) {
            const fromJid = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

            if (text) {
              // Store sender JID as owner for heartbeat notifications
              const sqliteDb = getSqliteManager();
              sqliteDb.setFact('owner_whatsapp_jid', fromJid);

              console.log(`[WhatsApp Message from ${fromJid}]: ${text}`);

              try {
                const replyText = await sessionManager.handleUserMessage(
                  `whatsapp-${fromJid}`,
                  text,
                  true, // default to owner access for DM assistant
                  'whatsapp'
                );

                await sock.sendMessage(fromJid, { text: replyText });
              } catch (err) {
                console.error('[WhatsApp] Failed to process message:', err);
              }
            }
          }
        }
      });
    }

    connectToWhatsApp();

  } catch (err: any) {
    console.error('[WhatsApp] Failed to initialize WhatsApp adapter. Ensure peer dependencies are installed.', err.message);
  }
}
