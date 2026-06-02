import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { loadConfig } from '@nova/shared';

export interface CustomSkill {
  name: string;
  filePath: string;
  description: string;
  instructions: string;
  tools: any[];
}

export class SkillService {
  private skillsDir: string;
  private skills: Map<string, CustomSkill> = new Map();
  private watcher: any = null;

  constructor() {
    const config = loadConfig();
    this.skillsDir = config.paths.skills;

    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }

    this.loadAllSkills();
    this.setupWatcher();
  }

  private loadAllSkills() {
    console.log(`[Skills] Loading skills from directory: ${this.skillsDir}`);
    try {
      const files = fs.readdirSync(this.skillsDir);
      this.skills.clear();
      
      for (const file of files) {
        if (file.endsWith('.md')) {
          this.loadSkillFile(path.join(this.skillsDir, file));
        }
      }
      console.log(`[Skills] Loaded ${this.skills.size} custom skills successfully.`);
    } catch (e) {
      console.error(`[Skills] Error reading skills directory:`, e);
    }
  }

  private loadSkillFile(filePath: string) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const filename = path.basename(filePath);
      const skillName = filename.replace('.md', '');
      
      const parsed = this.parseSkillMarkdown(skillName, content, filePath);
      this.skills.set(skillName, parsed);
      console.log(`[Skills] Registered/Updated skill: "${skillName}"`);
    } catch (err) {
      console.error(`[Skills] Failed to load skill file ${filePath}:`, err);
    }
  }

  private parseSkillMarkdown(name: string, content: string, filePath: string): CustomSkill {
    // Basic Markdown Parser
    // Find sections like Description, Tools, Prompt Instructions
    const lines = content.split('\n');
    let description = '';
    let instructions = '';
    let currentSection = '';
    
    // Default parsed values
    const tools: any[] = [];

    for (const line of lines) {
      if (line.startsWith('# ')) {
        continue;
      }
      if (line.startsWith('## ')) {
        currentSection = line.replace('## ', '').trim().toLowerCase();
        continue;
      }

      if (currentSection === '') {
        description += line + '\n';
      } else if (currentSection === 'instructions' || currentSection === 'prompt instructions') {
        instructions += line + '\n';
      } else if (currentSection === 'tools') {
        // Parse tool descriptors.
        // Example: - `fetch_status`: description of fetching status
        const toolMatch = line.match(/^-\s*`([^`]+)`\s*:\s*(.*)/);
        if (toolMatch) {
          tools.push({
            name: toolMatch[1].trim(),
            description: toolMatch[2].trim(),
            parameters: {} // simple dynamic parameters
          });
        }
      }
    }

    return {
      name,
      filePath,
      description: description.trim(),
      instructions: instructions.trim(),
      tools,
    };
  }

  private setupWatcher() {
    try {
      this.watcher = chokidar.watch(this.skillsDir, { ignoreInitial: true });
      
      this.watcher.on('add', (filePath: string) => {
        if (filePath.endsWith('.md')) {
          console.log(`[Skills] New skill file detected: ${filePath}`);
          this.loadSkillFile(filePath);
        }
      });

      this.watcher.on('change', (filePath: string) => {
        if (filePath.endsWith('.md')) {
          console.log(`[Skills] Skill file changed: ${filePath}`);
          this.loadSkillFile(filePath);
        }
      });

      this.watcher.on('unlink', (filePath: string) => {
        const filename = path.basename(filePath);
        const skillName = filename.replace('.md', '');
        if (this.skills.delete(skillName)) {
          console.log(`[Skills] Removed skill: "${skillName}"`);
        }
      });
    } catch (e) {
      console.warn(`[Skills] Chokidar filesystem watcher failed, hot reload disabled:`, e);
    }
  }

  public getSkills(): CustomSkill[] {
    return Array.from(this.skills.values());
  }

  public getSkillPromptInjection(): string {
    let prompt = '';
    for (const [name, skill] of this.skills.entries()) {
      prompt += `\n[Skill: ${name}]\nDescription: ${skill.description}\n`;
      if (skill.instructions) {
        prompt += `Instructions: ${skill.instructions}\n`;
      }
      if (skill.tools.length > 0) {
        prompt += `Available Tools:\n`;
        for (const tool of skill.tools) {
          prompt += ` - ${tool.name}: ${tool.description}\n`;
        }
      }
    }
    return prompt;
  }

  public close() {
    if (this.watcher) {
      this.watcher.close();
    }
  }
}

// Single instance export
let skillServiceInstance: SkillService | null = null;
export function getSkillService(): SkillService {
  if (!skillServiceInstance) {
    skillServiceInstance = new SkillService();
  }
  return skillServiceInstance;
}
