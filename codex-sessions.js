'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { normalizeDisplayPath } = require('./session-paths');

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const MAX_TITLE = 120;
const MAX_TOOL_INPUT = 6000;
const MAX_TOOL_OUTPUT = 5000;

function sessionIdFromFilename(filePath) {
  const match = path.basename(filePath, '.jsonl').match(UUID_RE);
  return match ? match[1].toLowerCase() : '';
}

function deleteCodexSessionFile(codexHome, session) {
  if (!session || session.provider !== 'codex' || !session.id || !session.filePath)
    throw new Error('Invalid Codex session');

  const target = path.resolve(session.filePath);
  const roots = ['sessions', 'archived_sessions'].map(dir => path.resolve(codexHome, dir));
  const targetCmp = process.platform === 'win32' ? target.toLowerCase() : target;
  const allowed = roots.some(root => {
    const rootCmp = process.platform === 'win32' ? root.toLowerCase() : root;
    return targetCmp.startsWith(`${rootCmp}${path.sep}`);
  });
  if (!allowed || sessionIdFromFilename(target) !== session.id.toLowerCase())
    throw new Error('Session path is outside the Codex session folders');
  if (!fs.existsSync(target)) return false;

  fs.unlinkSync(target);
  return true;
}

function sourceKind(source) {
  if (typeof source === 'string') return source;
  if (!source || typeof source !== 'object') return 'unknown';
  if (source.subagent) return 'subagent';
  return Object.keys(source)[0] || 'auxiliary';
}

function isAuxiliarySource(source) {
  const kind = sourceKind(source);
  return kind !== 'cli' && kind !== 'vscode';
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => {
    if (!item) return '';
    if (typeof item === 'string') return item;
    if ((item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') && item.text) return item.text;
    return '';
  }).filter(Boolean).join('\n');
}

function visibleMessageText(payload) {
  if (!payload) return '';
  if (typeof payload.message === 'string') return payload.message;
  if (payload.message && payload.message.content) return textFromContent(payload.message.content);
  return textFromContent(payload.content);
}

function isInjectedUserText(text) {
  const value = String(text || '').trimStart();
  return value.startsWith('<environment_context>') ||
    value.startsWith('<permissions instructions>') ||
    value.startsWith('<collaboration_mode>') ||
    value.startsWith('<apps_instructions>') ||
    value.startsWith('<plugins_instructions>') ||
    value.startsWith('<skills_instructions>');
}

function titleFromText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean;
}

function safeJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function toolInputJson(value) {
  const parsed = safeJson(value);
  if (typeof parsed === 'string') return parsed.slice(0, MAX_TOOL_INPUT);
  try { return JSON.stringify(parsed ?? {}, null, 2).slice(0, MAX_TOOL_INPUT); }
  catch { return String(value || '').slice(0, MAX_TOOL_INPUT); }
}

function toolSummary(name, value) {
  const parsed = safeJson(value);
  if (typeof parsed === 'string') return parsed.replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!parsed || typeof parsed !== 'object') return '';
  const preferred = parsed.command || parsed.query || parsed.path || parsed.file_path || parsed.description || parsed.prompt;
  if (typeof preferred === 'string') return preferred.replace(/\s+/g, ' ').trim().slice(0, 140);
  const first = Object.values(parsed).find(item => typeof item === 'string');
  if (first) return first.replace(/\s+/g, ' ').trim().slice(0, 140);
  try { return JSON.stringify(parsed).slice(0, 140); } catch { return String(name || 'Tool'); }
}

function toolOutput(value) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (Array.isArray(value)) {
    const chunks = [];
    for (const item of value) {
      if (!item) continue;
      if (typeof item === 'string') chunks.push(item);
      else if (item.type === 'text' && item.text) chunks.push(item.text);
      else if (item.type === 'image') chunks.push('[image]');
      else if (item.type === 'audio') chunks.push('[audio]');
      else if (item.type === 'resource_link') chunks.push(`[resource: ${item.title || item.name || item.uri || 'link'}]`);
    }
    text = chunks.join('\n');
  } else if (value != null) {
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  }
  const truncated = text.length > MAX_TOOL_OUTPUT;
  return { text: truncated ? text.slice(0, MAX_TOOL_OUTPUT) : text, truncated };
}

async function eachJsonLine(filePath, visit) {
  await new Promise(resolve => {
    let index = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', line => {
      if (!line.trim()) return;
      let record;
      try { record = JSON.parse(line); } catch { return; }
      visit(record, index++);
    });
    rl.on('close', resolve);
    rl.on('error', resolve);
  });
}

async function parseCodexSession(filePath, archived = false) {
  const stat = fs.statSync(filePath);
  let id = sessionIdFromFilename(filePath);
  let cwd = '';
  let firstTs = '';
  let lastTs = '';
  let source = 'unknown';
  let model = '';
  let contextWindow = 0;
  let ctxTokens = 0;
  let sawSessionMeta = false;
  let eventTitle = '';
  let responseTitle = '';
  const eventUser = [];
  const eventAssistant = [];
  const responseUser = [];
  const responseAssistant = [];

  await eachJsonLine(filePath, (record, seq) => {
    const payload = record.payload || {};
    const timestamp = record.timestamp || payload.timestamp || '';
    if (!firstTs && timestamp) firstTs = timestamp;
    if (timestamp) lastTs = timestamp;

    if (record.type === 'session_meta' && !sawSessionMeta) {
      sawSessionMeta = true;
      id = payload.id || payload.session_id || id;
      cwd = normalizeDisplayPath(payload.cwd || cwd);
      source = payload.source ?? payload.thread_source ?? source;
      firstTs = payload.timestamp || firstTs;
      return;
    }
    if (record.type === 'turn_context') {
      cwd = normalizeDisplayPath(payload.cwd || cwd);
      model = payload.model || model;
      return;
    }
    if (record.type === 'event_msg') {
      if (payload.type === 'user_message') {
        const text = visibleMessageText(payload);
        if (text) {
          eventUser.push({ seq, text });
          if (!eventTitle) eventTitle = titleFromText(text);
        }
      } else if (payload.type === 'agent_message') {
        const text = visibleMessageText(payload);
        if (text) eventAssistant.push({ seq, text });
      } else if (payload.type === 'token_count' && payload.info) {
        const usage = payload.info.last_token_usage || payload.info.total_token_usage || {};
        ctxTokens = Number(usage.total_tokens) || ctxTokens;
        contextWindow = Number(payload.info.model_context_window) || contextWindow;
      }
      return;
    }
    if (record.type === 'response_item' && payload.type === 'message') {
      const text = visibleMessageText(payload);
      if (!text) return;
      if (payload.role === 'user' && !isInjectedUserText(text)) {
        responseUser.push({ seq, text });
        if (!responseTitle) responseTitle = titleFromText(text);
      } else if (payload.role === 'assistant') {
        responseAssistant.push({ seq, text });
      }
    }
  });

  const spoken = [
    ...(eventUser.length ? eventUser : responseUser),
    ...(eventAssistant.length ? eventAssistant : responseAssistant),
  ].sort((a, b) => a.seq - b.seq).map(item => item.text);
  const searchText = spoken.join('\n');
  const kind = sourceKind(source);
  const projectDir = cwd || 'Codex';

  return {
    provider: 'codex', key: `codex:${id}`, id, projectDir, projectKey: projectDir,
    title: eventTitle || responseTitle, cwd, firstTs, lastTs,
    msgCount: eventUser.length || responseUser.length, summary: '', sizeBytes: stat.size,
    ctxTokens, contextWindow, model, source: kind, isSubagent: isAuxiliarySource(source),
    archived, filePath, searchText, searchLower: searchText.toLowerCase(),
  };
}

function jsonlFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }
  return files;
}

async function loadCodexSessions(codexHome) {
  const roots = [
    { path: path.join(codexHome, 'sessions'), archived: false },
    { path: path.join(codexHome, 'archived_sessions'), archived: true },
  ];
  const sessions = [];
  for (const root of roots) {
    for (const filePath of jsonlFiles(root.path)) {
      try { sessions.push(await parseCodexSession(filePath, root.archived)); } catch {}
    }
  }
  return sessions;
}

async function parseCodexMessages(filePath) {
  const eventUser = [];
  const eventAssistant = [];
  const responseUser = [];
  const responseAssistant = [];
  const toolEvents = [];
  const summaries = [];
  const toolParts = new Map();

  await eachJsonLine(filePath, (record, seq) => {
    const payload = record.payload || {};
    const timestamp = record.timestamp || '';
    if (record.type === 'event_msg') {
      if (payload.type === 'user_message') {
        const text = visibleMessageText(payload);
        if (text) eventUser.push({ seq, type: 'turn', role: 'user', provider: 'codex', timestamp, parts: [{ kind: 'text', text }] });
      } else if (payload.type === 'agent_message') {
        const text = visibleMessageText(payload);
        if (text) eventAssistant.push({ seq, type: 'turn', role: 'assistant', provider: 'codex', timestamp, parts: [{ kind: 'text', text }] });
      }
      return;
    }
    if (record.type === 'compacted') {
      summaries.push({ seq, type: 'summary', provider: 'codex', timestamp, text: typeof payload.message === 'string' ? payload.message : '' });
      return;
    }
    if (record.type !== 'response_item') return;
    if (payload.type === 'message') {
      const text = visibleMessageText(payload);
      if (!text) return;
      const item = { seq, type: 'turn', role: payload.role, provider: 'codex', timestamp, parts: [{ kind: 'text', text }] };
      if (payload.role === 'user' && !isInjectedUserText(text)) responseUser.push(item);
      else if (payload.role === 'assistant') responseAssistant.push(item);
      return;
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const rawInput = payload.type === 'function_call' ? payload.arguments : payload.input;
      const callId = payload.call_id || payload.id || `codex-tool-${seq}`;
      const part = { kind: 'tool_use', id: callId, name: payload.name || 'Tool', summary: toolSummary(payload.name, rawInput), inputJson: toolInputJson(rawInput) };
      toolParts.set(callId, part);
      toolEvents.push({ seq, type: 'turn', role: 'assistant', provider: 'codex', timestamp, parts: [part] });
      return;
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const part = toolParts.get(payload.call_id);
      if (part) part.result = { kind: 'tool_result', toolUseId: payload.call_id || '', ...toolOutput(payload.output) };
    }
  });

  return [
    ...(eventUser.length ? eventUser : responseUser),
    ...(eventAssistant.length ? eventAssistant : responseAssistant),
    ...toolEvents,
    ...summaries,
  ].sort((a, b) => a.seq - b.seq).map(({ seq, ...message }) => message);
}

module.exports = { deleteCodexSessionFile, loadCodexSessions, parseCodexMessages, parseCodexSession, sessionIdFromFilename, sourceKind };
