import { Telegraf } from 'telegraf';
import { loadConfig, getSqliteManager } from '@nova/shared';
import { registerOwnerHeartbeat } from './heartbeat.js';

let botInstance: Telegraf | null = null;

export function startTelegramBot(sessionManager: any, heartbeatService: any): void {
  const config = loadConfig();
  if (!config.channels.telegram.enabled || !config.channels.telegram.token) {
    console.log('[Telegram] Channel disabled or missing bot token. Skipping startup.');
    return;
  }

  const token = config.channels.telegram.token;
  console.log('[Telegram] Initializing bot client...');

  try {
    const bot = new Telegraf(token);
    botInstance = bot;

    // Command: /start
    bot.start((ctx) => {
      const chatId = ctx.chat.id.toString();
      const sqliteDb = getSqliteManager();
      
      // Register this chat ID as the owner telegram handle
      sqliteDb.setFact('owner_telegram_chat_id', chatId);
      
      ctx.reply(`Welcome Owner to NOVA! 🚀\nYour Chat ID (${chatId}) has been registered to receive heartbeat notifications and cron updates.`);
    });

    // Command: /clear
    bot.command('clear', (ctx) => {
      const chatId = ctx.chat.id.toString();
      sessionManager.clearSession(`telegram-${chatId}`);
      ctx.reply('Conversation history cleared.');
    });

    // Inbound Message Handler
    bot.on('text', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const messageText = ctx.message.text;

      // Show typing status while thinking
      ctx.sendChatAction('typing');

      try {
        const replyText = await sessionManager.handleUserMessage(
          `telegram-${chatId}`,
          messageText,
          true, // Defaulting to owner access since this is personal DM
          'telegram'
        );
        ctx.reply(replyText);
      } catch (err: any) {
        console.error(`[Telegram] Error handling text message:`, err);
        ctx.reply(`Sorry, I encountered an error: ${err.message}`);
      }
    });

    bot.launch();
    console.log('[Telegram] Bot started and polling successfully.');

    // Register to heartbeat service to dispatch proactive messages
    registerOwnerHeartbeat(heartbeatService, 'telegram', 'owner_telegram_chat_id', (chatId, message) =>
      bot.telegram.sendMessage(chatId, message)
    );

    // Handle graceful shutdowns
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

  } catch (err) {
    console.error('[Telegram] Failed to launch bot client:', err);
  }
}
