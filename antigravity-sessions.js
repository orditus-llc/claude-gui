'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { normalizeDisplayPath } = require('./session-paths');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE = 120;
const MAX_TOOL_INPUT = 6000;

function titleFromText(text) {
  const request = userText(text);
  const firstLine = request.split(/\r?\n/).map(line => line.trim()).find(Boolean) || request;
  const clean = firstLine.replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean;
}

function userText(text) {
  const value = String(text || '');
  const request = value.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  return (request ? request[1] : value).trim();
}

function transcriptPath(antigravityHome, id) {
  const logs = path.join(antigravityHome, 'brain', id, '.system_generated', 'logs');
  const full = path.join(logs, 'transcript_full.jsonl');
  return fs.existsSync(full) ? full : path.join(logs, 'transcript.jsonl');
}

function projectHints(antigravityHome) {
  const hints = new Map();
  const last = path.join(antigravityHome, 'cache', 'last_conversations.json');
  try {
    const values = JSON.parse(fs.readFileSync(last, 'utf8'));
    for (const [cwd, id] of Object.entries(values || {})) {
      if (UUID_RE.test(String(id))) hints.set(String(id).toLowerCase(), normalizeDisplayPath(cwd));
    }
  } catch {}

  let projects = [];
  try {
    const values = JSON.parse(fs.readFileSync(path.join(path.dirname(antigravityHome), 'projects.json'), 'utf8'));
    projects = Object.keys(values.projects || {}).sort((a, b) => b.length - a.length);
  } catch {}
  const conversations = path.join(antigravityHome, 'conversations');
  if (!projects.length || !fs.existsSync(conversations)) return hints;
  for (const entry of fs.readdirSync(conversations)) {
    const match = entry.match(/^([0-9a-f-]{36})\.db$/i);
    if (!match || hints.has(match[1].toLowerCase())) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(conversations, entry)).toString('latin1'); } catch { continue; }
    const project = projects.find(candidate => raw.includes(candidate) || raw.includes(encodeURI(candidate)));
    if (project) hints.set(match[1].toLowerCase(), normalizeDisplayPath(project));
  }
  return hints;
}

async function eachJsonLine(filePath, visit) {
  await new Promise(resolve => {
    let index = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', line => {
      if (!line.trim()) return;
      try { visit(JSON.parse(line), index++); } catch {}
    });
    rl.on('close', resolve);
    rl.on('error', resolve);
  });
}

function toolSummary(call) {
  const args = call && call.args;
  if (!args || typeof args !== 'object') return '';
  const value = args.toolSummary || args.toolAction || args.CommandLine || args.query ||
    args.AbsolutePath || args.Url || Object.values(args).find(item => typeof item === 'string') || '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 140);
}

function toolInput(call) {
  try { return JSON.stringify(call && call.args || {}, null, 2).slice(0, MAX_TOOL_INPUT); }
  catch { return ''; }
}

async function parseAntigravitySession(antigravityHome, id, cwdHint = '') {
  if (!UUID_RE.test(id)) throw new Error('Invalid Antigravity conversation ID');
  const filePath = transcriptPath(antigravityHome, id);
  const stat = fs.statSync(filePath);
  let firstTs = '';
  let lastTs = '';
  let msgCount = 0;
  let transcriptTitle = '';
  const spoken = [];

  await eachJsonLine(filePath, record => {
    const timestamp = record.created_at || '';
    if (!firstTs && timestamp) firstTs = timestamp;
    if (timestamp) lastTs = timestamp;
    if (record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT' && typeof record.content === 'string') {
      msgCount++;
      spoken.push(userText(record.content));
      if (!transcriptTitle) transcriptTitle = titleFromText(record.content);
    } else if (record.type === 'PLANNER_RESPONSE' && record.source === 'MODEL' && typeof record.content === 'string') {
      spoken.push(record.content);
    }
  });

  const cwd = normalizeDisplayPath(cwdHint);
  const projectDir = cwd || 'Antigravity';
  const searchText = spoken.join('\n');
  return {
    provider: 'antigravity', key: `antigravity:${id}`, id, projectDir,
    projectKey: cwd, title: transcriptTitle, cwd,
    firstTs, lastTs, msgCount, summary: '', sizeBytes: stat.size,
    ctxTokens: 0, contextWindow: 0, source: 'antigravity', isSubagent: false,
    archived: false, filePath, searchText, searchLower: searchText.toLowerCase(),
  };
}

async function loadAntigravitySessions(antigravityHome) {
  const brainRoot = path.join(antigravityHome, 'brain');
  if (!fs.existsSync(brainRoot)) return [];
  const hints = projectHints(antigravityHome);
  const sessions = [];
  for (const entry of fs.readdirSync(brainRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    const id = entry.name.toLowerCase();
    if (!fs.existsSync(transcriptPath(antigravityHome, id))) continue;
    try {
      sessions.push(await parseAntigravitySession(antigravityHome, id, hints.get(id) || ''));
    } catch {}
  }
  return sessions;
}

async function parseAntigravityMessages(filePath) {
  const messages = [];
  const pendingTools = new Map();
  await eachJsonLine(filePath, (record, seq) => {
    const timestamp = record.created_at || '';
    if (record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT' && typeof record.content === 'string') {
      messages.push({ seq, type: 'turn', role: 'user', provider: 'antigravity', timestamp, parts: [{ kind: 'text', text: userText(record.content) }] });
      return;
    }
    if (record.type !== 'PLANNER_RESPONSE' || record.source !== 'MODEL') {
      const name = String(record.type || '').toLowerCase();
      const queue = pendingTools.get(name);
      if (queue && queue.length && typeof record.content === 'string') {
        const part = queue.shift();
        const truncated = record.content.length > 5000;
        part.result = { kind: 'tool_result', toolUseId: part.id, text: truncated ? record.content.slice(0, 5000) : record.content, truncated };
      }
      return;
    }
    const parts = [];
    if (typeof record.content === 'string' && record.content) parts.push({ kind: 'text', text: record.content });
    for (const [index, call] of (record.tool_calls || []).entries()) {
      const part = {
        kind: 'tool_use', id: `antigravity-tool-${seq}-${index}`,
        name: call.name || 'Tool', summary: toolSummary(call), inputJson: toolInput(call),
      };
      parts.push(part);
      const name = String(call.name || '').toLowerCase();
      if (!pendingTools.has(name)) pendingTools.set(name, []);
      pendingTools.get(name).push(part);
    }
    if (parts.length) messages.push({ seq, type: 'turn', role: 'assistant', provider: 'antigravity', timestamp, parts });
  });
  return messages.sort((a, b) => a.seq - b.seq).map(({ seq, ...message }) => message);
}

async function deleteAntigravitySession(antigravityHome, session) {
  if (!session || session.provider !== 'antigravity' || !UUID_RE.test(session.id))
    throw new Error('Invalid Antigravity session');
  const id = session.id.toLowerCase();
  const root = path.resolve(antigravityHome);
  const brainDir = path.resolve(root, 'brain', id);
  const conversationsDir = path.resolve(root, 'conversations');
  if (!brainDir.startsWith(`${root}${path.sep}`) || !conversationsDir.startsWith(`${root}${path.sep}`))
    throw new Error('Session path is outside the Antigravity folder');

  let found = false;
  for (const suffix of ['.db', '.db-wal', '.db-shm']) {
    const target = path.join(conversationsDir, `${id}${suffix}`);
    if (fs.existsSync(target)) { fs.unlinkSync(target); found = true; }
  }
  if (fs.existsSync(brainDir)) { fs.rmSync(brainDir, { recursive: true, force: true }); found = true; }

  const lastPath = path.join(root, 'cache', 'last_conversations.json');
  if (fs.existsSync(lastPath)) {
    try {
      const values = JSON.parse(fs.readFileSync(lastPath, 'utf8'));
      let changed = false;
      if (values && typeof values === 'object' && !Array.isArray(values)) {
        for (const [key, value] of Object.entries(values)) {
          if (String(value).toLowerCase() === id) { delete values[key]; changed = true; }
        }
      }
      if (changed) fs.writeFileSync(lastPath, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
    } catch {}
  }
  return found;
}

module.exports = {
  deleteAntigravitySession,
  loadAntigravitySessions,
  parseAntigravityMessages,
  parseAntigravitySession,
  projectHints,
  transcriptPath,
};
