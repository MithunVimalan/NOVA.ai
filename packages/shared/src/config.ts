import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { ensureDir, readJsonFile } from './utils/fs.js';

export const ConfigSchema = z.object({
  ollamaUrl: z.string().default('http://localhost:11434'),
  modelRouting: z.object({
    fast: z.string().default('phi3:mini'),
    reasoning: z.string().default('qwen3:8b'),
  }).default({}),
  channels: z.object({
    telegram: z.object({
      enabled: z.boolean().default(false),
      token: z.string().default(''),
    }).default({}),
    whatsapp: z.object({
      enabled: z.boolean().default(false),
    }).default({}),
    dashboard: z.object({
      enabled: z.boolean().default(true),
      port: z.number().default(3000),
    }).default({}),
    widget: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
  }).default({}),
  paths: z.object({
    memory: z.string().default(''),
    skills: z.string().default(''),
  }).default({}),
  voice: z.object({
    sttProvider: z.enum(['local', 'deepgram']).default('local'),
    ttsProvider: z.enum(['local', 'elevenlabs']).default('local'),
    deepgramApiKey: z.string().default(''),
    elevenlabsApiKey: z.string().default(''),
    elevenlabsVoiceId: z.string().default('21m00Tcm4TlvDq8ikWAM'),
    piperPath: z.string().default('piper'),
    piperModelPath: z.string().default(''),
    whisperPath: z.string().default('whisper'),
  }).default({}),
});

export type NovaConfig = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.nova');
const CONFIG_FILE_PATH = path.join(DEFAULT_CONFIG_DIR, 'nova.json');

export function getNovaHomeDir(): string {
  return ensureDir(DEFAULT_CONFIG_DIR);
}

export function loadConfig(): NovaConfig {
  const homeDir = getNovaHomeDir();
  const fileConfig = readJsonFile<any>(CONFIG_FILE_PATH, {}, '[Config]');

  // Parse and resolve defaults
  const parsed = ConfigSchema.parse(fileConfig);

  // Set default paths if empty
  if (!parsed.paths.memory) {
    parsed.paths.memory = path.join(homeDir, 'memory');
  }
  if (!parsed.paths.skills) {
    parsed.paths.skills = path.join(homeDir, 'workspace', 'skills');
  }

  // Save resolved config back if it was missing or modified
  saveConfig(parsed);

  return parsed;
}

export function saveConfig(config: NovaConfig): void {
  getNovaHomeDir();
  try {
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error(`[Config] Failed to save config to ${CONFIG_FILE_PATH}`, e);
  }
}
