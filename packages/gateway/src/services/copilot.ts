import fs from 'node:fs';
import path from 'node:path';
import { executeTool } from './tools.js';
import { getVectorDbManager } from '@nova/shared';

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
      const actionId = 'act-' + Math.random().toString(36).substring(2, 9) + '-' + Date.now();
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

    const traverseDir = async (currentDir: string) => {
      const items = fs.readdirSync(currentDir);
      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          // Skip node_modules and .git folders
          if (item === 'node_modules' || item === '.git' || item === 'dist') continue;
          await traverseDir(fullPath);
        } else if (stat.isFile()) {
          const ext = path.extname(item).toLowerCase();
          // Filter plain-text extensions
          if (['.txt', '.md', '.json', '.csv', '.html', '.js', '.ts'].includes(ext)) {
            try {
              const text = fs.readFileSync(fullPath, 'utf-8');
              if (text.trim()) {
                const relPath = path.relative(folderPath, fullPath);
                await vectorDb.addCatalogDoc(text, { source: relPath });
                count++;
              }
            } catch (err: any) {
              console.warn(`[Copilot Scanner] Failed to read ${fullPath}:`, err.message);
            }
          }
        }
      }
    };

    if (fs.existsSync(folderPath)) {
      await traverseDir(folderPath);
    }

    return {
      filesIndexed: count,
      durationMs: Date.now() - startTime,
    };
  }
}

let copilotServiceInstance: CopilotService | null = null;
export function getCopilotService(): CopilotService {
  if (!copilotServiceInstance) {
    copilotServiceInstance = new CopilotService();
  }
  return copilotServiceInstance;
}
