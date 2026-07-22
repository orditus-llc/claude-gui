'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  deleteCodexMemoryFile,
  listCodexMemoryProject,
  loadCodexPlugins,
  readCodexMemoryFiles,
  writeCodexMemoryFile,
} = require('../codex-data');

test('lists, reads, edits, and deletes Codex memory Markdown files', t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-memory-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const memoryRoot = path.join(codexHome, 'memories');
  fs.mkdirSync(path.join(memoryRoot, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'MEMORY.md'), '# Durable memory\n');
  fs.writeFileSync(path.join(memoryRoot, 'evidence', 'recent.md'), 'Original\n');

  const summary = listCodexMemoryProject(codexHome);
  assert.equal(summary.provider, 'codex');
  assert.equal(summary.key, 'codex:memories');
  assert.equal(summary.fileCount, 2);

  let files = readCodexMemoryFiles(codexHome);
  assert.equal(files[0].name, 'MEMORY.md');
  assert.equal(files[1].name, 'evidence/recent.md');

  writeCodexMemoryFile(codexHome, 'evidence/recent.md', 'Edited\n');
  files = readCodexMemoryFiles(codexHome);
  assert.equal(files.find(file => file.name === 'evidence/recent.md').content, 'Edited\n');

  deleteCodexMemoryFile(codexHome, 'evidence/recent.md');
  assert.equal(fs.existsSync(path.join(memoryRoot, 'evidence', 'recent.md')), false);
  assert.throws(() => writeCodexMemoryFile(codexHome, 'new.md', 'nope'), /file not found/);
  assert.throws(() => writeCodexMemoryFile(codexHome, '../escape.md', 'nope'), /invalid file name/);
});

test('discovers Codex plugins and local skills while hiding system skills', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-extensions-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');

  const pluginRoot = path.join(codexHome, 'plugins', 'cache', 'openai-curated-remote', 'demo', '1.2.3');
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'skills', 'bundled'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '..', '.codex-remote-plugin-install.json'), JSON.stringify({ remote_plugin_id: 'plugin_demo' }));
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo', version: '1.2.3', skills: './skills/',
    interface: { displayName: 'Demo plugin', shortDescription: 'A test plugin', developerName: 'OpenAI' },
  }));
  fs.writeFileSync(path.join(pluginRoot, 'skills', 'bundled', 'SKILL.md'), '---\nname: bundled\ndescription: Test\n---\n');

  const personalRoot = path.join(home, '.agents', 'skills', 'personal');
  fs.mkdirSync(personalRoot, { recursive: true });
  fs.writeFileSync(path.join(personalRoot, 'SKILL.md'), '---\nname: personal\ndescription: Test\n---\n');

  const systemRoot = path.join(codexHome, 'skills', '.system', 'hidden');
  const legacyRoot = path.join(codexHome, 'skills', 'visible');
  fs.mkdirSync(systemRoot, { recursive: true });
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(systemRoot, 'SKILL.md'), '---\nname: hidden\ndescription: Test\n---\n');
  fs.writeFileSync(path.join(legacyRoot, 'SKILL.md'), '---\nname: visible\ndescription: Test\n---\n');

  const repo = path.join(home, 'repo');
  const repoSkill = path.join(repo, '.agents', 'skills', 'repo-skill');
  const cwd = path.join(repo, 'src');
  fs.mkdirSync(repoSkill, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(repoSkill, 'SKILL.md'), '---\nname: repo-skill\ndescription: Test\n---\n');

  const items = loadCodexPlugins(codexHome, home, [{ provider: 'codex', cwd }]);
  assert.ok(items.some(item => item.name === 'Demo plugin' && item.skills === 1 && item.origin === 'official'));
  assert.ok(items.some(item => item.name === 'Personal skills' && item.skillNames.includes('personal')));
  assert.ok(items.some(item => item.name === 'Personal Codex skills' && item.skillNames.includes('visible')));
  assert.ok(items.some(item => item.scope === 'project' && item.skillNames.includes('repo-skill')));
  assert.equal(items.some(item => item.skillNames.includes('hidden')), false);
  assert.equal(items.every(item => item.provider === 'codex'), true);
});
