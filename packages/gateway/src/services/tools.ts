import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import nodemailer from 'nodemailer';
import { chromium } from 'playwright';
import { loadConfig } from '@nova/shared';

const execPromise = util.promisify(exec);

export interface ToolContext {
  isOwner: boolean;
  sessionId: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export const BUILT_IN_TOOLS: ToolDefinition[] = [
  {
    name: 'bash',
    description: 'Execute a terminal shell command on the host system. (Owner only)',
    parameters: {
      command: { type: 'string', description: 'The CLI command to run' }
    }
  },
  {
    name: 'file_read',
    description: 'Read the contents of a file on the local filesystem.',
    parameters: {
      filePath: { type: 'string', description: 'Absolute path to the file' }
    }
  },
  {
    name: 'file_write',
    description: 'Create or overwrite a file on the local filesystem. (Owner only)',
    parameters: {
      filePath: { type: 'string', description: 'Absolute path to write to' },
      content: { type: 'string', description: 'Text contents to write' }
    }
  },
  {
    name: 'browser',
    description: 'Open a URL in a headless browser, extract page text or screenshot. (Owner only)',
    parameters: {
      url: { type: 'string', description: 'URL to navigate to' },
      action: { type: 'string', enum: ['scrape', 'screenshot'], default: 'scrape' }
    }
  },
  {
    name: 'web_search',
    description: 'Search the web using a local search engine scraper. No API key needed.',
    parameters: {
      query: { type: 'string', description: 'Query to search for' }
    }
  },
  {
    name: 'code_exec',
    description: 'Execute JavaScript/Node.js or Python code inline and return stdout. (Owner only)',
    parameters: {
      language: { type: 'string', enum: ['javascript', 'python'] },
      code: { type: 'string', description: 'The source code code block' }
    }
  },
  {
    name: 'email_send',
    description: 'Send an email to a recipient via SMTP.',
    parameters: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject line' },
      body: { type: 'string', description: 'Email text contents' }
    }
  },
  {
    name: 'cron_create',
    description: 'Schedule a recurring background task to alert you or run a command.',
    parameters: {
      schedule: { type: 'string', description: 'Standard cron string e.g. "*/10 * * * *" (every 10m)' },
      actionDescription: { type: 'string', description: 'What to check or execute when triggered' }
    }
  },
  {
    name: 'skill_write',
    description: 'Write a new custom skill file for NOVA and hot-reload it. (Owner only)',
    parameters: {
      skillName: { type: 'string', description: 'Filename of the skill (e.g. system-monitor)' },
      markdownContent: { type: 'string', description: 'Markdown definition containing triggers, description, and logic' }
    }
  }
];

export async function executeTool(
  toolName: string,
  args: any,
  context: ToolContext
): Promise<{ success: boolean; output: string }> {
  // Security Sandbox Check
  const requiresOwner = ['bash', 'file_write', 'browser', 'code_exec', 'skill_write'];
  if (requiresOwner.includes(toolName) && !context.isOwner) {
    return {
      success: false,
      output: `Security Exception: Guest sessions cannot invoke '${toolName}'. Access Denied.`
    };
  }

  try {
    switch (toolName) {
      case 'bash': {
        const { stdout, stderr } = await execPromise(args.command);
        return {
          success: true,
          output: `Stdout:\n${stdout}\nStderr:\n${stderr}`
        };
      }

      case 'file_read': {
        const fullPath = path.resolve(args.filePath);
        if (!fs.existsSync(fullPath)) {
          return { success: false, output: `File not found: ${args.filePath}` };
        }
        const text = fs.readFileSync(fullPath, 'utf-8');
        return { success: true, output: text };
      }

      case 'file_write': {
        const fullPath = path.resolve(args.filePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, args.content, 'utf-8');
        return { success: true, output: `Successfully wrote to file ${args.filePath}` };
      }

      case 'browser': {
        let browserInstance;
        try {
          browserInstance = await chromium.launch({ headless: true });
          const page = await browserInstance.newPage();
          await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          if (args.action === 'screenshot') {
            const tempDir = path.join(loadConfig().paths.memory, 'screenshots');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const shotPath = path.join(tempDir, `${Date.now()}.png`);
            await page.screenshot({ path: shotPath });
            await browserInstance.close();
            return { success: true, output: `Screenshot saved locally at: ${shotPath}` };
          } else {
            const bodyText = await page.evaluate(() => document.body.innerText);
            await browserInstance.close();
            return { success: true, output: bodyText.substring(0, 10000) };
          }
        } catch (e: any) {
          if (browserInstance) await browserInstance.close();
          return {
            success: false,
            output: `Playwright Browser Error: ${e.message}. (Make sure to run 'npx playwright install' if binaries are missing)`
          };
        }
      }

      case 'web_search': {
        // Safe, local web search fallback using DuckDuckGo HTML scraping
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
        try {
          const response = await fetch(searchUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          });
          if (!response.ok) throw new Error(`DDG status: ${response.status}`);
          const html = await response.text();
          
          // Basic HTML regex parsing to extract titles and links
          const results: { title: string; snippet: string }[] = [];
          const linkRegex = /<a class="result__snippet"[\s\S]*?>([\s\S]*?)<\/a>/g;
          const titleRegex = /<a class="result__url"[\s\S]*?>([\s\S]*?)<\/a>/g;
          
          let m;
          while ((m = titleRegex.exec(html)) && results.length < 5) {
            const title = m[1].replace(/<[^>]*>/g, '').trim();
            results.push({ title, snippet: '' });
          }
          
          let sIdx = 0;
          while ((m = linkRegex.exec(html)) && sIdx < results.length) {
            const snippet = m[1].replace(/<[^>]*>/g, '').trim();
            results[sIdx].snippet = snippet;
            sIdx++;
          }

          if (results.length === 0) {
            return { success: true, output: `No search results found for: "${args.query}"` };
          }

          const output = results.map((r, i) => `${i + 1}. ${r.title}\n   Snippet: ${r.snippet}`).join('\n\n');
          return { success: true, output };
        } catch (err: any) {
          return { success: false, output: `Web Search Error: ${err.message}` };
        }
      }

      case 'code_exec': {
        const tempDir = path.join(loadConfig().paths.memory, 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        
        if (args.language === 'javascript') {
          const scriptPath = path.join(tempDir, `script-${Date.now()}.js`);
          fs.writeFileSync(scriptPath, args.code, 'utf-8');
          try {
            const { stdout, stderr } = await execPromise(`node "${scriptPath}"`);
            fs.unlinkSync(scriptPath);
            return { success: true, output: `Stdout:\n${stdout}\nStderr:\n${stderr}` };
          } catch (e: any) {
            if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
            return { success: false, output: `JavaScript Execution Failed: ${e.message}` };
          }
        } else if (args.language === 'python') {
          const scriptPath = path.join(tempDir, `script-${Date.now()}.py`);
          fs.writeFileSync(scriptPath, args.code, 'utf-8');
          try {
            const { stdout, stderr } = await execPromise(`python "${scriptPath}"`);
            fs.unlinkSync(scriptPath);
            return { success: true, output: `Stdout:\n${stdout}\nStderr:\n${stderr}` };
          } catch (e: any) {
            if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
            return { success: false, output: `Python Execution Failed: ${e.message}. (Ensure Python is installed and added to PATH)` };
          }
        }
        return { success: false, output: `Unsupported language: ${args.language}` };
      }

      case 'email_send': {
        // Mock / local SMTP configuration
        // In practice, parameters would be fetched from ~/.nova/nova.json SMTP config
        const testAccount = await nodemailer.createTestAccount();
        const transporter = nodemailer.createTransport({
          host: 'smtp.ethereal.email',
          port: 587,
          secure: false,
          auth: {
            user: testAccount.user,
            pass: testAccount.pass,
          },
        });

        const info = await transporter.sendMail({
          from: '"NOVA Obedient Assistant" <nova@local.assistant>',
          to: args.to,
          subject: args.subject,
          text: args.body,
        });

        const previewUrl = nodemailer.getTestMessageUrl(info);
        return {
          success: true,
          output: `Email successfully sent! MessageId: ${info.messageId}.\nPreview URL (Ethereal test mail): ${previewUrl}`
        };
      }

      case 'cron_create': {
        // We will call the Cron Service inside Gateway to register it
        const cronService = require('./cron.js').getCronService();
        cronService.scheduleTask(args.schedule, args.actionDescription);
        return {
          success: true,
          output: `Successfully scheduled background cron task: "${args.actionDescription}" on schedule "${args.schedule}"`
        };
      }

      case 'skill_write': {
        const config = loadConfig();
        const skillDir = config.paths.skills;
        if (!fs.existsSync(skillDir)) {
          fs.mkdirSync(skillDir, { recursive: true });
        }
        
        const fileName = args.skillName.toLowerCase().replace(/[^a-z0-9_-]/g, '') + '.md';
        const fullPath = path.join(skillDir, fileName);
        fs.writeFileSync(fullPath, args.markdownContent, 'utf-8');
        
        return {
          success: true,
          output: `Skill "${args.skillName}" written to ${fullPath}. Hot reload will register the new commands automatically.`
        };
      }

      default:
        return { success: false, output: `Unknown tool: ${toolName}` };
    }
  } catch (err: any) {
    return { success: false, output: `Tool Execution Error: ${err.message}` };
  }
}
