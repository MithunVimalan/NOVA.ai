#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, getNovaHomeDir, NovaConfig } from '@nova/shared';

const program = new Command();

program
  .name('nova')
  .description('NOVA — Next-gen Obedient Virtual Assistant CLI Controller')
  .version('1.0.0');

// COMMAND: onboard
program
  .command('onboard')
  .description('Interactive guided setup for settings, channels, and background daemon')
  .option('--install-daemon', 'Automatically configure and launch background runner')
  .action(async (options) => {
    console.log(`
███╗   ██╗ ██████╗ ██╗   ██╗ █████╗ 
████╗  ██║██╔═══██╗██║   ██║██╔══██╗
██╔██╗ ██║██║   ██║██║   ██║███████║
██║╚████║██║   ██║╚██╗ ██╔╝██╔══██║
██║ ╚███║╚██████╔╝ ╚████╔╝ ██║  ██║
╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝
Welcome to NOVA Onboard Assistant! Let's get you set up.
`);

    const currentConfig = loadConfig();

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'ollamaUrl',
        message: 'Ollama local connection endpoint URL:',
        default: currentConfig.ollamaUrl || 'http://localhost:11434',
      },
      {
        type: 'list',
        name: 'fastModel',
        message: 'Select fast model (for simple queries, widgets):',
        choices: ['phi3:mini', 'gemma2:2b', 'llama3:8b', 'custom'],
        default: currentConfig.modelRouting.fast || 'phi3:mini',
      },
      {
        type: 'input',
        name: 'customFastModel',
        message: 'Enter custom fast model identifier:',
        when: (ans) => ans.fastModel === 'custom',
      },
      {
        type: 'list',
        name: 'reasoningModel',
        message: 'Select reasoning model (for bash/coding tasks):',
        choices: ['qwen3:8b', 'llama3.1:8b', 'mistral:7b', 'custom'],
        default: currentConfig.modelRouting.reasoning || 'qwen3:8b',
      },
      {
        type: 'input',
        name: 'customReasoningModel',
        message: 'Enter custom reasoning model identifier:',
        when: (ans) => ans.reasoningModel === 'custom',
      },
      {
        type: 'confirm',
        name: 'enableTelegram',
        message: 'Enable Telegram Channel?',
        default: currentConfig.channels.telegram.enabled,
      },
      {
        type: 'input',
        name: 'telegramToken',
        message: 'Enter Telegram Bot API Token (from @BotFather):',
        when: (ans) => ans.enableTelegram,
        default: currentConfig.channels.telegram.token,
      },
      {
        type: 'confirm',
        name: 'enableWhatsApp',
        message: 'Enable WhatsApp Personal/Widget channel?',
        default: currentConfig.channels.whatsapp.enabled,
      },
      {
        type: 'confirm',
        name: 'installDaemon',
        message: 'Install background daemon to keep NOVA running 24/7?',
        default: true,
      }
    ]);

    // Save configuration
    const newConfig: NovaConfig = {
      ollamaUrl: answers.ollamaUrl,
      modelRouting: {
        fast: answers.fastModel === 'custom' ? answers.customFastModel : answers.fastModel,
        reasoning: answers.reasoningModel === 'custom' ? answers.customReasoningModel : answers.reasoningModel,
      },
      channels: {
        telegram: {
          enabled: answers.enableTelegram,
          token: answers.telegramToken || '',
        },
        whatsapp: {
          enabled: answers.enableWhatsApp,
        },
        dashboard: currentConfig.channels.dashboard,
        widget: currentConfig.channels.widget,
      },
      paths: currentConfig.paths,
    };

    saveConfig(newConfig);
    console.log('\n✓ Configuration file saved successfully at ~/.nova/nova.json');

    // Pull Ollama models in background
    console.log('\nPulling configured Ollama models in background if missing...');
    try {
      execSync(`ollama pull ${newConfig.modelRouting.fast}`, { stdio: 'inherit' });
      execSync(`ollama pull ${newConfig.modelRouting.reasoning}`, { stdio: 'inherit' });
    } catch {
      console.warn('⚠️ Could not connect to local Ollama. Ensure Ollama is running (run "ollama serve").');
    }

    // Launch daemon
    if (answers.installDaemon || options.installDaemon) {
      installPm2Daemon();
    } else {
      console.log('\nSetup complete! Start NOVA manually by running: nova start');
    }
  });

// COMMAND: start
program
  .command('start')
  .description('Start the NOVA Gateway server daemon')
  .action(() => {
    console.log('Starting NOVA Gateway daemon...');
    try {
      execSync('pm2 start @nova/gateway --name "nova-gateway"', { stdio: 'inherit' });
      console.log('✓ NOVA Gateway started successfully.');
    } catch {
      // Fallback if not globally linked
      try {
        const rootDir = path.resolve(__dirname, '../../../');
        execSync(`pm2 start ${path.join(rootDir, 'packages/gateway/dist/server.js')} --name "nova-gateway"`, { stdio: 'inherit' });
        console.log('✓ NOVA Gateway started successfully.');
      } catch (err: any) {
        console.error('Failed to start PM2 daemon. Launching in foreground instead...', err.message);
        execSync('node dist/server.js', { stdio: 'inherit' });
      }
    }
  });

// COMMAND: stop
program
  .command('stop')
  .description('Stop the running NOVA Gateway server daemon')
  .action(() => {
    console.log('Stopping NOVA Gateway daemon...');
    try {
      execSync('pm2 stop nova-gateway', { stdio: 'inherit' });
      console.log('✓ NOVA Gateway stopped.');
    } catch (err: any) {
      console.error('Failed to stop daemon via PM2:', err.message);
    }
  });

// COMMAND: status
program
  .command('status')
  .description('Check the active status of the gateway server')
  .action(() => {
    try {
      execSync('pm2 show nova-gateway', { stdio: 'inherit' });
    } catch (err: any) {
      console.log('Daemon status check failed. Ensure PM2 is installed.');
    }
  });

function installPm2Daemon() {
  console.log('\nInstalling and configuring PM2 Background Daemon...');
  try {
    // Check if pm2 is installed globally, otherwise install it
    try {
      execSync('pm2 --version', { stdio: 'ignore' });
    } catch {
      console.log('Installing PM2 globally...');
      execSync('npm install -g pm2', { stdio: 'inherit' });
    }

    const rootDir = path.resolve(__dirname, '../../../');
    const serverPath = path.join(rootDir, 'packages/gateway/dist/server.js');

    // Stop existing instance
    try {
      execSync('pm2 delete nova-gateway', { stdio: 'ignore' });
    } catch {}

    // Start daemon
    execSync(`pm2 start "${serverPath}" --name "nova-gateway"`, { stdio: 'inherit' });
    execSync('pm2 save', { stdio: 'inherit' });

    console.log(`
✓ NOVA Gateway daemon is now running in the background.
✓ Control Dashboard is active at http://localhost:3000
✓ Use "nova status" to monitor logs.
✓ Use "nova stop" to terminate the daemon.
`);
  } catch (err: any) {
    console.error('❌ Failed to configure PM2 background daemon:', err.message);
  }
}

program.parse(process.argv);
