import { loadConfig } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function generateChatResponse(
  messages: ChatMessage[],
  useReasoningModel: boolean = false
): Promise<string> {
  const config = loadConfig();
  const model = useReasoningModel 
    ? config.modelRouting.reasoning 
    : config.modelRouting.fast;
  
  const url = `${config.ollamaUrl}/api/chat`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: false,
        options: {
          temperature: useReasoningModel ? 0.2 : 0.7,
        }
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { message?: { content: string } };
    if (data.message && data.message.content) {
      return data.message.content;
    }
    
    throw new Error('Invalid response structure from Ollama');
  } catch (err: any) {
    console.error(`[LLM Router] Failed to connect to Ollama (Model: ${model}):`, err.message);
    
    // Highly informative fallback message for local testing when Ollama is offline
    return `[NOVA LLM Fallback Mode] I attempted to call local Ollama at ${config.ollamaUrl} using the model "${model}". 
It seems Ollama is currently offline or the model is not pulled yet. 

To resolve this:
1. Ensure Ollama is running (execute 'ollama serve' in your terminal).
2. Pull the model if not already present: 'ollama pull ${model}'.
3. (Optional) Customize the models or URL in your config file at ~/.nova/nova.json.

Original Error: ${err.message}`;
  }
}
