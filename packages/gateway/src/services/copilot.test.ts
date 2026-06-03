import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// TDD Test: Tauri 2 Desktop Config Validation
test('Tauri 2 Config exists and has valid auto-start and tray settings', async () => {
  let rootDir = process.cwd();
  while (!fs.existsSync(path.join(rootDir, 'apps', 'desktop')) && path.dirname(rootDir) !== rootDir) {
    rootDir = path.dirname(rootDir);
  }
  const desktopDir = path.join(rootDir, 'apps', 'desktop');
  const tauriConfigPath = path.join(desktopDir, 'src-tauri', 'tauri.conf.json');

  // Verify file existence
  assert.ok(fs.existsSync(tauriConfigPath), 'tauri.conf.json should be initialized in apps/desktop/src-tauri');

  // Verify settings schema
  const config = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf-8'));
  assert.ok(config.identifier, 'Tauri config should define an application identifier');
  assert.ok(config.bundle, 'Tauri config should have a bundle configuration block');
  assert.ok(config.app, 'Tauri config should define app window options');
});

// TDD Test: Co-Pilot Double-Confirmation Mechanism
test('Co-Pilot intercepts critical command execution and awaits confirmation', async () => {
  // Ephemeral test imports - dynamic import once implemented
  const { getCopilotService } = await import('./copilot.js');
  const copilotService = getCopilotService();

  const sessionId = 'test-co-pilot-session';
  const command = 'echo "hello"';

  // Clear any existing state
  copilotService.clearPendingActions(sessionId);

  // 1. Trigger action that requires double-confirmation
  const result = await copilotService.requestActionExecution(sessionId, 'bash', { command });
  
  assert.strictEqual(result.status, 'PENDING_CONFIRMATION', 'Critical bash command must be intercepted');
  assert.ok(result.actionId, 'Pending action must receive a unique actionId');

  // 2. Try to run it without approval - should be blocked
  const runAttempt = await copilotService.executePendingAction(sessionId, result.actionId!, false);
  assert.strictEqual(runAttempt.success, false, 'Action must fail if rejected or not approved');

  // 3. Request again and approve it
  const secondRequest = await copilotService.requestActionExecution(sessionId, 'bash', { command });
  const runApproved = await copilotService.executePendingAction(sessionId, secondRequest.actionId!, true);
  
  assert.strictEqual(runApproved.success, true, 'Approved action should run successfully');
  assert.ok(runApproved.output.includes('Observation') || runApproved.output.includes('Stdout') || runApproved.output.includes('Mock'), 'Action output should return output metrics');
});

// TDD Test: Local Document Indexing Scanner
test('Document Scanner recursively indexes folders to vector LanceDB', async () => {
  const { getCopilotService } = await import('./copilot.js');
  const copilotService = getCopilotService();

  // Create temporary test directory and text files
  const tempTestDir = path.join(os.tmpdir(), `nova_scan_test_${Date.now()}`);
  fs.mkdirSync(tempTestDir, { recursive: true });
  fs.writeFileSync(path.join(tempTestDir, 'doc1.txt'), 'NOVA is an AI personal coworker.', 'utf-8');
  
  const subDir = path.join(tempTestDir, 'sub');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'doc2.txt'), 'Nova operates locally with SQLite and LanceDB.', 'utf-8');

  try {
    const scanResult = await copilotService.scanLocalFolder(tempTestDir);
    assert.ok(scanResult.filesIndexed >= 2, 'Scanner should find and index at least 2 text documents');
    assert.ok(scanResult.durationMs >= 0, 'Scanner should return processing duration');
  } finally {
    // Clean up temp directories
    try {
      fs.unlinkSync(path.join(tempTestDir, 'doc1.txt'));
      fs.unlinkSync(path.join(subDir, 'doc2.txt'));
      fs.rmdirSync(subDir);
      fs.rmdirSync(tempTestDir);
    } catch {}
  }
});
