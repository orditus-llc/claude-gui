'use strict';

const fs = require('fs');
const path = require('path');

const EXPORT_FILE_RE = /^conversations(?:[-_]\d+)?\.json$/i;

function isoFromUnix(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return '';
  return new Date(seconds * 1000).toISOString();
}

function conversationId(conversation) {
  return conversation.conversation_id || conversation.id || '';
}

function activeMessageRecords(conversation) {
  const mapping = conversation && conversation.mapping;
  if (!mapping || typeof mapping !== 'object') return [];

  const records = [];
  const seen = new Set();
  let nodeId = conversation.current_node;
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (!node) break;
    if (node.message) records.push(node.message);
    nodeId = node.parent;
  }
  return records.reverse();
}

function contentText(content) {
  if (!content) return '';
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      if (part) text.push(part);
    } else if (part && typeof part.text === 'string') {
      if (part.text) text.push(part.text);
    } else if (part && (part.asset_pointer || part.content_type === 'image_asset_pointer')) {
      text.push('[Image]');
    }
  }
  if (!text.length && typeof content.text === 'string') text.push(content.text);
  return text.join('\n');
}

function visibleTurns(conversation) {
  const turns = [];
  for (const message of activeMessageRecords(conversation)) {
    const role = message.author && message.author.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (message.metadata && message.metadata.is_visually_hidden_from_conversation) continue;
    const text = contentText(message.content);
    if (!text) continue;
    turns.push({ role, text, timestamp: isoFromUnix(message.create_time) });
  }
  return turns;
}

function parseChatGptMessages(conversation) {
  return visibleTurns(conversation).map(turn => ({
    type: 'turn',
    role: turn.role,
    provider: 'chatgpt',
    timestamp: turn.timestamp,
    parts: [{ kind: 'text', text: turn.text }],
  }));
}

function sessionFromConversation(conversation, accountEmail = '') {
  const id = conversationId(conversation);
  if (!id) return null;
  const turns = visibleTurns(conversation);
  const searchText = turns.map(turn => turn.text).join('\n');
  const session = {
    provider: 'chatgpt',
    key: `chatgpt:${id}`,
    id,
    projectDir: accountEmail ? `ChatGPT (${accountEmail})` : 'ChatGPT',
    projectKey: accountEmail ? `chatgpt:${accountEmail}` : 'chatgpt',
    title: conversation.title || '',
    cwd: '',
    firstTs: isoFromUnix(conversation.create_time),
    lastTs: isoFromUnix(conversation.update_time),
    msgCount: turns.filter(turn => turn.role === 'user').length,
    summary: '',
    sizeBytes: Buffer.byteLength(JSON.stringify(conversation)),
    ctxTokens: 0,
    contextWindow: 0,
    source: 'chatgpt',
    isSubagent: false,
    archived: !!conversation.is_archived,
    readonly: true,
    accountEmail,
    url: `https://chatgpt.com/c/${id}`,
    searchText,
    searchLower: searchText.toLowerCase(),
  };
  Object.defineProperty(session, 'rawConversation', { value: conversation });
  return session;
}

function exportFiles(exportPath) {
  if (!exportPath || !fs.existsSync(exportPath)) return [];
  let stat;
  try { stat = fs.statSync(exportPath); } catch { return []; }
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(exportPath)
    .filter(name => EXPORT_FILE_RE.test(name))
    .sort()
    .map(name => path.join(exportPath, name));
}

function validateChatGptExportPath(exportPath) {
  if (!exportPath) return;
  if (!fs.existsSync(exportPath)) throw new Error('ChatGPT export folder not found');
  if (!fs.statSync(exportPath).isDirectory()) throw new Error('ChatGPT export path must be a folder');
  const files = exportFiles(exportPath);
  if (!files.length) throw new Error('No conversations.json file found in that folder');
  const fd = fs.openSync(files[0], 'r');
  try {
    const sample = Buffer.alloc(65536);
    const length = fs.readSync(fd, sample, 0, sample.length, 0);
    if (!sample.toString('utf8', 0, length).includes('"mapping"')) {
      throw new Error('That folder does not contain a ChatGPT export');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function loadChatGptSessions(exportPath) {
  const sessions = [];
  const seen = new Set();
  let accountEmail = '';
  try {
    const user = JSON.parse(fs.readFileSync(path.join(exportPath, 'user.json'), 'utf8'));
    accountEmail = typeof user.email === 'string' ? user.email : '';
  } catch {}
  for (const filePath of exportFiles(exportPath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const conversations = Array.isArray(parsed) ? parsed : [];
    for (const conversation of conversations) {
      const session = sessionFromConversation(conversation, accountEmail);
      if (!session || seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
  }
  return sessions;
}

module.exports = {
  loadChatGptSessions,
  parseChatGptMessages,
  sessionFromConversation,
  validateChatGptExportPath,
};
