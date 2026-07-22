#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { exec, execFile } = require('child_process');
const { deleteCodexSessionFile, loadCodexSessions, parseCodexMessages } = require('./codex-sessions');
const { deleteAntigravitySession, loadAntigravitySessions, parseAntigravityMessages } = require('./antigravity-sessions');
const { loadChatGptSessions, parseChatGptMessages, validateChatGptExportPath } = require('./chatgpt-sessions');
const { loadClaudeExportSessions, parseClaudeExportMessages, validateClaudeExportPath } = require('./claude-export-sessions');
const {
  deleteCodexMemoryFile,
  listCodexMemoryProject,
  loadCodexPlugins,
  readCodexMemoryFiles,
  writeCodexMemoryFile,
} = require('./codex-data');
const { normalizeDisplayPath, resolveClaudeProjectDir } = require('./session-paths');

// Default port differs per environment so a Windows instance and a WSL instance
// can both run at once. WSL2 forwards localhost to Windows, so sharing a default
// would make one instance mistake the other for itself.
const DEFAULT_PORT = process.platform === 'win32' ? 3132 : 3131;
const PORT = Number.isInteger(parseInt(process.argv[2])) ? parseInt(process.argv[2]) : DEFAULT_PORT;
const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const ANTIGRAVITY_HOME = process.env.ANTIGRAVITY_HOME || path.join(HOME, '.gemini', 'antigravity-cli');
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const PLUGINS_DIR = path.join(HOME, '.claude', 'plugins');
const INSTALLED_PLUGINS = path.join(PLUGINS_DIR, 'installed_plugins.json');
const KNOWN_MARKETPLACES = path.join(PLUGINS_DIR, 'known_marketplaces.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_PATH = path.join(__dirname, 'claude-gui-data.json');

// WSL must be detected as Linux specifically — Windows also sets WSLENV when
// interop is enabled, so that var alone would misclassify native Windows as WSL.
const IS_WSL = process.platform === 'linux' &&
  !!(process.env.WSL_DISTRO_NAME || fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'));

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch { return {}; }
}
function saveData(obj) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(obj, null, 2));
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
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
// Gathers only spoken text: user prompts and assistant prose. Tool results
// arrive as user-role tool_result parts and tool calls as assistant tool_use
// parts — both are top-level types other than 'text', so both are excluded
// and content search matches what was *said*, not every file Claude read.
function collectSpokenText(content, out) {
  if (typeof content === 'string') { if (content) out.push(content); return; }
  if (!Array.isArray(content)) return;
  for (const p of content) if (p && p.type === 'text' && p.text) out.push(p.text);
}

async function parseSession(filePath, projectDir, fallbackCwd = '') {
  const { size } = fs.statSync(filePath);
  const id = path.basename(filePath, '.jsonl');
  const s = { provider: 'claude', key: id, id, projectDir, projectKey: '', title: '', cwd: '', firstTs: '', lastTs: '', msgCount: 0, summary: '', sizeBytes: size, ctxTokens: 0, contextWindow: 0, source: 'claude', isSubagent: false, archived: false };
  const spoken = [];
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let d; try { d = JSON.parse(line); } catch { return; }
      if (!s.cwd && d.cwd) s.cwd = normalizeDisplayPath(d.cwd);
      switch (d.type) {
        case 'ai-title':   if (d.aiTitle) s.title = d.aiTitle; break;
        case 'user':
          s.msgCount++; if (!s.firstTs && d.timestamp) s.firstTs = d.timestamp; if (d.timestamp) s.lastTs = d.timestamp;
          if (!d.isMeta && d.message) collectSpokenText(d.message.content, spoken);  // isMeta = harness-injected, not the user
          break;
        case 'assistant':
          if (d.timestamp) s.lastTs = d.timestamp;
          if (d.message) collectSpokenText(d.message.content, spoken);
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
  // Held server-side for /api/search; stripped from /api/sessions responses.
  s.cwd = normalizeDisplayPath(s.cwd || fallbackCwd);
  s.searchText = spoken.join('\n');
  s.searchLower = s.searchText.toLowerCase();
  s.projectKey = s.cwd || s.projectDir;
  return s;
}

// Sessions as sent to the client — without the in-memory search text.
function publicSessions(list) {
  return list.map(({ searchText, searchLower, filePath, rawConversation, ...rest }) => rest);
}

// Strip decoration that renders as an unbreakable line when whitespace is
// collapsed: box-drawing/block glyphs (tables, dividers) and long runs of a
// repeated punctuation char (---- ==== ____ ....). Keeps real words intact.
function cleanSnippet(text) {
  return text
    .replace(/[─-▟]+/g, ' ')      // box-drawing + block element glyphs
    .replace(/([^\w\s])\1{3,}/g, '$1')      // 4+ repeats of one punctuation → single
    .replace(/\s+/g, ' ')
    .trim();
}

// "…context MATCH context…" excerpt around the first hit. Cleaned of table/divider
// art so it reads as text. Widen the raw window since cleaning removes characters.
function makeSnippet(text, idx, qLen) {
  const start = Math.max(0, idx - 80);
  const end = Math.min(text.length, idx + qLen + 160);
  const snip = cleanSnippet(text.slice(start, end));
  return (start > 0 ? '…' : '') + snip + (end < text.length ? '…' : '');
}

async function loadClaudeSessions() {
  const sessions = [];
  if (!fs.existsSync(CLAUDE_PROJECTS)) return sessions;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dirPath = path.join(CLAUDE_PROJECTS, dir);
    try { if (!fs.statSync(dirPath).isDirectory()) continue; } catch { continue; }
    const fallbackCwd = resolveClaudeProjectDir(dir);
    const projectSessions = [];
    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))) {
      try { projectSessions.push(await parseSession(path.join(dirPath, file), dir, fallbackCwd)); } catch {}
    }
    // Claude groups sessions by working directory. If one transcript records
    // cwd, use it for older/sparse transcripts in the same project folder.
    const projectCwd = projectSessions.find(session => session.cwd)?.cwd || fallbackCwd;
    for (const session of projectSessions) {
      session.cwd = normalizeDisplayPath(session.cwd || projectCwd);
      session.projectKey = session.cwd || session.projectDir;
      sessions.push(session);
    }
  }
  return sessions;
}

async function loadSessions() {
  const [claudeSessions, codexSessions, antigravitySessions] = await Promise.all([
    loadClaudeSessions(),
    loadCodexSessions(CODEX_HOME),
    loadAntigravitySessions(ANTIGRAVITY_HOME),
  ]);
  const data = loadData();
  const chatGptSessions = loadChatGptSessions(String(data.chatgptExportPath || '').trim());
  const claudeExportSessions = loadClaudeExportSessions(String(data.claudeExportPath || '').trim());
  return [...claudeSessions, ...codexSessions, ...antigravitySessions, ...chatGptSessions, ...claudeExportSessions]
    .sort((a, b) => (b.lastTs || b.firstTs || '').localeCompare(a.lastTs || a.firstTs || ''));
}

// ── Memory files (~/.claude/projects/<project>/memory/*.md) ───────────
const MEMORY_DIRNAME = 'memory';

function listMemoryProjects() {
  const out = [];
  if (fs.existsSync(CLAUDE_PROJECTS)) {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
      const memDir = path.join(CLAUDE_PROJECTS, dir, MEMORY_DIRNAME);
      let files;
      try { files = fs.readdirSync(memDir).filter(f => f.endsWith('.md')); } catch { continue; }
      if (!files.length) continue;
      let mtime = 0, bytes = 0;
      for (const f of files) {
        try { const st = fs.statSync(path.join(memDir, f)); mtime = Math.max(mtime, st.mtimeMs); bytes += st.size; } catch {}
      }
      out.push({
        provider: 'claude', key: `claude:${dir}`, projectDir: dir,
        path: resolveClaudeProjectDir(dir) || dir,
        fileCount: files.length, sizeBytes: bytes, mtime,
      });
    }
  }
  const codex = listCodexMemoryProject(CODEX_HOME);
  if (codex) out.push(codex);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function readMemoryFiles(provider, projectDir) {
  if (provider === 'codex') return readCodexMemoryFiles(CODEX_HOME);
  if (provider !== 'claude') throw new Error('invalid provider');
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

function writeMemoryFile(provider, projectDir, name, content) {
  if (provider === 'codex') return writeCodexMemoryFile(CODEX_HOME, name, content);
  if (provider !== 'claude') throw new Error('invalid provider');
  if (typeof projectDir !== 'string' || !/^[^/\\]+$/.test(projectDir)) throw new Error('invalid project');
  if (typeof name !== 'string' || name.includes('..') || !/^[A-Za-z0-9._-]+\.md$/.test(name)) throw new Error('invalid file name');
  if (typeof content !== 'string') throw new Error('invalid content');
  const memDir = path.join(CLAUDE_PROJECTS, projectDir, MEMORY_DIRNAME);
  if (!fs.existsSync(memDir)) throw new Error('no memory for project');
  fs.writeFileSync(path.join(memDir, name), content);
  return { ok: true };
}

function deleteMemoryFile(provider, projectDir, name) {
  if (provider === 'codex') return deleteCodexMemoryFile(CODEX_HOME, name);
  if (provider !== 'claude') throw new Error('invalid provider');
  if (typeof projectDir !== 'string' || !/^[^/\\]+$/.test(projectDir)) throw new Error('invalid project');
  if (typeof name !== 'string' || name.includes('..') || !/^[A-Za-z0-9._-]+\.md$/.test(name)) throw new Error('invalid file name');
  const fp = path.join(CLAUDE_PROJECTS, projectDir, MEMORY_DIRNAME, name);
  if (!fs.existsSync(fp)) throw new Error('file not found');
  fs.unlinkSync(fp);
  return { ok: true };
}

// ── Plugins (~/.claude/plugins) ───────────────────────────────────────
// Source of truth is installed_plugins.json — each key is "<plugin>@<marketplace>"
// mapping to an array of installs (one per scope/project). Content is read from
// each install's pinned cache dir (installPath), never from a user's dev clone.
const TEXT_EXT = new Set(['md','txt','py','js','ts','jsx','tsx','sh','bash','json','yaml','yml','toml','r','rmd','sql','css','html','xml','xsd','csv','ini','cfg','env','rb','go','rs','c','h','cpp','java','lua','pl']);

function fileKind(name) {
  if (name.toLowerCase().endsWith('.md')) return 'md';
  const ext = (name.split('.').pop() || '').toLowerCase();
  return TEXT_EXT.has(ext) ? 'code' : 'binary';
}

// "Official" = Anthropic's official marketplace only (claude-plugins-official).
// Other Anthropic repos (e.g. anthropics/skills) are NOT the official marketplace.
function classifyOrigin(repo, marketplace) {
  const r = String(repo || '').toLowerCase();
  if (marketplace === 'claude-plugins-official' || r === 'anthropics/claude-plugins-official') return 'official';
  return 'third-party';
}

function componentCounts(installPath) {
  const c = { skills: 0, commands: 0, agents: 0 };
  for (const k of Object.keys(c)) {
    try {
      const ents = fs.readdirSync(path.join(installPath, k), { withFileTypes: true });
      c[k] = k === 'skills' ? ents.filter(e => e.isDirectory()).length : ents.filter(e => e.isFile() || e.isDirectory()).length;
    } catch {}
  }
  return c;
}

function loadClaudePlugins() {
  const installed = readJson(INSTALLED_PLUGINS);
  const markets = readJson(KNOWN_MARKETPLACES);
  const settings = readJson(SETTINGS_PATH);
  const enabledMap = settings.enabledPlugins || {};
  const out = [];
  for (const key of Object.keys(installed.plugins || {})) {
    const at = key.lastIndexOf('@');
    const pname = at >= 0 ? key.slice(0, at) : key;
    const marketplace = at >= 0 ? key.slice(at + 1) : '';
    const repo = (markets[marketplace] && markets[marketplace].source) ? markets[marketplace].source.repo : '';
    const arr = installed.plugins[key];
    if (!Array.isArray(arr)) continue;
    arr.forEach((entry, idx) => {
      const meta = readJson(path.join(entry.installPath, '.claude-plugin', 'plugin.json'));
      const counts = componentCounts(entry.installPath);
      out.push({
        id: `${key}::${idx}`,
        provider: 'claude',
        key, name: meta.name || pname, marketplace, repo,
        description: meta.description || '',
        scope: entry.scope || 'user',
        projectPath: entry.projectPath || '',
        version: String(entry.version || '').slice(0, 12),
        origin: classifyOrigin(repo, marketplace),
        enabled: key in enabledMap ? !!enabledMap[key] : null,
        skills: counts.skills, commands: counts.commands, agents: counts.agents,
        installedAt: entry.installedAt || '', lastUpdated: entry.lastUpdated || '',
      });
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  return out;
}

let codexPluginEntries = new Map();

function loadPlugins(sessions = []) {
  const codex = loadCodexPlugins(CODEX_HOME, HOME, sessions);
  codexPluginEntries = new Map(codex.map(entry => [entry.id, entry]));
  const publicCodex = codex.map(({ installPath, skillRoot, skillNames, ...entry }) => entry);
  return [...loadClaudePlugins(), ...publicCodex]
    .sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
}

function findPluginEntry(id) {
  if (typeof id !== 'string') throw new Error('invalid id');
  if (id.startsWith('codex::')) {
    const entry = codexPluginEntries.get(id);
    if (!entry) throw new Error('plugin not found');
    return entry;
  }
  const sep = id.lastIndexOf('::');
  if (sep < 0) throw new Error('invalid id');
  const key = id.slice(0, sep);
  const idx = parseInt(id.slice(sep + 2), 10);
  const arr = (readJson(INSTALLED_PLUGINS).plugins || {})[key];
  if (!Array.isArray(arr) || !arr[idx] || !arr[idx].installPath) throw new Error('plugin not found');
  return arr[idx];
}

function listFilesRel(dir, root) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= 500 || e.name.startsWith('.')) continue;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.isFile()) {
        let size = 0; try { size = fs.statSync(fp).size; } catch {}
        out.push({ rel: path.relative(root, fp).split(path.sep).join('/'), size, kind: fileKind(e.name) });
      }
    }
  };
  walk(dir);
  return out;
}

function readPluginSkills(id) {
  const entry = findPluginEntry(id);
  const root = entry.installPath;
  const skillsRoot = entry.skillRoot || path.join(root, 'skills');
  const result = { readme: '', skills: [], commands: [], agents: [] };
  for (const r of ['README.md', 'readme.md']) {
    const p = path.join(root, r);
    try { if (fs.statSync(p).size < 200000) { result.readme = fs.readFileSync(p, 'utf8'); break; } } catch {}
  }
  let dirs = Array.isArray(entry.skillNames) ? entry.skillNames : [];
  if (!Array.isArray(entry.skillNames)) {
    try { dirs = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch {}
  }
  for (const name of dirs) {
    const sdir = path.join(skillsRoot, name);
    let skillMd = ''; try { skillMd = fs.readFileSync(path.join(sdir, 'SKILL.md'), 'utf8'); } catch {}
    const extraFiles = listFilesRel(sdir, root).filter(f => path.basename(f.rel) !== 'SKILL.md');
    result.skills.push({ name, skillMd, extraFiles });
  }
  for (const k of ['commands', 'agents']) {
    try { result[k] = fs.readdirSync(path.join(root, k), { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name); } catch {}
  }
  return result;
}

function pluginFileAbsPath(id, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new Error('invalid path');
  const root = fs.realpathSync(path.resolve(findPluginEntry(id).installPath));
  const fp = path.resolve(root, rel);
  if (fp !== root && !fp.startsWith(root + path.sep)) throw new Error('invalid path');  // confine to the install dir
  if (!fs.existsSync(fp)) throw new Error('file not found');
  const real = fs.realpathSync(fp);  // a symlink inside the dir must not point outside it
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('invalid path');
  return real;
}

// Open a bundled file in the native "How do you want to open this file?" chooser.
// Two Windows quirks shape this:
//   1. The chooser (OpenAs_RunDLL) no-ops on WSL UNC paths (\\wsl.localhost\…),
//      so under WSL we copy the file into a Windows-local temp dir first.
//   2. OpenAs_RunDLL mis-parses any path containing a SPACE (e.g. a "C:\Users\
//      Daniel Burkhalter\…" home) — it launches but shows only a ghost taskbar
//      entry, no dialog. So we always convert to the 8.3 short path (no spaces)
//      before invoking it. (This is why WSL appeared to work: %TEMP% resolved to
//      a short, space-free path by chance.)
// Mac/Linux just open the default app for the type.
const RUNDLL = IS_WSL ? '/mnt/c/Windows/System32/rundll32.exe' : 'rundll32.exe';
const OPENAS = 'shell32.dll,OpenAs_RunDLL';
const NOWIN = { windowsHide: true };  // suppress the console-window flash on Windows
let winTempDir = null;  // WSL path to a Windows-local scratch dir, resolved once

// All OS-launch commands use execFile with an argument array (never a shell
// string) so a malicious plugin filename can't inject shell commands.
function ensureWinTemp(cb) {
  if (winTempDir) return cb(winTempDir);
  execFile('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %TEMP%'], NOWIN, (e, out) => {
    const win = (out || '').trim();
    if (e || !win) return cb(null);
    execFile('wslpath', ['-u', win], (e2, out2) => {
      const base = (out2 || '').trim();
      if (e2 || !base) return cb(null);
      const dir = path.join(base, 'claude-gui-open');
      try {
        fs.rmSync(dir, { recursive: true, force: true });  // clear stale copies once per run
        fs.mkdirSync(dir, { recursive: true });
        winTempDir = dir; cb(dir);
      } catch { cb(null); }
    });
  });
}

// Spawn a launcher and report cb(err) on *spawn*, not on exit — the OpenAs
// chooser keeps rundll32 alive until the dialog is dismissed, so waiting for
// exit would hang the HTTP request until the user picks an app.
// NOTE: no windowsHide here — rundll32's own window IS the "Open with" dialog,
// so hiding it would leave only a taskbar icon with no visible chooser.
function spawnLauncher(file, args, cb) {
  let done = false;
  const finish = (err) => { if (!done) { done = true; cb(err); } };
  try {
    const child = execFile(file, args);
    child.on('error', finish);            // e.g. launcher binary not found
    child.on('spawn', () => finish(null));
    child.unref();
  } catch (e) { finish(e); }
}

// Resolve a Windows path to its 8.3 short form (no spaces) via the FileSystemObject,
// then hand it to the chooser. Falls back to the long path if 8.3 is unavailable.
function openWithChooser(winPath, cb) {
  const script = `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${winPath.replace(/'/g, "''")}').ShortPath`;
  execFile('powershell.exe', ['-NoProfile', '-Command', script], NOWIN, (e, out) => {
    const short = (out || '').trim() || winPath;
    spawnLauncher(RUNDLL, [OPENAS, short], cb);
  });
}

// Opens absPath in the OS "Open with" chooser (Windows) or default app. cb(err)
// reports whether the launcher started, so the UI doesn't claim a false success.
function openExternal(absPath, cb = () => {}) {
  if (IS_WSL) {
    // The chooser no-ops on \\wsl.localhost\ UNC paths, so copy to a local C: dir first.
    ensureWinTemp((dir) => {
      if (!dir) return spawnLauncher('xdg-open', [absPath], cb);
      const dest = path.join(dir, path.basename(absPath));
      try { fs.copyFileSync(absPath, dest); } catch (e) { return cb(e); }
      execFile('wslpath', ['-w', dest], (e, out) => {
        const win = (out || '').trim();
        if (e || !win) return cb(e || new Error('path conversion failed'));
        openWithChooser(win, cb);
      });
    });
  } else if (process.platform === 'win32') {
    openWithChooser(absPath, cb);
  } else if (process.platform === 'darwin') {
    spawnLauncher('open', [absPath], cb);
  } else {
    spawnLauncher('xdg-open', [absPath], cb);
  }
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

async function parseClaudeMessages(sessionId) {
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
        if (parts.length) messages.push({ type: 'turn', role: d.type, provider: 'claude', timestamp: d.timestamp || '', parts });

      } else if (d.type === 'system' && d.subtype === 'away_summary' && d.content) {
        messages.push({ type: 'summary', provider: 'claude', text: d.content, timestamp: d.timestamp || '' });
      }
    });
    rl.on('close', resolve); rl.on('error', resolve);
  });

  return messages;
}

// ── HTTP server ───────────────────────────────────────────────────────
let cache = null;

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = requestUrl;
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
      return jsonResponse(res, publicSessions(cache));
    } catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Content search over user/assistant message text.
  // Returns { <sessionId>: <snippet> } for every session containing the query.
  if (method === 'GET' && pathname === '/api/search') {
    try {
      const q = (requestUrl.searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return jsonResponse(res, {});
      if (!cache) cache = await loadSessions();
      const out = {};
      for (const s of cache) {
        const i = s.searchLower.indexOf(q);
        if (i >= 0) out[s.key || s.id] = makeSnippet(s.searchText, i, q.length);
      }
      return jsonResponse(res, out);
    } catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Session conversation messages
  if (method === 'GET' && /^\/api\/sessions\/[0-9a-f-]{36}\/messages$/.test(pathname)) {
    const id = pathname.split('/')[3];
    const provider = requestUrl.searchParams.get('provider') || 'claude';
    try {
      if (provider === 'codex') {
        if (!cache) cache = await loadSessions();
        const session = cache.find(s => s.provider === 'codex' && s.id === id);
        if (!session || !session.filePath) return jsonResponse(res, { error: 'Session not found' }, 404);
        return jsonResponse(res, await parseCodexMessages(session.filePath));
      }
      if (provider === 'antigravity') {
        if (!cache) cache = await loadSessions();
        const session = cache.find(s => s.provider === 'antigravity' && s.id === id);
        if (!session || !session.filePath) return jsonResponse(res, { error: 'Session not found' }, 404);
        return jsonResponse(res, await parseAntigravityMessages(session.filePath));
      }
      if (provider === 'chatgpt') {
        if (!cache) cache = await loadSessions();
        const session = cache.find(s => s.provider === 'chatgpt' && s.id === id);
        if (!session || !session.rawConversation) return jsonResponse(res, { error: 'Session not found' }, 404);
        return jsonResponse(res, parseChatGptMessages(session.rawConversation));
      }
      if (provider === 'claude-export') {
        if (!cache) cache = await loadSessions();
        const session = cache.find(s => s.provider === 'claude-export' && s.id === id);
        if (!session || !session.rawConversation) return jsonResponse(res, { error: 'Session not found' }, 404);
        return jsonResponse(res, parseClaudeExportMessages(session.rawConversation));
      }
      if (provider !== 'claude') return jsonResponse(res, { error: 'Unknown session provider' }, 400);
      return jsonResponse(res, await parseClaudeMessages(id));
    }
    catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Force refresh session list
  if (method === 'POST' && pathname === '/api/refresh') {
    try { cache = await loadSessions(); return jsonResponse(res, publicSessions(cache)); }
    catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Delete a session
  if (method === 'DELETE' && pathname.startsWith('/api/sessions/')) {
    const provider = requestUrl.searchParams.get('provider') || 'claude';
    const id = pathname.split('/').pop();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      return jsonResponse(res, { error: 'invalid session id' }, 400);

    if (provider === 'codex') {
      try {
        if (!cache) cache = await loadSessions();
        const session = cache.find(s => s.provider === 'codex' && s.id === id);
        if (!session || !session.filePath) return jsonResponse(res, { error: 'session not found' }, 404);
        if (!deleteCodexSessionFile(CODEX_HOME, session))
          return jsonResponse(res, { error: 'session not found' }, 404);
        cache = null;
        return jsonResponse(res, { success: true });
      } catch (e) {
        return jsonResponse(res, { error: e.message }, 500);
      }
    }
    if (provider === 'antigravity') {
      try {
        if (!cache) cache = await loadSessions();
        const session = cache.find(s => s.provider === 'antigravity' && s.id === id);
        if (!session) return jsonResponse(res, { error: 'session not found' }, 404);
        if (!await deleteAntigravitySession(ANTIGRAVITY_HOME, session))
          return jsonResponse(res, { error: 'session not found' }, 404);
        cache = null;
        return jsonResponse(res, { success: true });
      } catch (e) { return jsonResponse(res, { error: e.message }, 500); }
    }
    if (provider !== 'claude') return jsonResponse(res, { error: 'Unknown session provider' }, 400);

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
    try {
      const settings = readJson(SETTINGS_PATH);
      const data = loadData();
      settings.chatgptExportPath = String(data.chatgptExportPath || '');
      settings.claudeExportPath = String(data.claudeExportPath || '');
      return jsonResponse(res, settings);
    }
    catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  // Update settings
  if (method === 'PATCH' && pathname === '/api/settings') {
    try {
      const body = await readBody(req);
      const settings = readJson(SETTINGS_PATH);
      const data = loadData();
      const chatgptExportPath = 'chatgptExportPath' in body
        ? String(body.chatgptExportPath || '').trim()
        : String(data.chatgptExportPath || '');
      const claudeExportPath = 'claudeExportPath' in body
        ? String(body.claudeExportPath || '').trim()
        : String(data.claudeExportPath || '');
      validateChatGptExportPath(chatgptExportPath);
      validateClaudeExportPath(claudeExportPath);
      if ('cleanupPeriodDays' in body) {
        const days = Number(body.cleanupPeriodDays);
        if (Number.isFinite(days) && days >= 1) settings.cleanupPeriodDays = Math.round(days);  // Claude Code rejects 0; minimum is 1
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
      }
      data.chatgptExportPath = chatgptExportPath;
      data.claudeExportPath = claudeExportPath;
      saveData(data);
      cache = null;
      return jsonResponse(res, { ...settings, chatgptExportPath, claudeExportPath });
    } catch (e) { return jsonResponse(res, { error: e.message }, 400); }
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
    const project = requestUrl.searchParams.get('project') || '';
    const provider = requestUrl.searchParams.get('provider') || 'claude';
    try { return jsonResponse(res, readMemoryFiles(provider, project)); }
    catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }
  // Memory: write one memory file
  if (method === 'PUT' && pathname === '/api/memory/file') {
    try {
      const body = await readBody(req);
      return jsonResponse(res, writeMemoryFile(body.provider || 'claude', body.project, body.name, body.content));
    } catch (e) { return jsonResponse(res, { error: e.message }, 400); }
  }
  // Memory: delete one memory file
  if (method === 'DELETE' && pathname === '/api/memory/file') {
    try {
      const body = await readBody(req);
      return jsonResponse(res, deleteMemoryFile(body.provider || 'claude', body.project, body.name));
    } catch (e) { return jsonResponse(res, { error: e.message }, 400); }
  }

  // Plugins: list installed plugins
  if (method === 'GET' && pathname === '/api/plugins') {
    try {
      if (!cache) cache = await loadSessions();
      return jsonResponse(res, loadPlugins(cache));
    }
    catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }
  // Plugins: skills + bundled-file manifest for one install
  if (method === 'GET' && pathname === '/api/plugins/skills') {
    const id = requestUrl.searchParams.get('id') || '';
    try {
      if (id.startsWith('codex::') && !codexPluginEntries.has(id)) {
        if (!cache) cache = await loadSessions();
        loadPlugins(cache);
      }
      return jsonResponse(res, readPluginSkills(id));
    }
    catch (e) { return jsonResponse(res, { error: e.message }, 400); }
  }
  // Plugins: open a bundled file in the user's editor (OS "Open with")
  if (method === 'POST' && pathname === '/api/plugins/open') {
    try {
      const body = await readBody(req);
      if (String(body.id || '').startsWith('codex::') && !codexPluginEntries.has(body.id)) {
        if (!cache) cache = await loadSessions();
        loadPlugins(cache);
      }
      const fp = pluginFileAbsPath(body.id || '', body.rel || '');
      await new Promise((resolve, reject) => openExternal(fp, (err) => err ? reject(err) : resolve()));
      return jsonResponse(res, { ok: true });
    } catch (e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  res.writeHead(404); res.end('Not found');
});

function openBrowser(url) {
  // url is our own http://localhost:<port> (port is an int), so it's safe to pass.
  if (IS_WSL) {  // use Windows cmd.exe to open in the Windows default browser
    execFile('/mnt/c/Windows/System32/cmd.exe', ['/c', 'start', '', url], NOWIN, err => {
      if (err) execFile('xdg-open', [url], () => {});
    });
  } else if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], NOWIN, () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

function banner(port) {
  const siteUrl = `http://localhost:${port}`;
  process.stdout.write('\x1b[2J\x1b[H');
  console.log('\n  \x1b[32m◆ Agent Sessions\x1b[0m\n');
  console.log(`  ${siteUrl}`);
  console.log(`  Claude: ${CLAUDE_PROJECTS}`);
  console.log(`  Codex:  ${path.join(CODEX_HOME, 'sessions')}`);
  console.log(`  AGY:    ${path.join(ANTIGRAVITY_HOME, 'conversations')}`);
  console.log('  Ctrl+C to stop\n');
  if (process.env.CLAUDE_GUI_NO_BROWSER !== '1') openBrowser(siteUrl);
}

// Is claude-gui already serving on this port? (used to handle a busy port nicely)
function claudeGuiAlreadyOn(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/sessions', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(Array.isArray(JSON.parse(body))); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function start(port) {
  server.once('error', async (err) => {
    if (err.code !== 'EADDRINUSE') {
      console.error(`\n  Could not start claude-gui: ${err.message}\n`);
      process.exit(1);
    }
    if (await claudeGuiAlreadyOn(port)) {
      console.log(`\n  \x1b[32m◆ Agent Sessions\x1b[0m is already running at http://localhost:${port}\n  Opening it in your browser...\n`);
      openBrowser(`http://localhost:${port}`);
      process.exit(0);
    }
    console.error(`\n  Port ${port} is in use by another program.\n  Start claude-gui on a different port:\n    claude-gui ${port + 1}\n`);
    process.exit(1);
  });
  server.listen(port, () => banner(port));
}

start(PORT);

process.on('SIGINT', () => { console.log('\n  Stopped.\n'); server.close(() => process.exit(0)); });
