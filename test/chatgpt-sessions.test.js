'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadChatGptSessions,
  parseChatGptMessages,
  validateChatGptExportPath,
} = require('../chatgpt-sessions');

const ID = '11111111-2222-4333-8444-555555555555';

function fixture() {
  return {
    id: ID,
    conversation_id: ID,
    title: 'Exported conversation',
    create_time: 1700000000,
    update_time: 1700000300,
    current_node: 'assistant-current',
    is_archived: true,
    mapping: {
      root: { id: 'root', parent: null, children: ['user'], message: null },
      user: {
        id: 'user', parent: 'root', children: ['assistant-old', 'assistant-current'],
        message: { author: { role: 'user' }, create_time: 1700000000, content: { content_type: 'text', parts: ['Hello export'] }, metadata: {} },
      },
      'assistant-old': {
        id: 'assistant-old', parent: 'user', children: [],
        message: { author: { role: 'assistant' }, create_time: 1700000010, content: { content_type: 'text', parts: ['Old branch'] }, metadata: {} },
      },
      hidden: {
        id: 'hidden', parent: 'user', children: [],
        message: { author: { role: 'assistant' }, create_time: 1700000015, content: { content_type: 'text', parts: ['Hidden'] }, metadata: { is_visually_hidden_from_conversation: true } },
      },
      'assistant-current': {
        id: 'assistant-current', parent: 'user', children: [],
        message: { author: { role: 'assistant' }, create_time: 1700000020, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://example' }, 'Current branch'] }, metadata: {} },
      },
    },
  };
}

test('loads exported conversations and follows only the selected message branch', t => {
  const exportPath = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-chatgpt-'));
  t.after(() => fs.rmSync(exportPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(exportPath, 'conversations.json'), JSON.stringify([fixture()]));
  fs.writeFileSync(path.join(exportPath, 'user.json'), JSON.stringify({ email: 'person@example.com' }));
  fs.writeFileSync(path.join(exportPath, 'shared_conversations.json'), JSON.stringify([{ id: 'ignored' }]));

  validateChatGptExportPath(exportPath);
  const sessions = loadChatGptSessions(exportPath);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].provider, 'chatgpt');
  assert.equal(sessions[0].key, `chatgpt:${ID}`);
  assert.equal(sessions[0].url, `https://chatgpt.com/c/${ID}`);
  assert.equal(sessions[0].accountEmail, 'person@example.com');
  assert.equal(sessions[0].projectDir, 'ChatGPT (person@example.com)');
  assert.equal(sessions[0].msgCount, 1);
  assert.equal(sessions[0].archived, true);
  assert.match(sessions[0].searchText, /Hello export/);
  assert.doesNotMatch(sessions[0].searchText, /Old branch|Hidden/);
  assert.equal(JSON.stringify(sessions[0]).includes('rawConversation'), false);

  const messages = parseChatGptMessages(sessions[0].rawConversation);
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(messages[1].parts[0].text, '[Image]\nCurrent branch');
});

test('loads numbered conversation files and rejects invalid export folders', t => {
  const exportPath = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-chatgpt-numbered-'));
  t.after(() => fs.rmSync(exportPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(exportPath, 'conversations-1.json'), JSON.stringify([fixture()]));
  fs.writeFileSync(path.join(exportPath, 'conversations-2.json'), JSON.stringify([fixture()]));

  assert.equal(loadChatGptSessions(exportPath).length, 1);
  assert.throws(() => validateChatGptExportPath(path.join(exportPath, 'missing')), /not found/);

  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-chatgpt-empty-'));
  t.after(() => fs.rmSync(emptyPath, { recursive: true, force: true }));
  assert.throws(() => validateChatGptExportPath(emptyPath), /No conversations\.json/);

  fs.writeFileSync(path.join(emptyPath, 'conversations.json'), JSON.stringify([{ uuid: ID, chat_messages: [] }]));
  assert.throws(() => validateChatGptExportPath(emptyPath), /does not contain a ChatGPT export/);
});
