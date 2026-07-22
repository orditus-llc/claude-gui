'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeDisplayPath } = require('./session-paths');

const MAX_FILES = 500;

function markdownFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const pending = [root];
  while (pending.length && out.length < MAX_FILES) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (out.length >= MAX_FILES || entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(fullPath);
    }
  }
  return out;
}

function memoryRoot(codexHome) {
  return path.join(codexHome, 'memories');
}

function memoryFilePath(codexHome, name, mustExist = false) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\'))
    throw new Error('invalid file name');
  const root = path.resolve(memoryRoot(codexHome));
  const target = path.resolve(root, ...name.split('/'));
  if (!name.toLowerCase().endsWith('.md') || target === root || !target.startsWith(`${root}${path.sep}`))
    throw new Error('invalid file name');
  if (mustExist && !fs.existsSync(target)) throw new Error('file not found');
  if (mustExist) {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (!realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error('invalid file name');
  }
  return target;
}

function listCodexMemoryProject(codexHome) {
  const root = memoryRoot(codexHome);
  const files = markdownFiles(root);
  if (!files.length) return null;
  let mtime = 0;
  let sizeBytes = 0;
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      mtime = Math.max(mtime, stat.mtimeMs);
      sizeBytes += stat.size;
    } catch {}
  }
  return {
    provider: 'codex', key: 'codex:memories', projectDir: 'memories',
    path: normalizeDisplayPath(root), fileCount: files.length, sizeBytes, mtime,
  };
}

function readCodexMemoryFiles(codexHome) {
  const root = memoryRoot(codexHome);
  if (!fs.existsSync(root)) throw new Error('no Codex memory');
  const files = markdownFiles(root);
  files.sort((a, b) => {
    const ar = path.relative(root, a).split(path.sep).join('/');
    const br = path.relative(root, b).split(path.sep).join('/');
    const am = path.basename(ar).toUpperCase() === 'MEMORY.MD';
    const bm = path.basename(br).toUpperCase() === 'MEMORY.MD';
    return am === bm ? ar.localeCompare(br) : am ? -1 : 1;
  });
  return files.map(filePath => {
    const stat = fs.statSync(filePath);
    return {
      name: path.relative(root, filePath).split(path.sep).join('/'),
      content: fs.readFileSync(filePath, 'utf8'), sizeBytes: stat.size, mtime: stat.mtimeMs,
    };
  });
}

function writeCodexMemoryFile(codexHome, name, content) {
  if (typeof content !== 'string') throw new Error('invalid content');
  const root = memoryRoot(codexHome);
  if (!fs.existsSync(root)) throw new Error('no Codex memory');
  // The GUI edits files it just listed; requiring the target to exist also
  // lets us realpath-check every write and prevents a symlinked parent from
  // redirecting an API request outside the Codex memory directory.
  fs.writeFileSync(memoryFilePath(codexHome, name, true), content);
  return { ok: true };
}

function deleteCodexMemoryFile(codexHome, name) {
  fs.unlinkSync(memoryFilePath(codexHome, name, true));
  return { ok: true };
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function hashPath(value) {
  return crypto.createHash('sha256').update(path.resolve(value)).digest('hex').slice(0, 16);
}

function skillDirs(root, excluded = new Set()) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !excluded.has(entry.name) && fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort();
}

function remotePluginRoots(codexHome) {
  const cacheRoot = path.join(codexHome, 'plugins', 'cache');
  if (!fs.existsSync(cacheRoot)) return [];
  const roots = [];
  const pending = [{ dir: cacheRoot, depth: 0 }];
  while (pending.length && roots.length < 100) {
    const { dir, depth } = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const marker = entries.find(entry => entry.isFile() && entry.name === '.codex-remote-plugin-install.json');
    if (marker) {
      const versions = entries
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, '.codex-plugin', 'plugin.json')))
        .map(entry => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (versions.length) roots.push({ root: path.join(dir, versions[0]), marker: readJson(path.join(dir, marker.name)) });
      continue;
    }
    if (depth >= 4) continue;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== '.remote-plugin-install-staging')
        pending.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return roots;
}

function pluginOrigin(meta) {
  const author = typeof meta.author === 'string' ? meta.author : (meta.author && meta.author.name) || '';
  const developer = (meta.interface && meta.interface.developerName) || author;
  return /^openai(?:,?\s*inc\.?)?$/i.test(String(developer).trim()) ? 'official' : 'third-party';
}

function pluginItem(root, marker, marketplace) {
  const meta = readJson(path.join(root, '.codex-plugin', 'plugin.json'));
  const ui = meta.interface || {};
  const skills = skillDirs(path.join(root, 'skills'));
  const remoteId = marker.remote_plugin_id || `${meta.name || 'plugin'}-${hashPath(root)}`;
  return {
    id: `codex::plugin::${remoteId}`, provider: 'codex',
    name: ui.displayName || meta.name || path.basename(root), marketplace,
    repo: typeof meta.repository === 'string' ? meta.repository : (meta.repository && meta.repository.url) || '',
    description: ui.shortDescription || meta.description || '', scope: 'user', projectPath: '',
    version: String(meta.version || ''), origin: pluginOrigin(meta), enabled: true,
    skills: skills.length, commands: 0, agents: 0, installedAt: '', lastUpdated: '',
    installPath: root, skillRoot: path.join(root, 'skills'), skillNames: skills,
  };
}

function localPluginRoots(codexHome) {
  const pluginsRoot = path.join(codexHome, 'plugins');
  let entries;
  try { entries = fs.readdirSync(pluginsRoot, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'cache')
    .map(entry => path.join(pluginsRoot, entry.name))
    .filter(root => fs.existsSync(path.join(root, '.codex-plugin', 'plugin.json')));
}

function skillSourceItem(root, names, scope, projectPath, label) {
  return {
    id: `codex::skills::${hashPath(root)}`, provider: 'codex', name: label,
    marketplace: 'Local skills', repo: normalizeDisplayPath(root), description: '',
    scope, projectPath: normalizeDisplayPath(projectPath || ''), version: '', origin: 'local', enabled: true,
    skills: names.length, commands: 0, agents: 0, installedAt: '', lastUpdated: '',
    installPath: root, skillRoot: root, skillNames: names,
  };
}

function candidateSkillRoots(codexHome, home, sessions) {
  const candidates = new Map();
  const add = (root, scope, projectPath, label, excluded = new Set()) => {
    const resolved = path.resolve(root);
    if (candidates.has(resolved)) return;
    const names = skillDirs(resolved, excluded);
    if (names.length) candidates.set(resolved, skillSourceItem(resolved, names, scope, projectPath, label));
  };

  add(path.join(home, '.agents', 'skills'), 'user', '', 'Personal skills');
  add(path.join(codexHome, 'skills'), 'user', '', 'Personal Codex skills', new Set(['.system']));

  const seenCwds = new Set();
  for (const session of sessions || []) {
    if (session.provider !== 'codex' || !session.cwd) continue;
    let current = path.resolve(session.cwd);
    if (seenCwds.has(current)) continue;
    seenCwds.add(current);
    for (let depth = 0; depth < 20; depth++) {
      const skillRoot = path.join(current, '.agents', 'skills');
      add(skillRoot, 'project', current, `${path.basename(current) || current} skills`);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...candidates.values()];
}

function loadCodexPlugins(codexHome, home, sessions = []) {
  const out = [];
  for (const entry of remotePluginRoots(codexHome))
    out.push(pluginItem(entry.root, entry.marker, 'OpenAI curated'));
  for (const root of localPluginRoots(codexHome))
    out.push(pluginItem(root, {}, 'Personal'));
  out.push(...candidateSkillRoots(codexHome, home, sessions));
  out.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  return out;
}

module.exports = {
  deleteCodexMemoryFile,
  listCodexMemoryProject,
  loadCodexPlugins,
  readCodexMemoryFiles,
  writeCodexMemoryFile,
};
