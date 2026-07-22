'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  deleteAntigravitySession,
  loadAntigravitySessions,
  parseAntigravityMessages,
  transcriptPath,
} = require('../antigravity-sessions');

const ID = '12345678-1234-4abc-8def-123456789abc';

function writeTranscript(root) {
  const filePath = transcriptPath(root, ID);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const records = [
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-07-13T21:50:18Z', content: '<USER_REQUEST>\nBuild the parser\n</USER_REQUEST>\n<ADDITIONAL_METADATA>hidden timestamp</ADDITIONAL_METADATA>' },
    { type: 'EPHEMERAL_MESSAGE', source: 'SYSTEM', created_at: '2026-07-13T21:50:19Z', content: 'hidden harness content' },
    { type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-07-13T21:50:20Z', thinking: 'private reasoning', tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/a', toolSummary: 'Inspect a file' } }] },
    { type: 'VIEW_FILE', source: 'MODEL', created_at: '2026-07-13T21:50:21Z', content: 'tool output' },
    { type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-07-13T21:50:22Z', thinking: 'private reasoning', content: 'The parser is ready.' },
    { type: 'CHECKPOINT', source: 'SYSTEM', created_at: '2026-07-13T21:50:23Z', content: 'Earlier context summary' },
  ];
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  return filePath;
}

test('loads AGY summaries and parses visible transcript content', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-agy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = writeTranscript(root);
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cache', 'last_conversations.json'), JSON.stringify({ '/mnt/c/work/demo': ID }));

  const sessions = await loadAntigravitySessions(root);
  assert.equal(sessions.length, 1);
  const session = sessions[0];
  assert.equal(session.provider, 'antigravity');
  assert.equal(session.key, `antigravity:${ID}`);
  assert.equal(session.title, 'Build the parser');
  assert.equal(session.cwd, '/mnt/c/work/demo');
  assert.equal(session.msgCount, 1);
  assert.match(session.searchText, /Build the parser/);
  assert.match(session.searchText, /parser is ready/);
  assert.doesNotMatch(session.searchText, /hidden harness|private reasoning|tool output/);

  const messages = await parseAntigravityMessages(filePath);
  assert.equal(messages.filter(message => message.role === 'user').length, 1);
  assert.equal(messages.filter(message => message.role === 'assistant').length, 2);
  const tool = messages.flatMap(message => message.parts || []).find(part => part.kind === 'tool_use');
  assert.equal(tool.name, 'view_file');
  assert.equal(tool.summary, 'Inspect a file');
  assert.equal(tool.result.text, 'tool output');
  assert.equal(messages.filter(message => message.type === 'summary').length, 0);
  assert.doesNotMatch(JSON.stringify(messages), /private reasoning/);
  assert.doesNotMatch(JSON.stringify(messages), /ADDITIONAL_METADATA|Earlier context summary/);
});

test('deletes only matching AGY conversation artifacts and index entries', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-agy-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeTranscript(root);
  const conversations = path.join(root, 'conversations');
  fs.mkdirSync(conversations, { recursive: true });
  for (const suffix of ['.db', '.db-wal', '.db-shm']) fs.writeFileSync(path.join(conversations, `${ID}${suffix}`), suffix);
  const cachePath = path.join(root, 'cache', 'last_conversations.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ '/mnt/c/work/demo': ID, '/mnt/c/work/other': 'other-id' }));

  const [session] = await loadAntigravitySessions(root);
  assert.equal(await deleteAntigravitySession(root, session), true);
  assert.equal(fs.existsSync(path.join(root, 'brain', ID)), false);
  assert.equal(fs.existsSync(path.join(conversations, `${ID}.db`)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { '/mnt/c/work/other': 'other-id' });
});

test('keeps workspace-less AGY sessions unscoped instead of inventing a project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-agy-unscoped-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeTranscript(root);

  const [session] = await loadAntigravitySessions(root);
  assert.equal(session.cwd, '');
  assert.equal(session.projectKey, '');
  assert.equal(session.projectDir, 'Antigravity');
});
