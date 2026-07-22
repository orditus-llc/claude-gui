'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeProjectPathCache = new Map();

function normalizeDisplayPath(value) {
  const displayPath = String(value || '');
  return displayPath.replace(/^([a-z]):(?=[\\/])/, (_, drive) => `${drive.toUpperCase()}:`);
}

function encodeClaudePathPart(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '-');
}

function resolveWithoutListing(root, encodedRelative, depth) {
  const parts = encodedRelative.split('-');
  for (let length = 1; length <= parts.length; length++) {
    const encodedName = parts.slice(0, length).join('-');
    const possibleNames = [...new Set([
      encodedName,
      parts.slice(0, length).join(' '),
      parts.slice(0, length).join('_'),
    ])];
    for (const name of possibleNames) {
      const fullPath = path.join(root, name);
      try { if (!fs.statSync(fullPath).isDirectory()) continue; } catch { continue; }
      if (encodedName.length === encodedRelative.length) return fullPath;
      const resolved = resolveEncodedPath(fullPath, encodedRelative.slice(encodedName.length + 1), depth + 1);
      if (resolved) return resolved;
    }
  }
  return '';
}

// Resolve an encoded Claude project path against the live filesystem. Matching
// real directory names is what preserves spaces and literal hyphens, which are
// otherwise ambiguous in names such as "Daniel-Burkhalter-GitHub-my-project".
function resolveEncodedPath(root, encodedRelative, depth = 0) {
  if (!encodedRelative || depth > 32) return '';
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return resolveWithoutListing(root, encodedRelative, depth); }

  const remainingLower = encodedRelative.toLowerCase();
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const encodedName = encodeClaudePathPart(entry.name);
    const encodedLower = encodedName.toLowerCase();
    const fullPath = path.join(root, entry.name);
    if (remainingLower === encodedLower) return fullPath;
    if (remainingLower.startsWith(`${encodedLower}-`)) {
      candidates.push({ fullPath, rest: encodedRelative.slice(encodedName.length + 1), length: encodedName.length });
    }
  }

  // Prefer the longest matching real name (for example "Daniel Burkhalter"
  // before a hypothetical sibling named "Daniel").
  candidates.sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const resolved = resolveEncodedPath(candidate.fullPath, candidate.rest, depth + 1);
    if (resolved) return resolved;
  }
  return '';
}

function resolveClaudeProjectDir(projectDir) {
  if (claudeProjectPathCache.has(projectDir)) return claudeProjectPathCache.get(projectDir);

  let root = '';
  let encodedRelative = '';
  const home = normalizeDisplayPath(os.homedir());
  const encodedHome = encodeClaudePathPart(home);
  if (projectDir.toLowerCase() === encodedHome.toLowerCase()) {
    claudeProjectPathCache.set(projectDir, home);
    return home;
  }
  if (projectDir.toLowerCase().startsWith(`${encodedHome.toLowerCase()}-`)) {
    // Starting at the known home avoids enumerating the profile directory,
    // which Windows can deny even when its child folders are readable.
    root = home;
    encodedRelative = projectDir.slice(encodedHome.length + 1);
  }

  const windows = /^([A-Za-z])--(.+)$/.exec(projectDir);
  if (!root && windows) {
    root = `${windows[1].toUpperCase()}:\\`;
    encodedRelative = windows[2];
  } else if (!root && projectDir.startsWith('-')) {
    root = '/';
    encodedRelative = projectDir.slice(1);
  }

  const resolved = root ? normalizeDisplayPath(resolveEncodedPath(root, encodedRelative)) : '';
  if (resolved) claudeProjectPathCache.set(projectDir, resolved);
  return resolved;
}

module.exports = { normalizeDisplayPath, resolveClaudeProjectDir, resolveEncodedPath };
