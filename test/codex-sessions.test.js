'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deleteCodexSessionFile, loadCodexSessions, parseCodexMessages, parseCodexSession } = require('../codex-sessions');
const { normalizeDisplayPath, resolveEncodedPath } = require('../session-paths');

const ID = 'abcdef12-3456-4789-abcd-ef1234567890';

function writeFixture(filePath, source = 'cli', id = ID, cwd = 'C:\\work\\demo') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const records = [
    { timestamp: '2026-07-22T13:45:25.452Z', type: 'session_meta', payload: { id, timestamp: '2026-07-22T13:45:25.452Z', cwd, cli_version: '0.145.0', source } },
    { timestamp: '2026-07-22T13:45:26.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }] } },
    { timestamp: '2026-07-22T13:45:27.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Add a readonly history viewer' } },
    { timestamp: '2026-07-22T13:45:27.100Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a readonly history viewer' }] } },
    { timestamp: '2026-07-22T13:45:28.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'I will inspect the parser.' } },
    { timestamp: '2026-07-22T13:45:28.100Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect the parser.' }] } },
    { timestamp: '2026-07-22T13:45:29.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"rg session"}', call_id: 'call-1' } },
    { timestamp: '2026-07-22T13:45:30.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'one result' } },
    { timestamp: '2026-07-22T13:45:31.000Z', type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 200000, last_token_usage: { total_tokens: 1200 } } } },
  ];
  fs.writeFileSync(filePath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

test('normalizes Codex summaries and visible conversation events', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-codex-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, `rollout-2026-07-22T08-39-41-${ID}.jsonl`);
  writeFixture(filePath);

  const summary = await parseCodexSession(filePath);
  assert.equal(summary.provider, 'codex');
  assert.equal(summary.key, `codex:${ID}`);
  assert.equal(summary.title, 'Add a readonly history viewer');
  assert.equal(summary.msgCount, 1);
  assert.equal(summary.ctxTokens, 1200);
  assert.equal(summary.contextWindow, 200000);
  assert.equal(summary.isSubagent, false);
  assert.equal(summary.cwd, 'C:\\work\\demo');
  assert.doesNotMatch(summary.searchText, /environment_context/);

  const messages = await parseCodexMessages(filePath);
  assert.equal(messages.filter(message => message.role === 'user').length, 1);
  assert.equal(messages.filter(message => message.role === 'assistant' && message.parts.some(part => part.kind === 'text')).length, 1);
  const tool = messages.flatMap(message => message.parts || []).find(part => part.kind === 'tool_use');
  assert.equal(tool.name, 'shell_command');
  assert.equal(tool.summary, 'rg session');
  assert.equal(tool.result.text, 'one result');
});

test('deletes only the selected Codex JSONL under a Codex session root', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-delete-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const filePath = path.join(codexHome, 'sessions', '2026', '07', '22', `rollout-2026-07-22-${ID}.jsonl`);
  writeFixture(filePath);
  const session = await parseCodexSession(filePath);

  assert.equal(deleteCodexSessionFile(codexHome, session), true);
  assert.equal(fs.existsSync(filePath), false);

  const outsidePath = path.join(codexHome, `outside-${ID}.jsonl`);
  writeFixture(outsidePath);
  await assert.rejects(
    async () => deleteCodexSessionFile(codexHome, { ...session, filePath: outsidePath }),
    /outside the Codex session folders/
  );
  assert.equal(fs.existsSync(outsidePath), true);
});

test('normalizes drive letter case and resolves encoded WSL project paths', t => {
  assert.equal(normalizeDisplayPath('c:\\Users\\Daniel Burkhalter\\project'), 'C:\\Users\\Daniel Burkhalter\\project');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = path.join(root, 'mnt', 'c', 'Users', 'Daniel Burkhalter', 'Documents', 'GitHub', 'idep-shinygo-citation');
  fs.mkdirSync(expected, { recursive: true });
  const resolved = resolveEncodedPath(root, 'mnt-c-Users-Daniel-Burkhalter-Documents-GitHub-idep-shinygo-citation');
  assert.equal(resolved, expected);
});

test('discovers active, archived, and auxiliary sessions without mutating them', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-home-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const activePath = path.join(codexHome, 'sessions', '2026', '07', '22', `rollout-active-${ID}.jsonl`);
  const archivedId = ID.replace(/.$/, '0');
  const archivedPath = path.join(codexHome, 'archived_sessions', `rollout-archived-${archivedId}.jsonl`);
  writeFixture(activePath, { subagent: { other: 'guardian' } });
  fs.appendFileSync(activePath, JSON.stringify({
    timestamp: '2026-07-22T13:46:00.000Z',
    type: 'session_meta',
    payload: { id: '00000000-0000-0000-0000-000000000000', cwd: 'C:\\other', source: 'cli' },
  }) + '\n');
  writeFixture(archivedPath, 'cli', archivedId);

  const sessions = await loadCodexSessions(codexHome);
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find(session => !session.archived).isSubagent, true);
  assert.equal(sessions.find(session => session.archived).archived, true);
  assert.equal(fs.existsSync(activePath), true);
  assert.equal(fs.existsSync(archivedPath), true);
});
