#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');

const PORT = parseInt(process.argv[2]) || 3131;
const HOME = process.env.HOME || '/root';
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_PATH = path.join(__dirname, 'claude-gui-data.json');

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch { return {}; }
}
function saveData(obj) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(obj, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Session metadata ──────────────────────────────────────────────────
async function parseSession(filePath, projectDir) {
  const { size } = fs.statSync(filePath);
  const s = { id: path.basename(filePath, '.jsonl'), projectDir, title: '', cwd: '', firstTs: '', lastTs: '', msgCount: 0, summary: '', sizeBytes: size, ctxTokens: 0 };
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let d; try { d = JSON.parse(line); } catch { return; }
      switch (d.type) {
        case 'ai-title':   if (d.aiTitle) s.title = d.aiTitle; break;
        case 'user':       s.msgCount++; if (!s.cwd && d.cwd) s.cwd = d.cwd; if (!s.firstTs && d.timestamp) s.firstTs = d.timestamp; if (d.timestamp) s.lastTs = d.timestamp; break;
        case 'assistant':
          if (d.timestamp) s.lastTs = d.timestamp;
          if (d.message && d.message.usage) {
            const u = d.message.usage;
            s.ctxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
                        + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
          }
          break;
        case 'system':     if (d.subtype === 'away_summary' && d.content) s.summary = d.content; break;
      }
    });
    rl.on('close', resolve); rl.on('error', resolve);
  });
  return s;
}

async function loadSessions() {
  const sessions = [];
  if (!fs.existsSync(CLAUDE_PROJECTS)) return sessions;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dirPath = path.join(CLAUDE_PROJECTS, dir);
    try { if (!fs.statSync(dirPath).isDirectory()) continue; } catch { continue; }
    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))) {
      try { sessions.push(await parseSession(path.join(dirPath, file), dir)); } catch {}
    }
  }
  sessions.sort((a, b) => (b.lastTs || b.firstTs || '').localeCompare(a.lastTs || a.firstTs || ''));
  return sessions;
}

// ── Memory files (~/.claude/projects/<project>/memory/*.md) ───────────
const MEMORY_DIRNAME = 'memory';

function listMemoryProjects() {
  const out = [];
  if (!fs.existsSync(CLAUDE_PROJECTS)) return out;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const memDir = path.join(CLAUDE_PROJECTS, dir, MEMORY_DIRNAME);
    let files;
    try { files = fs.readdirSync(memDir).filter(f => f.endsWith('.md')); } catch { continue; }
    if (!files.length) continue;
    let mtime = 0, bytes = 0;
    for (const f of files) {
      try { const st = fs.statSync(path.join(memDir, f)); mtime = Math.max(mtime, st.mtimeMs); bytes += st.size; } catch {}
    }
    out.push({ projectDir: dir, fileCount: files.length, sizeBytes: bytes, mtime });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function readMemoryFiles(projectDir) {
  // single path segment only — blocks traversal (no slashes/backslashes)
  if (typeof projectDir !== 'string' || !/^[^/\\]+$/.test(projectDir)) throw new Error('invalid project');
  const memDir = path.join(CLAUDE_PROJECTS, projectDir, MEMORY_DIRNAME);
  if (!fs.existsSync(memDir)) throw new Error('no memory for project');
  const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
  files.sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)));
  return files.map(name => {
    const fp = path.join(memDir, name);
    const st = fs.statSync(fp);
    return { name, content: fs.readFileSync(fp, 'utf8'), sizeBytes: st.size, mtime: st.mtimeMs };
  });
}

function writeMemoryFile(projectDir, name, content) {
  if (typeof projectDir !== 'string' || !/^[^/\\]+$/.test(projectDir)) throw new Error('invalid project');
  if (typeof name !== 'string' || name.includes('..') || !/^[A-Za-z0-9._-]+\.md$/.test(name)) throw new Error('invalid file name');
  if (typeof content !== 'string') throw new Error('invalid content');
  const memDir = path.join(CLAUDE_PROJECTS, projectDir, MEMORY_DIRNAME);
  if (!fs.existsSync(memDir)) throw new Error('no memory for project');
  fs.writeFileSync(path.join(memDir, name), content);
  return { ok: true };
}

// ── Conversation messages ─────────────────────────────────────────────
function toolSummary(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Read':        return input.file_path || '';
    case 'Bash':        return (input.command || '').slice(0, 140);
    case 'Edit':        return input.file_path || '';
    case 'Write':       return input.file_path || '';
    case 'WebSearch':   return input.query || '';
    case 'WebFetch':    return (input.url || '').slice(0, 140);
    case 'Agent':       return (input.description || input.prompt || '').slice(0, 140);
    case 'Workflow':    return input.description || '';
    default: {
      const vals = Object.values(input);
      const v = vals[0];
      return (typeof v === 'string' ? v : JSON.stringify(input)).slice(0, 140);
    }
  }
}

function extractResultText(content) {
  if (!content) return { text: '', truncated: false };
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item && item.type === 'text' && item.text) text += item.text;
      else if (item && item.type === 'tool_reference') text += '[reference to large content]';
      else if (item && item.type === 'image') text += '[image]';
    }
  }
  const truncated = text.length > 5000;
  return { text: truncated ? text.slice(0, 5000) : text, truncated };
}

async function parseMessages(sessionId) {
  let filePath = null;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const candidate = path.join(CLAUDE_PROJECTS, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) { filePath = candidate; break; }
  }
  if (!filePath) throw new Error('Session not found');

  const messages = [];
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let d; try { d = JSON.parse(line); } catch { return; }

      if (d.type === 'user' || d.type === 'assistant') {
        const msg = d.message;
        if (!msg || !msg.content) return;
        const contentArr = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }];

        const parts = [];
        for (const c of contentArr) {
          if (!c || !c.type) continue;
          if (c.type === 'text' && c.text) {
            parts.push({ kind: 'text', text: c.text });
          } else if (c.type === 'tool_use') {
            parts.push({
              kind: 'tool_use',
              id: c.id || '',
              name: c.name || 'Tool',
              summary: toolSummary(c.name, c.input),
              inputJson: JSON.stringify(c.input || {}, null, 2).slice(0, 6000),
            });
          } else if (c.type === 'tool_result') {
            const { text, truncated } = extractResultText(c.content);
            parts.push({
              kind: 'tool_result',
              toolUseId: c.tool_use_id || '',
              text,
              truncated,
            });
          }
        }
        if (parts.length) messages.push({ type: 'turn', role: d.type, timestamp: d.timestamp || '', parts });

      } else if (d.type === 'system' && d.subtype === 'away_summary' && d.content) {
        messages.push({ type: 'summary', text: d.content, timestamp: d.timestamp || '' });
      }
    });
    rl.on('close', resolve); rl.on('error', resolve);
  });

  return messages;
}

// ── HTTP server ───────────────────────────────────────────────────────
let cache = null;

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  const { method } = req;

  // Serve the SPA
  if (method === 'GET' && (pathname === '/' || pathname === '')) {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
    } catch { res.writeHead(500); return res.end('Could not read public/index.html'); }
  }

  // Session list
  if (method === 'GET' && pathname === '/api/sessions') {
    try {
      if (!cache) cache = await loadSessions();
      return jsonResponse(res, cache);
    } catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Session conversation messages
  if (method === 'GET' && /^\/api\/sessions\/[0-9a-f-]{36}\/messages$/.test(pathname)) {
    const id = pathname.split('/')[3];
    try { return jsonResponse(res, await parseMessages(id)); }
    catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Force refresh session list
  if (method === 'POST' && pathname === '/api/refresh') {
    try { cache = await loadSessions(); return jsonResponse(res, cache); }
    catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Delete a session
  if (method === 'DELETE' && pathname.startsWith('/api/sessions/')) {
    const id = pathname.split('/').pop();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      return jsonResponse(res, { error: 'invalid session id' }, 400);
    cache = null;
    let found = false;
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
      const dirPath = path.join(CLAUDE_PROJECTS, dir);
      try { if (!fs.statSync(dirPath).isDirectory()) continue; } catch { continue; }
      const jsonlPath = path.join(dirPath, `${id}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        fs.unlinkSync(jsonlPath);
        const companion = path.join(dirPath, id);
        if (fs.existsSync(companion)) fs.rmSync(companion, { recursive: true, force: true });
        found = true; break;
      }
    }
    return jsonResponse(res, { success: found }, found ? 200 : 404);
  }

  // Read settings
  if (method === 'GET' && pathname === '/api/settings') {
    try { return jsonResponse(res, JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))); }
    catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Update settings
  if (method === 'PATCH' && pathname === '/api/settings') {
    try {
      const body = await readBody(req);
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      if ('cleanupPeriodDays' in body) {
        const days = Number(body.cleanupPeriodDays);
        if (Number.isFinite(days) && days >= 0) settings.cleanupPeriodDays = Math.round(days);
      }
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
      return jsonResponse(res, settings);
    } catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Pins — persisted to the local app data file (claude-gui-data.json)
  if (method === 'GET' && pathname === '/api/pins') {
    const data = loadData();
    return jsonResponse(res, { pins: Array.isArray(data.pins) ? data.pins : [] });
  }
  if (method === 'PUT' && pathname === '/api/pins') {
    try {
      const body = await readBody(req);
      const pins = Array.isArray(body.pins) ? body.pins.filter(x => typeof x === 'string') : [];
      const data = loadData();
      data.pins = pins;
      saveData(data);
      return jsonResponse(res, { pins });
    } catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Memory: list projects that have memory files
  if (method === 'GET' && pathname === '/api/memory') {
    try { return jsonResponse(res, listMemoryProjects()); }
    catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }
  // Memory: read all memory files for one project
  if (method === 'GET' && pathname === '/api/memory/files') {
    const project = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('project') || '';
    try { return jsonResponse(res, readMemoryFiles(project)); }
    catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }
  // Memory: write one memory file
  if (method === 'PUT' && pathname === '/api/memory/file') {
    try {
      const body = await readBody(req);
      return jsonResponse(res, writeMemoryFile(body.project, body.name, body.content));
    } catch (e) { return jsonResponse(res, { error: e.message }, 400); }
  }

  res.writeHead(404); res.end('Not found');
});

function openBrowser(url) {
  // WSL: use Windows cmd.exe to open in the Windows default browser
  if (process.env.WSL_DISTRO_NAME || process.env.WSLENV || fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
    exec(`/mnt/c/Windows/System32/cmd.exe /c start "" "${url}"`, err => {
      if (err) exec(`xdg-open "${url}"`, () => {});
    });
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`, () => {});
  }
}

server.listen(PORT, () => {
  const siteUrl = `http://localhost:${PORT}`;
  process.stdout.write('\x1b[2J\x1b[H');
  console.log('\n  \x1b[32m◆ Claude Sessions\x1b[0m\n');
  console.log(`  ${siteUrl}`);
  console.log(`  Sessions: ${CLAUDE_PROJECTS}`);
  console.log('  Ctrl+C to stop\n');
  openBrowser(siteUrl);
});

process.on('SIGINT', () => { console.log('\n  Stopped.\n'); server.close(() => process.exit(0)); });
