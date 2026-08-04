import fs from 'node:fs';
import path from 'node:path';
import { executeTool } from './tools.js';
import { generateId, getVectorDbManager, createSingleton, walkFiles } from '@nova/shared';

export interface PendingAction {
  id: string;
  tool: string;
  args: any;
  createdAt: number;
}

export interface ActionResult {
  status: 'PENDING_CONFIRMATION' | 'EXECUTED' | 'FAILED';
  actionId?: string;
  output?: string;
}

export class CopilotService {
  private pendingActions: Map<string, PendingAction[]> = new Map();
  private criticalTools = ['bash', 'file_write', 'skill_write'];

  /**
   * Request execution of a tool. Intercepts critical tools for user approval.
   */
  async requestActionExecution(sessionId: string, tool: string, args: any): Promise<ActionResult> {
    if (this.criticalTools.includes(tool)) {
      const actionId = generateId('act', 7);
      const actions = this.pendingActions.get(sessionId) || [];
      
      const newAction: PendingAction = {
        id: actionId,
        tool,
        args,
        createdAt: Date.now(),
      };
      
      actions.push(newAction);
      this.pendingActions.set(sessionId, actions);

      return {
        status: 'PENDING_CONFIRMATION',
        actionId,
        output: `Action '${tool}' requires owner confirmation before running.`
      };
    }

    // Direct execution for non-critical tools
    console.log(`[Copilot] Directly executing non-critical tool: ${tool}`);
    const res = await executeTool(tool, args, { isOwner: true, sessionId });
    return {
      status: res.success ? 'EXECUTED' : 'FAILED',
      output: res.output,
    };
  }

  /**
   * Executes a pending action if approved, or discards it.
   */
  async executePendingAction(
    sessionId: string,
    actionId: string,
    approved: boolean
  ): Promise<{ success: boolean; output: string }> {
    const actions = this.pendingActions.get(sessionId) || [];
    const idx = actions.findIndex(a => a.id === actionId);

    if (idx === -1) {
      return { success: false, output: `Action ID ${actionId} not found under session ${sessionId}` };
    }

    const [action] = actions.splice(idx, 1);
    this.pendingActions.set(sessionId, actions);

    if (!approved) {
      return { success: false, output: 'Action was rejected by user.' };
    }

    console.log(`[Copilot] Executing approved action: ${action.tool}`);
    const res = await executeTool(action.tool, action.args, { isOwner: true, sessionId });
    return {
      success: res.success,
      output: res.output,
    };
  }

  /**
   * Clear pending actions list
   */
  clearPendingActions(sessionId: string): void {
    this.pendingActions.delete(sessionId);
  }

  /**
   * Recursively crawls a directory, extracts text, and indexes contents to LanceDB
   */
  async scanLocalFolder(folderPath: string): Promise<{ filesIndexed: number; durationMs: number }> {
    const startTime = Date.now();
    const vectorDb = getVectorDbManager();
    let count = 0;

    const textExtensions = ['.txt', '.md', '.json', '.csv', '.html', '.js', '.ts'];
    for (const filePath of walkFiles(folderPath, { extensions: textExtensions })) {
      try {
        const text = fs.readFileSync(filePath, 'utf-8');
        if (text.trim()) {
          await vectorDb.addCatalogDoc(text, { source: path.relative(folderPath, filePath) });
          count++;
        }
      } catch (err: any) {
        console.warn(`[Copilot Scanner] Failed to read ${filePath}:`, err.message);
      }
    }

    return {
      filesIndexed: count,
      durationMs: Date.now() - startTime,
    };
  }
}

export const getCopilotService = createSingleton(() => new CopilotService());
