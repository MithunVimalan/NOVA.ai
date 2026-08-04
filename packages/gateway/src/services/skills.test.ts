import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@nova/shared';
import { SkillService, getSkillService } from './skills.js';

const skillsDir = loadConfig().paths.skills;
const marker = `zz-test-skill-${Date.now()}`;
const writtenFiles: string[] = [];

function writeSkill(name: string, content: string): string {
  fs.mkdirSync(skillsDir, { recursive: true });
  const filePath = path.join(skillsDir, `${name}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  writtenFiles.push(filePath);
  return filePath;
}

const services: SkillService[] = [];
function newService(): SkillService {
  const service = new SkillService();
  services.push(service);
  return service;
}

test.after(() => {
  for (const service of services) service.close();
  for (const filePath of writtenFiles) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

test('getSkillService returns a shared singleton instance', () => {
  const service = getSkillService();
  services.push(service);
  assert.strictEqual(service, getSkillService());
});

test('Markdown skill files are discovered and parsed into description, instructions and tools', () => {
  const name = `${marker}-status`;
  writeSkill(name, [
    `# Server Status`,
    `Reports the health of the production servers.`,
    ``,
    `## Instructions`,
    `Always summarize the outage in one sentence.`,
    `Escalate to the owner when the status is critical.`,
    ``,
    `## Tools`,
    '- `fetch_status`: Fetch the current status page',
    '- `page_oncall`: Page the on-call engineer',
    `- not a tool line`,
  ].join('\n'));

  const skill = newService().getSkills().find(s => s.name === name);

  assert.ok(skill, 'The new markdown skill must be registered');
  assert.strictEqual(skill.description, 'Reports the health of the production servers.');
  assert.match(skill.instructions, /Always summarize the outage in one sentence\./);
  assert.match(skill.instructions, /Escalate to the owner when the status is critical\./);
  assert.strictEqual(skill.tools.length, 2, 'Only well-formed tool descriptors must be parsed');
  assert.deepStrictEqual(
    skill.tools.map((t: any) => t.name),
    ['fetch_status', 'page_oncall']
  );
  assert.strictEqual(skill.tools[0].description, 'Fetch the current status page');
  assert.strictEqual(skill.filePath, path.join(skillsDir, `${name}.md`));
});

test('The "prompt instructions" heading is treated as an alias of "instructions"', () => {
  const name = `${marker}-alias`;
  writeSkill(name, ['# Alias', 'A skill using the alias heading.', '', '## Prompt Instructions', 'Reply in a formal tone.'].join('\n'));

  const skill = newService().getSkills().find(s => s.name === name);

  assert.ok(skill);
  assert.strictEqual(skill.instructions, 'Reply in a formal tone.');
});

test('Non-markdown files in the skills directory are ignored', () => {
  const name = `${marker}-ignored`;
  fs.mkdirSync(skillsDir, { recursive: true });
  const txtPath = path.join(skillsDir, `${name}.txt`);
  fs.writeFileSync(txtPath, 'not a skill', 'utf-8');
  writtenFiles.push(txtPath);

  const names = newService().getSkills().map(s => s.name);
  assert.ok(!names.includes(name), 'Only .md files may be registered as skills');
});

test('getSkillPromptInjection renders every skill with its instructions and tools', () => {
  const name = `${marker}-injection`;
  writeSkill(name, [
    '# Injection',
    'Handles refund requests.',
    '',
    '## Instructions',
    'Ask for the order id first.',
    '',
    '## Tools',
    '- `lookup_order`: Find an order by id',
  ].join('\n'));

  const prompt = newService().getSkillPromptInjection();

  assert.match(prompt, new RegExp(`\\[Skill: ${name}\\]`));
  assert.match(prompt, /Description: Handles refund requests\./);
  assert.match(prompt, /Instructions: Ask for the order id first\./);
  assert.match(prompt, /- lookup_order: Find an order by id/);
});

test('Skills without tools or instructions are still injected with their description only', () => {
  const name = `${marker}-minimal`;
  writeSkill(name, ['# Minimal', 'Just a description.'].join('\n'));

  const service = newService();
  const skill = service.getSkills().find(s => s.name === name);

  assert.ok(skill);
  assert.strictEqual(skill.instructions, '');
  assert.deepStrictEqual(skill.tools, []);

  const section = service.getSkillPromptInjection().split('[Skill: ').find(s => s.startsWith(name));
  assert.ok(section);
  assert.match(section, /Description: Just a description\./);
  assert.ok(!section.includes('Available Tools'), 'A skill without tools must not advertise a tool list');
});
