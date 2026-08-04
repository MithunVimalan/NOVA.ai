import { 
  generateChatResponse, 
  getSqliteManager, 
  getVectorDbManager, 
  ChatMessage,
  createSingleton
} from '@nova/shared';
import { executeTool, BUILT_IN_TOOLS, ToolContext } from './tools.js';
import { getSkillService } from './skills.js';
import { getHeartbeatService } from './heartbeat.js';

export interface SessionState {
  sessionId: string;
  isOwner: boolean;
  history: ChatMessage[];
}

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();

  public getOrCreateSession(sessionId: string, isOwner: boolean = false): SessionState {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        isOwner,
        history: [],
      });
    }
    return this.sessions.get(sessionId)!;
  }

  public getSessionHistory(sessionId: string): ChatMessage[] {
    return this.getOrCreateSession(sessionId).history;
  }

  public clearSession(sessionId: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.history = [];
  }

  public async handleUserMessage(
    sessionId: string,
    messageText: string,
    isOwner: boolean = false,
    channelType: 'telegram' | 'whatsapp' | 'web' | 'widget' | 'voice' | 'instagram' = 'web'
  ): Promise<string> {
    const session = this.getOrCreateSession(sessionId, isOwner);

    // Escalation Keyword Guardrails (Guest messages only)
    if (!isOwner) {
      const lowerMsg = messageText.toLowerCase();
      const escalationKeywords = ['human', 'support', 'billing issue', 'chargeback', 'refund', 'representative', 'agent', 'speak to a real'];
      const shouldEscalate = escalationKeywords.some(keyword => lowerMsg.includes(keyword));

      if (shouldEscalate) {
        (session as any).isManualTakeover = true;
        session.history.push({ role: 'user', content: messageText });

        // Dispatch FCM Push Alert & Heartbeat notifications
        const tenantId = sessionId.split('-')[1] || 'default';
        const sqliteDb = getSqliteManager();
        const fcmToken = sqliteDb.getFact(`fcm_token_${tenantId}`);
        if (fcmToken) {
          console.log(`[FCM Push Alert] Sent to ${fcmToken} for session ${sessionId}`);
        }

        const heartbeatService = getHeartbeatService();
        heartbeatService.notifyOwner(
          `[NOVA Takeover Alert] Session "${sessionId}" escalated to manual takeover on "${channelType}": "${messageText}"`
        );

        return "I have activated manual takeover mode. A human representative has been notified and will respond to you shortly.";
      }
    }
    
    // Check if session is in manual takeover mode (and message is from a Guest)
    if ((session as any).isManualTakeover && !isOwner) {
      session.history.push({ role: 'user', content: messageText });
      
      // Dispatch alert to owner
      const heartbeatService = getHeartbeatService();
      heartbeatService.notifyOwner(
        `[NOVA Takeover Alert] Session "${sessionId}" on "${channelType}" sent: "${messageText}".`
      );
      
      return "A representative has been notified and will respond to you shortly.";
    }

    const sqliteDb = getSqliteManager();
    const vectorDb = getVectorDbManager();
    const skillService = getSkillService();

    // 1. Fetch episodic context (past memories)
    const episodicMemories = await vectorDb.searchEpisodicMemory(messageText, 3);
    const memoryString = episodicMemories.length > 0 
      ? episodicMemories.map(m => `- ${m.text || m.metadata?.userMessage}`).join('\n')
      : 'No relevant memories found.';

    // 2. Fetch business RAG catalog context (for widget customer bots)
    let catalogString = '';
    if (channelType === 'widget' || channelType === 'whatsapp' || channelType === 'telegram' || channelType === 'voice' || channelType === 'instagram') {
      const catalogMatches = await vectorDb.searchCatalog(messageText, 3);
      if (catalogMatches.length > 0) {
        catalogString = `Relevant Business Documents & Catalog Context:\n` +
          catalogMatches.map(c => `- ${c.text}`).join('\n');
      }
    }

    // 3. Fetch SQLite facts (user preferences)
    const facts = sqliteDb.getAllFacts();
    const factsString = Object.keys(facts).length > 0
      ? Object.entries(facts).map(([k, v]) => `- ${k}: ${v}`).join('\n')
      : 'No factual profile established yet.';

    // 4. Load dynamic hot-loaded skills prompt injections
    const skillsInjections = skillService.getSkillPromptInjection();

    // Assemble the tools listing for system prompt
    const toolsList = BUILT_IN_TOOLS
      .filter(t => isOwner || !['bash', 'file_write', 'browser', 'code_exec', 'skill_write'].includes(t.name))
      .map(t => `- ${t.name}: ${t.description} params: ${JSON.stringify(t.parameters)}`)
      .join('\n');

    // 5. Construct System Prompt
    const systemPrompt = `You are NOVA (Next-gen Obedient Virtual Assistant), created by Mithunvimalan SA.
Tagline: Does whatever you say. On every device. No API key. No cloud. Fully yours.
Pricing: $7 USD/month per client.
Core Promise: Run commands, edit files, schedule crons, answer questions locally.

You are interacting on channel: ${channelType} (Session ID: ${sessionId}).
User Authority Level: ${isOwner ? 'OWNER (Full Access)' : 'GUEST/CUSTOMER (Sandboxed)'}.

ESTABLISHED FACTS ABOUT OWNER:
${factsString}

PAST EPISODIC MEMORIES:
${memoryString}

${catalogString}

DYNAMIC SKILLS & CUSTOM TRIGGERS LOADED:
${skillsInjections}

AVAILABLE TOOLS YOU CAN CALL:
${toolsList}

CRITICAL TOOL CALLING FORMAT:
If you need to run a tool, you MUST output a single line in this exact format:
Action: {"tool": "tool_name", "args": {"param1": "value1"}}

Once the tool is executed, you will receive:
Observation: [Tool Output]

You can think out loud before invoking a tool by starting with "Thought: ".
If you do not need to call any more tools, or to reply to the user, output your final answer directly.
Never call bash, file_write, or browser tools if you are in GUEST/CUSTOMER mode.
`;

    // 6. Push user message to short-term history (keep last 20 turns)
    session.history.push({ role: 'user', content: messageText });
    if (session.history.length > 40) { // 20 turns = 40 messages
      session.history = session.history.slice(-40);
    }

    // 7. Run Agent loop (Max 5 turns)
    let loopCount = 0;
    const maxLoops = 5;
    let assistantReply = '';

    while (loopCount < maxLoops) {
      loopCount++;
      
      // Compile messages list including system prompt
      const llmInput: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...session.history
      ];

      // Use reasoning model if user is owner and it looks complex, or default to fast
      const isComplex = messageText.includes('build') || messageText.includes('run') || messageText.includes('install') || messageText.includes('search');
      const response = await generateChatResponse(llmInput, isOwner && isComplex);
      
      // Parse response for tool calls
      const toolCallMatch = response.match(/Action:\s*(\{.*\})/);
      
      if (toolCallMatch) {
        let actionObj: any = null;
        try {
          actionObj = JSON.parse(toolCallMatch[1]);
        } catch {
          // Retry parse with regex if formatting was slightly off
          console.warn(`[Agent] Failed to parse action JSON:`, toolCallMatch[1]);
        }

        if (actionObj && actionObj.tool) {
          console.log(`[Agent Session ${sessionId}] Calling Tool: ${actionObj.tool} with args:`, actionObj.args);
          
          // Execute the tool
          const toolContext: ToolContext = { isOwner, sessionId };
          const toolResult = await executeTool(actionObj.tool, actionObj.args || {}, toolContext);
          
          // Log tool turn in history
          session.history.push({ role: 'assistant', content: response });
          session.history.push({ role: 'user', content: `Observation: ${toolResult.output}` });
          
          continue; // Send back to LLM for next turn
        }
      }

      // No tool calls, this is the final response
      assistantReply = response;
      break;
    }

    if (loopCount >= maxLoops) {
      assistantReply = `Agent exceeded maximum reasoning loop iterations. Last response:\n${assistantReply}`;
    }

    // Clean up observation steps from short-term memory window so history stays clean for next turn
    session.history = session.history.filter(m => !m.content.startsWith('Observation:'));
    
    // Add final assistant message
    session.history.push({ role: 'assistant', content: assistantReply });

    // 8. Commit conversation turn to Long Term Episodic Memory (in background)
    vectorDb.addEpisodicMemory(sessionId, messageText, assistantReply).catch(err => {
      console.error(`[Session Manager] Failed to write episodic memory:`, err);
    });

    return assistantReply;
  }
}

// Single instance export
export const getSessionManager = createSingleton(() => new SessionManager());
