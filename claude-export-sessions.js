'use strict';

const fs = require('fs');
const path = require('path');

function messageText(message) {
  if (typeof message.text === 'string' && message.text) return message.text;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(item => item && typeof item.text === 'string' && item.text)
    .map(item => item.text)
    .join('\n');
}

function visibleTurns(conversation) {
  const turns = [];
  for (const message of Array.isArray(conversation.chat_messages) ? conversation.chat_messages : []) {
    const role = message.sender === 'human' ? 'user' : message.sender === 'assistant' ? 'assistant' : '';
    if (!role) continue;
    const text = messageText(message);
    if (!text) continue;
    turns.push({ role, text, timestamp: message.created_at || '' });
  }
  return turns;
}

function parseClaudeExportMessages(conversation) {
  return visibleTurns(conversation).map(turn => ({
    type: 'turn',
    role: turn.role,
    provider: 'claude-export',
    timestamp: turn.timestamp,
    parts: [{ kind: 'text', text: turn.text }],
  }));
}

function sessionFromConversation(conversation, accountEmail = '') {
  const id = conversation && conversation.uuid;
  if (!id) return null;
  const turns = visibleTurns(conversation);
  const searchText = turns.map(turn => turn.text).join('\n');
  const label = accountEmail ? `Claude (${accountEmail})` : 'Claude';
  const session = {
    provider: 'claude-export',
    key: `claude-export:${id}`,
    id,
    projectDir: label,
    projectKey: accountEmail ? `claude-export:${accountEmail}` : 'claude-export',
    title: conversation.name || conversation.summary || '',
    cwd: '',
    firstTs: conversation.created_at || '',
    lastTs: conversation.updated_at || '',
    msgCount: turns.filter(turn => turn.role === 'user').length,
    summary: '',
    sizeBytes: Buffer.byteLength(JSON.stringify(conversation)),
    ctxTokens: 0,
    contextWindow: 0,
    source: 'claude-export',
    isSubagent: false,
    archived: false,
    readonly: true,
    accountEmail,
    url: `https://claude.ai/chat/${id}`,
    searchText,
    searchLower: searchText.toLowerCase(),
  };
  Object.defineProperty(session, 'rawConversation', { value: conversation });
  return session;
}

function validateClaudeExportPath(exportPath) {
  if (!exportPath) return;
  if (!fs.existsSync(exportPath)) throw new Error('Claude export folder not found');
  if (!fs.statSync(exportPath).isDirectory()) throw new Error('Claude export path must be a folder');
  const conversationsPath = path.join(exportPath, 'conversations.json');
  if (!fs.existsSync(conversationsPath)) throw new Error('No conversations.json file found in that folder');
  const fd = fs.openSync(conversationsPath, 'r');
  try {
    const sample = Buffer.alloc(65536);
    const length = fs.readSync(fd, sample, 0, sample.length, 0);
    if (!sample.toString('utf8', 0, length).includes('"chat_messages"')) {
      throw new Error('That folder does not contain a Claude export');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function loadClaudeExportSessions(exportPath) {
  if (!exportPath || !fs.existsSync(exportPath)) return [];
  const conversationsPath = path.join(exportPath, 'conversations.json');
  if (!fs.existsSync(conversationsPath)) return [];
  const conversations = JSON.parse(fs.readFileSync(conversationsPath, 'utf8'));
  if (!Array.isArray(conversations)) return [];

  const emails = new Map();
  try {
    const users = JSON.parse(fs.readFileSync(path.join(exportPath, 'users.json'), 'utf8'));
    for (const user of Array.isArray(users) ? users : []) {
      if (user && user.uuid && typeof user.email_address === 'string') emails.set(user.uuid, user.email_address);
    }
  } catch {}

  return conversations.map(conversation => {
    const accountId = conversation && conversation.account && conversation.account.uuid;
    return sessionFromConversation(conversation, emails.get(accountId) || '');
  }).filter(Boolean);
}

module.exports = {
  loadClaudeExportSessions,
  parseClaudeExportMessages,
  sessionFromConversation,
  validateClaudeExportPath,
};
