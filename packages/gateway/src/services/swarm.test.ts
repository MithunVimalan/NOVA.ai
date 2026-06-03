import test from 'node:test';
import assert from 'node:assert';
import { getSqliteManager } from '@nova/shared';
import { getSessionManager } from './session.js';

// TDD Test: Swarm Coordinator delegation logic
test('SwarmCoordinator splits complex request and delegates to correct worker agents', async () => {
  const { SwarmCoordinator } = await import('./swarm.js');
  const coordinator = new SwarmCoordinator();

  const task = 'Scrape the latest news about Node.js and write the summary to a report.md file.';
  const plan = await coordinator.generateExecutionPlan(task);

  assert.ok(plan.subTasks.length >= 2, 'Coordinator must split complex task into at least 2 sub-tasks');

  const scraperTask = plan.subTasks.find(t => t.assignedWorker === 'ScraperWorker');
  assert.ok(scraperTask, 'Should assign scraping task to ScraperWorker');

  const developerTask = plan.subTasks.find(t => t.assignedWorker === 'DeveloperWorker');
  assert.ok(developerTask, 'Should assign report-writing task to DeveloperWorker');
});

// TDD Test: Worker Agent task execution
test('Worker agents run isolated tool execution and return findings', async () => {
  const { SwarmCoordinator } = await import('./swarm.js');
  const coordinator = new SwarmCoordinator();

  // Test executing a single sub-task on a worker agent
  const subTask = {
    id: 'sub-1',
    description: 'Find Node.js 22 release notes',
    assignedWorker: 'ScraperWorker' as const
  };

  const output = await coordinator.executeSubTaskOnWorker(subTask);
  assert.ok(output, 'Worker execution must return an output result');
  assert.ok(output.success, 'Worker task execution should succeed');
  assert.ok(output.result.includes('Node.js') || output.result.includes('Mock'), 'Worker result must contain task findings');
});

// TDD Test: Automatic manual takeover escalation triggers
test('sessionManager triggers manual takeover and sends notification on support keywords', async () => {
  const sessionManager = getSessionManager();
  const sqliteDb = getSqliteManager();
  const sessionId = 'test-escalation-session';
  const tenantId = 'tenant-test-ig';

  // Seed fcm token to simulate push alert logging
  sqliteDb.setFact(`fcm_token_${tenantId}`, 'mock_fcm_token_123');

  // Trigger user message containing escalation keywords
  const message = 'I want to speak with a human support agent representative right now!';
  const reply = await sessionManager.handleUserMessage(
    `${tenantId}-${sessionId}`,
    message,
    false, // guest session
    'widget'
  );

  const session = sessionManager.getOrCreateSession(`${tenantId}-${sessionId}`);
  
  assert.strictEqual((session as any).isManualTakeover, true, 'isManualTakeover must toggle to true on support keywords');
  assert.ok(reply.includes('representative') || reply.includes('notified'), 'System reply must inform guest of takeover');
});
