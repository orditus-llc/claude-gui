'use strict';

// ── claude-gui-organize ─────────────────────────────────────────────────
// Auto-titles and tags idle Claude Code sessions by handing extracted text
// (never file access) to a headless `claude -p` call, so classification runs
// on the user's existing Claude Code subscription rather than a separate API
// key. The model gets no tools — Node does every read/write — so there is
// nothing for injected transcript content to act on beyond producing a bad
// title, and no permission/cwd-scoping problem to solve. Every headless call
// runs with cwd pinned to ORGANIZE_DIR so its own transcript (the exact
// prompt sent and answer received) collects in one place, viewable in
// claude-gui like any other session — that transcript IS the audit trail.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');

const ORGANIZE_DIR = path.join(os.homedir(), 'claude-gui-organize');
const IDLE_MS = 15 * 60 * 1000;       // don't classify a session Claude Code might still be writing
// Whole sessions are sent, not an excerpt. Only user/assistant prose is
// collected — tool calls and file contents are excluded — which across real
// sessions measures ~9KB median and ~113KB at the largest, comfortably inside
// Haiku's window and a rounding error against Claude Code's own system prompt.
// The cap is a guard against a pathological transcript, not a budget: past it,
// the head says what was asked and the tail says how it ended.
const MAX_TEXT_CHARS = 200000;
const HEAD_CHARS = 60000;
const TAIL_CHARS = 140000;
const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';
const CLASSIFY_TIMEOUT_MS = 300000;   // a full 1MB+ session can take ~60s; leave real headroom
const MAX_SUMMARY_CHARS = 700;        // backstop only; the prompt asks for ~300

// Every session gets one descriptor tag of the form <type>-<3-5 dash-separated
// words> (bug-fdic-quarterly-data-pinning). The prefix is what keeps that
// grouped and colourable — the vocabulary lives in the prefix, the specificity
// in the suffix — so these are spelled one way across every project.
const TYPE_PREFIXES = ['bug', 'feature', 'explore', 'build', 'chore', 'docs'];

// No Bash/Read/Write/Edit/Glob/Grep/Task/WebFetch/etc — belt (--tools '') and
// suspenders (--restricted also confines any remaining file tools to cwd,
// ignores project/user settings files, and refuses bypassPermissions).
const RESTRICTED_FLAGS = ['--restricted', '--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk'];

function ensureOrganizeDir() {
  fs.mkdirSync(ORGANIZE_DIR, { recursive: true });
  return ORGANIZE_DIR;
}

function collectSpokenText(content, out) {
  if (typeof content === 'string') { if (content) out.push(content); return; }
  if (!Array.isArray(content)) return;
  for (const p of content) if (p && p.type === 'text' && p.text) out.push(p.text);
}

// Reads a transcript once for just what classify/prune need. Kept separate
// from index.js's parseSession (which carries context-token counts, size,
// etc. this doesn't need) to avoid a require cycle — index.js requires this
// module, not the other way around.
// Matched against raw line text (not just parsed spoken text), so a session id
// pasted into a subagent's Task prompt is caught too, not just plain prose.
// Every match still has to name a real session file (checked by the caller
// against listAllSessionIds) — that's what filters out the per-message
// uuid/parentUuid fields every line already carries, which are NOT citations.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function readSessionInfo(filePath) {
  const info = { cwd: '', msgCount: 0, firstText: '', firstTs: '', lastTs: '', cited: new Set(), priorTitle: '' };
  const spoken = [];
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const uuids = line.match(UUID_RE);
      if (uuids) for (const u of uuids) info.cited.add(u.toLowerCase());
      let d; try { d = JSON.parse(line); } catch { return; }
      if (!info.cwd && d.cwd) info.cwd = d.cwd;
      // Only reached for a session not yet in our own index, so any ai-title
      // line here is Claude Code's own native one — free context to hand the
      // classifier rather than ignore, on the way to writing a better one.
      if (d.type === 'ai-title' && d.aiTitle) info.priorTitle = d.aiTitle;
      if (d.type === 'user' && !d.isMeta && d.message) {
        info.msgCount++;
        if (d.timestamp) { if (!info.firstTs) info.firstTs = d.timestamp; info.lastTs = d.timestamp; }
        const before = spoken.length;
        collectSpokenText(d.message.content, spoken);
        if (!info.firstText && spoken.length > before) info.firstText = spoken[before];
      } else if (d.type === 'assistant' && d.message) {
        if (d.timestamp) info.lastTs = d.timestamp;
        collectSpokenText(d.message.content, spoken);
      }
    });
    rl.on('close', resolve); rl.on('error', resolve);
  });
  const full = spoken.join('\n');
  info.text = full.length <= MAX_TEXT_CHARS
    ? full
    : `${full.slice(0, HEAD_CHARS)}\n\n…[middle of session omitted]…\n\n${full.slice(-TAIL_CHARS)}`;
  return info;
}

// ── SESSIONS.md — the per-project flat index / "citation" list ──────────
function sessionsIndexPath(claudeProjectsDir, projectDir) {
  return path.join(claudeProjectsDir, projectDir, 'SESSIONS.md');
}

const HEADER_RE = /^# Session Index — (.+)$/m;
const ENTRY_RE = /^- (\d{4}-\d{2}-\d{2}) · `([0-9a-fA-F-]{36})` · (.+)$/;
const TAGS_RE = /^\s*tags:\s*(.+)$/;
const CITES_RE = /^\s*cites:\s*(.+)$/;
const SUMMARY_RE = /^\s*summary:\s*(.+)$/;

const splitList = (s) => s.split(',').map(t => t.trim()).filter(Boolean);

// Continuation lines are matched by their own prefix rather than by a fixed
// offset from the entry line, since cites and summary are both optional.
function parseSessionsIndex(filePath) {
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return { entries: [], tags: new Set(), label: '' }; }
  const lines = raw.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY_RE.exec(lines[i]);
    if (!m) continue;
    const [, date, id, title] = m;
    const entry = { id, date, title, tags: [], cites: [], summary: '' };
    for (let j = i + 1; j < lines.length && !ENTRY_RE.test(lines[j]); j++) {
      const tm = TAGS_RE.exec(lines[j]);
      if (tm) { entry.tags = splitList(tm[1]); continue; }
      const cm = CITES_RE.exec(lines[j]);
      if (cm) { entry.cites = splitList(cm[1]); continue; }
      const sm = SUMMARY_RE.exec(lines[j]);
      if (sm) { entry.summary = sm[1].trim(); }
    }
    entries.push(entry);
  }
  const tags = new Set();
  for (const e of entries) for (const t of e.tags) tags.add(t);
  const header = HEADER_RE.exec(raw);
  return { entries, tags, label: header ? header[1].trim() : '' };
}

function serializeSessionsIndex(projectLabel, entries) {
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const body = sorted.map(e => {
    const lines = [`- ${e.date} · \`${e.id}\` · ${e.title}`, `  tags: ${e.tags.join(', ')}`];
    if (e.cites && e.cites.length) lines.push(`  cites: ${e.cites.join(', ')}`);
    if (e.summary) lines.push(`  summary: ${e.summary.replace(/\s*\n\s*/g, ' ')}`);
    return lines.join('\n');
  }).join('\n\n');
  return `# Session Index — ${projectLabel}\n\n${body}\n`;
}

function upsertIndexEntry(claudeProjectsDir, projectDir, projectLabel, entry) {
  const filePath = sessionsIndexPath(claudeProjectsDir, projectDir);
  const { entries } = parseSessionsIndex(filePath);
  const next = entries.filter(e => e.id !== entry.id);
  next.push(entry);
  fs.writeFileSync(filePath, serializeSessionsIndex(projectLabel, next));
}

// A deleted session must leave the index too, or it keeps showing up as a row
// that opens nothing and keeps satisfying citations from other sessions.
// Every project is scanned, not just the one it lived in, because a citation
// can point across projects.
function removeSessionFromIndexes(claudeProjectsDir, sessionId) {
  let dirs = [];
  try { dirs = fs.readdirSync(claudeProjectsDir); } catch { return; }
  for (const dir of dirs) {
    const filePath = sessionsIndexPath(claudeProjectsDir, dir);
    const { entries, label } = parseSessionsIndex(filePath);
    if (!entries.length) continue;

    const kept = entries.filter(e => e.id !== sessionId);
    let changed = kept.length !== entries.length;
    for (const e of kept) {
      if (e.cites.includes(sessionId)) {
        e.cites = e.cites.filter(id => id !== sessionId);
        changed = true;
      }
    }
    if (!changed) continue;
    // Nothing left to index — drop the file rather than leave an empty one.
    if (!kept.length) { try { fs.unlinkSync(filePath); } catch {} continue; }
    try { fs.writeFileSync(filePath, serializeSessionsIndex(label || dir, kept)); } catch {}
  }
}

// Every real session id on disk, across all projects — the ground truth a
// regex-matched UUID has to belong to before it counts as a citation, which is
// what filters out the per-message uuid/parentUuid fields every line already
// carries (those don't happen to name an actual session file).
function listAllSessionIds(claudeProjectsDir) {
  const ids = new Set();
  let dirs = [];
  try { dirs = fs.readdirSync(claudeProjectsDir); } catch { return ids; }
  for (const dir of dirs) {
    const dirPath = path.join(claudeProjectsDir, dir);
    let files;
    try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) ids.add(path.basename(f, '.jsonl'));
  }
  return ids;
}

// A session's citations often point outside its own project (an idep-desktop
// bug session citing older idep-enterprise sessions, say) — this is only
// called with ids that weren't already found in the requesting project's own
// index, so scanning every project's SESSIONS.md here is a small, one-time cost.
function resolveCitedEntries(claudeProjectsDir, ids) {
  const need = new Set(ids);
  const resolved = {};
  if (!need.size) return resolved;
  let dirs = [];
  try { dirs = fs.readdirSync(claudeProjectsDir); } catch { return resolved; }
  for (const dir of dirs) {
    if (!need.size) break;
    const { entries } = parseSessionsIndex(sessionsIndexPath(claudeProjectsDir, dir));
    for (const e of entries) {
      if (need.has(e.id)) {
        resolved[e.id] = { title: e.title, tags: e.tags, summary: e.summary, date: e.date, projectDir: dir };
        need.delete(e.id);
      }
    }
  }
  return resolved;
}

// Restores the original mtime afterwards. "Idle" is measured by mtime, so
// without this our own append would mark the session as freshly active and
// lock it out of the next run's backfill for IDLE_MS.
function appendAiTitle(sessionFilePath, title) {
  let before;
  try { before = fs.statSync(sessionFilePath); } catch {}
  fs.appendFileSync(sessionFilePath, JSON.stringify({ type: 'ai-title', aiTitle: title }) + '\n');
  if (before) {
    try { fs.utimesSync(sessionFilePath, before.atime, before.mtime); } catch {}
  }
}

// ── Headless classifier call ─────────────────────────────────────────────
// The prompt goes in on stdin, never as an argv entry: Linux caps a single
// argument at 128KB (MAX_ARG_STRLEN) and a whole session's prose can exceed
// that, which would fail the call outright with E2BIG.
function runHeadlessClaude(prompt, schema) {
  return new Promise((resolve, reject) => {
    ensureOrganizeDir();
    const args = [
      '-p',
      '--model', CLASSIFY_MODEL,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      ...RESTRICTED_FLAGS,
    ];
    const child = execFile('claude', args, { cwd: ORGANIZE_DIR, timeout: CLASSIFY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error('claude CLI not found on PATH'));
        if (err.killed) return reject(new Error(`classifier timed out after ${Math.round(CLASSIFY_TIMEOUT_MS / 1000)}s`));
        return reject(new Error(err.message));
      }
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { return reject(new Error('headless response was not valid JSON')); }
      if (parsed.is_error || !parsed.structured_output) return reject(new Error(parsed.result || 'no structured output returned'));
      resolve({ data: parsed.structured_output, metaSessionId: parsed.session_id, costUsd: parsed.total_cost_usd });
    });
    child.stdin.on('error', () => {});   // the child may exit before the write drains
    child.stdin.end(prompt);
  });
}

// ── Organize (title + tag every idle, unclassified session) ─────────────
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short, specific, human-readable title (under ~8 words), naming the actual thing worked on.' },
    summary: { type: 'string', description: 'Two or three short sentences in plain English, under 300 characters: what was wrong, what was done, and explicitly how it was left. No jargon, file names or metrics.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'First tag is <type>-<3-5 dash-separated words>; the rest are short reusable context tags.' },
  },
  required: ['title', 'summary', 'tags'],
  additionalProperties: false,
};

function buildClassifyPrompt({ projectLabel, existingTags, text, priorTitle }) {
  // Only context tags are worth reusing — the descriptor tag is unique per
  // session by design, so feeding those back would just be noise.
  const contextTags = existingTags.filter(t => !TYPE_PREFIXES.some(p => t.startsWith(`${p}-`)));
  return [
    'You are classifying one past Claude Code coding session so it can be found later.',
    `Project: ${projectLabel}`,
    '',
    'TAGS — return 2 to 4, in this order:',
    `  1. Exactly one descriptor tag: "<type>-<3 to 5 dash-separated words>", where <type> is one of: ${TYPE_PREFIXES.join(', ')}.`,
    '     It describes THIS session specifically, e.g. bug-fdic-quarterly-data-pinning, feature-bank-state-location-filter.',
    '     All lowercase, dashes only, no spaces.',
    '  2. Then 1 to 3 short reusable context tags naming the area or technology (e.g. macos, shiny, etl, github-actions).',
    contextTags.length
      ? `     Context tags already used in this project — strongly prefer reusing one of these over inventing a new one:\n       ${contextTags.join(', ')}`
      : '     No context tags exist in this project yet, so choose them fresh.',
    '',
    'Full session transcript (user + assistant text only; tool calls and file contents excluded). The end of it is where the session was left:',
    '"""',
    text || '(no spoken content captured)',
    '"""',
    '',
    priorTitle
      ? `Claude Code's own auto-generated title for this session was: "${priorTitle}" — reuse it if it's already specific and accurate, or write a better one if it's too generic.`
      : '',
    'SUMMARY — 2 to 3 short sentences, under 300 characters total. Write it for the person who ran this',
    'session skimming it months later, not for an engineer reading the code:',
    '  Plain English. No file names, function names, timings, benchmarks, library names or jargon.',
    '  Say what was actually wrong in terms of what the user would have noticed, what was done about it,',
    '  and where it was left. They can open the conversation for the technical detail.',
    '  Prefer "the app was stuck showing old data" over "the fetch logic checked shipped files first,',
    '  making cache and live tiers unreachable dead code".',
    '  The last sentence MUST say where things were left, in these terms:',
    '  fixed and verified · changed but not verified · diagnosed only, no fix applied · abandoned · blocked on something.',
    '  Never leave the outcome implied. "Found that X is hardcoded" is incomplete — say whether it was then fixed or left as-is.',
    '  If the transcript genuinely does not show how it ended, say "outcome unclear from the transcript".',
    '  You can only see this transcript, so you only know the state at the moment the session ended. When the',
    '  unfinished part is something the user could have done by hand afterwards — pushing, deploying, merging,',
    '  opening a PR, running a migration — scope it to the session and say it may have been done since. e.g.',
    '  "committed locally but unpushed as of the end of this session; may have been pushed manually since".',
    '  Do not assert the present state of anything outside the transcript.',
    '',
    'Return: a specific title (name the actual thing, not a generic label), that summary, and the tags described above.',
  ].filter(Boolean).join('\n');
}

async function classifyOneSession({ claudeProjectsDir, projectDir, projectLabel, sessionFilePath, sessionId, allSessionIds, force }) {
  // "Already classified" has to mean "already in our own index" — Claude Code
  // writes its own native ai-title line into every session regardless of this
  // feature, so checking for that line's mere presence would skip everything
  // on the very first run and never improve on Claude Code's own title.
  const { entries, tags } = parseSessionsIndex(sessionsIndexPath(claudeProjectsDir, projectDir));
  if (!force && entries.some(e => e.id === sessionId && e.summary)) return { id: sessionId, skipped: 'already-indexed' };

  const info = await readSessionInfo(sessionFilePath);
  if (info.msgCount === 0) return { id: sessionId, skipped: 'no-content' };

  const prompt = buildClassifyPrompt({ projectLabel, existingTags: [...tags], text: info.text, priorTitle: info.priorTitle });
  const { data, metaSessionId, costUsd } = await runHeadlessClaude(prompt, CLASSIFY_SCHEMA);

  const title = String(data.title || '').trim().slice(0, 140);
  if (!title) throw new Error('classifier returned an empty title');
  // The cap is a backstop, not the design — the prompt asks for ~300 chars.
  // Trim on a word boundary so an over-long one never ends mid-word.
  let summary = String(data.summary || '').trim().replace(/\s*\n\s*/g, ' ');
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SUMMARY_CHARS).replace(/\s+\S*$/, '') + '…';
  }
  const resultTags = Array.isArray(data.tags)
    ? [...new Set(data.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 6)
    : [];
  // Purely mechanical — no model involved. A regex can find a UUID exactly;
  // asking the classifier to transcribe one back is a transcription risk for
  // no benefit, so citations never touch the LLM at all.
  const cites = [...info.cited].filter(id => id !== sessionId && allSessionIds.has(id));

  // Only when it actually changes: claude-gui reads the last ai-title line, so
  // re-appending an identical one is pure litter in the user's transcript —
  // and a force re-run would otherwise add a duplicate every single time.
  if (title !== info.priorTitle) appendAiTitle(sessionFilePath, title);
  const date = (info.firstTs || info.lastTs || new Date().toISOString()).slice(0, 10);
  upsertIndexEntry(claudeProjectsDir, projectDir, projectLabel, { id: sessionId, date, title, summary, tags: resultTags, cites });

  return { id: sessionId, title, summary, tags: resultTags, cites, metaSessionId, costUsd };
}

// What a run would actually work on: idle (so Claude Code isn't still writing
// it) and not already in this project's index. Split out from the run itself
// so the UI can say how many sessions — and roughly how much — a run costs
// before committing to it.
// Oldest-first: on a project's first backfill this replays its vocabulary in
// the order it actually accumulated, and on every later run it means any tag
// a session invents is immediately available for the next (newer) one to reuse.
// `only` scopes the run to a single session, picked deliberately from that
// row's menu — so neither the already-indexed nor the idle filter applies:
// the user asked for that specific one, now.
function listPendingSessions({ claudeProjectsDir, projectDir, force, only }) {
  const dirPath = path.join(claudeProjectsDir, projectDir);
  const { entries } = parseSessionsIndex(sessionsIndexPath(claudeProjectsDir, projectDir));
  // An entry written before summaries existed still needs a pass, so "done"
  // means indexed AND summarised. A forced run treats nothing as done, which
  // is how an entry classified by an older, worse prompt gets regenerated.
  const indexed = force || only ? new Set() : new Set(entries.filter(e => e.summary).map(e => e.id));
  const now = Date.now();
  const candidates = [];
  let files = [];
  try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { return candidates; }
  for (const file of files) {
    const sessionId = path.basename(file, '.jsonl');
    if (only ? sessionId !== only : indexed.has(sessionId)) continue;
    const filePath = path.join(dirPath, file);
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    if (!only && now - stat.mtimeMs < IDLE_MS) continue;
    candidates.push({ filePath, sessionId, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return candidates;
}

// onProgress fires per session so a caller can stream progress — a run is one
// headless call per session and otherwise sits silent for minutes.
async function organizeProject({ claudeProjectsDir, projectDir, projectLabel, onProgress, force, only }) {
  const candidates = listPendingSessions({ claudeProjectsDir, projectDir, force, only });
  const allSessionIds = listAllSessionIds(claudeProjectsDir);
  const total = candidates.length;

  const classified = [], skipped = [], failed = [];
  for (let i = 0; i < total; i++) {
    const c = candidates[i];
    const index = i + 1;
    if (onProgress) onProgress({ phase: 'start', index, total, id: c.sessionId });
    try {
      const result = await classifyOneSession({ claudeProjectsDir, projectDir, projectLabel, sessionFilePath: c.filePath, sessionId: c.sessionId, allSessionIds, force: force || !!only });
      (result.skipped ? skipped : classified).push(result);
      if (onProgress) onProgress({ phase: 'done', index, total, ...result });
    } catch (e) {
      const failure = { id: c.sessionId, error: e.message };
      failed.push(failure);
      if (onProgress) onProgress({ phase: 'failed', index, total, ...failure });
    }
  }
  return { classified, skipped, failed };
}

// ── Prune (suggest, never delete) ────────────────────────────────────────
const PRUNE_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: { sessionId: { type: 'string' }, reason: { type: 'string' } },
        required: ['sessionId', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
};

// `sessions` is caller-shaped: [{ id, title, msgCount, lastTs, firstText }].
// Callers pull this from data they already have (claude-gui's own session
// cache) rather than this module re-reading every transcript a second time.
function buildPrunePrompt({ projectLabel, sessions }) {
  const summaries = sessions.map(s => [
    `- id: ${s.id}`,
    `  title: ${s.title || '(untitled)'}`,
    `  messages: ${s.msgCount}`,
    `  last active: ${s.lastTs || 'unknown'}`,
    `  first prompt: ${String(s.firstText || '').slice(0, 200).replace(/\n/g, ' ')}`,
  ].join('\n')).join('\n');
  return [
    `You are reviewing past Claude Code sessions in project "${projectLabel}" to find ones that are safe to delete —`,
    'stray, abandoned, near-empty, or fully superseded by a later session on the same topic.',
    "Do NOT flag a session just because it's old or short if it looks like real, load-bearing work.",
    "Only flag ones a person would agree are clutter on sight.",
    '',
    'Sessions:',
    summaries,
    '',
    "Return the sessionId and a one-sentence reason for each one you'd suggest deleting. If none qualify, return an empty list.",
  ].join('\n');
}

async function pruneProject({ projectLabel, sessions }) {
  const validIds = new Set(sessions.map(s => s.id));
  const prompt = buildPrunePrompt({ projectLabel, sessions });
  const { data, metaSessionId } = await runHeadlessClaude(prompt, PRUNE_SCHEMA);
  const candidates = (Array.isArray(data.candidates) ? data.candidates : []).filter(c => c && validIds.has(c.sessionId));
  return { candidates, metaSessionId };
}

module.exports = {
  ORGANIZE_DIR,
  TYPE_PREFIXES,
  ensureOrganizeDir,
  sessionsIndexPath,
  parseSessionsIndex,
  resolveCitedEntries,
  removeSessionFromIndexes,
  listPendingSessions,
  organizeProject,
  pruneProject,
};
