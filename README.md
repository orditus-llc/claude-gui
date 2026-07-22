<div align="center">

# claude-gui

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-22C55E?style=flat-square)](package.json)
[![License](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square)](LICENSE)

**Lightweight GUI for Claude Code, Codex, Antigravity, and exported ChatGPT or Claude conversations. Zero dependencies.**

Browse, search, resume, and clean up your sessions in one local web page.<br>
Session deletion uses the same two-click confirmation for every local provider.

</div>

## Install

> **Install where you run Claude Code or Codex.**
> Sessions created in WSL are separate from sessions created in native Windows.

```bash
npm install -g github:orditus-llc/claude-gui
```

## Usage

```bash
claude-gui        # opens http://localhost:3131
claude-gui 8080   # custom port
```

## Features

- Find Claude Code, Codex, and Antigravity sessions across **all** projects
  - **Full conversations**, collapsible, skimmable
- Browse and search local ChatGPT and Claude data exports; copy their original conversation URLs
- Filter by provider; interactive sessions are shown while auxiliary/subagent sessions remain hidden
- Quickly resume any session
  - Filter and pin
  - Delete Claude or Codex sessions with a two-click confirmation
  - Skim context window & file size
- Read and **EDIT** Claude and Codex memory
- Browse Claude and Codex plugins and skills
- **Customize** Claude session retention period

## Development

Want to edit it? Clone anywhere (your Windows drive is fine for VSCode/Git), then install:

```bash
git clone https://github.com/orditus-llc/claude-gui.git
cd claude-gui
npm install -g .   # or: npm link (live edits)
```

claude-gui reads `~/.claude/projects`, `$CODEX_HOME/sessions`, `$CODEX_HOME/archived_sessions`, and `$ANTIGRAVITY_HOME` in the environment where it runs. The latter defaults to `~/.gemini/antigravity-cli`. Run it in WSL for WSL sessions or PowerShell for native Windows sessions. Want both? Run both: WSL defaults to port 3131 and Windows to 3132, so they don't collide.

To include hosted conversation history, extract the ZIP downloaded from ChatGPT or Claude, then enter each extracted folder under its matching export setting. Exported cards include the account email so multiple users remain distinguishable. No API key or web authentication is required.

## How it works

One Node server, one HTML page. Claude Code, Codex, and Antigravity transcripts are read from their local JSONL files, while hosted ChatGPT and Claude conversations are read from each export's JSON files. Deleting a local session removes that provider's matching conversation artifacts; exported conversations are read-only. Memory files can be viewed, edited, and deleted for Claude Code or Codex, and installed plugins and non-system skills can be browsed in the existing Plugins view. Claude retention settings keep their existing behavior; pins and optional export paths are stored in the local `claude-gui-data.json` file.

## Requirements

Node 18+ & a browser

Linux, Windows (WSL or native), or macOS (Not Tested)

## License

MIT

## Future Features (To Do)

See **[FEATURES.md](FEATURES.md)** for the roadmap and proposed changes.
