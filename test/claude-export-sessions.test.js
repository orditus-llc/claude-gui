'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadClaudeExportSessions,
  parseClaudeExportMessages,
  validateClaudeExportPath,
} = require('../claude-export-sessions');

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACCOUNT_ID = '11111111-2222-3333-4444-555555555555';

function fixture() {
  return {
    uuid: ID,
    name: 'Claude export conversation',
    summary: '',
    created_at: '2026-01-02T03:04:05.000000+00:00',
    updated_at: '2026-01-02T03:05:05.000000+00:00',
    account: { uuid: ACCOUNT_ID },
    chat_messages: [
      { uuid: 'm1', sender: 'human', text: 'Hello Claude', content: [], created_at: '2026-01-02T03:04:05.000000+00:00' },
      { uuid: 'm2', sender: 'assistant', text: '', content: [{ type: 'text', text: 'Hello human' }], created_at: '2026-01-02T03:04:06.000000+00:00' },
    ],
  };
}

test('loads Claude exports with account identity and read-only conversation URLs', t => {
  const exportPath = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-claude-export-'));
  t.after(() => fs.rmSync(exportPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(exportPath, 'conversations.json'), JSON.stringify([fixture()]));
  fs.writeFileSync(path.join(exportPath, 'users.json'), JSON.stringify([
    { uuid: ACCOUNT_ID, email_address: 'person@example.com' },
  ]));

  validateClaudeExportPath(exportPath);
  const sessions = loadClaudeExportSessions(exportPath);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].provider, 'claude-export');
  assert.equal(sessions[0].accountEmail, 'person@example.com');
  assert.equal(sessions[0].projectDir, 'Claude (person@example.com)');
  assert.equal(sessions[0].url, `https://claude.ai/chat/${ID}`);
  assert.equal(sessions[0].msgCount, 1);
  assert.equal(JSON.stringify(sessions[0]).includes('rawConversation'), false);

  const messages = parseClaudeExportMessages(sessions[0].rawConversation);
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(messages[1].parts[0].text, 'Hello human');
});

test('rejects a non-Claude conversation export', t => {
  const exportPath = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-not-claude-'));
  t.after(() => fs.rmSync(exportPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(exportPath, 'conversations.json'), JSON.stringify([{ mapping: {} }]));
  assert.throws(() => validateClaudeExportPath(exportPath), /does not contain a Claude export/);
});
