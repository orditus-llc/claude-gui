<div align="center">

# claude-gui

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-22C55E?style=flat-square)](package.json)
![License](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square)

**Lightweight GUI for Claude Code sessions. Zero dependencies.**

Browse, search, resume, and clean up your sessions in one local web page.<br>
The `claude -- resume` hides session IDs --> this doesn't.

</div>

## Install

> On Windows, run in **WSL** — same place you run Claude Code.

```bash
npm install -g github:orditus-llc/claude-gui
```

## Usage

```bash
claude-gui        # opens http://localhost:3131
claude-gui 8080   # custom port
```

## Features

- Find **all** Claude Code sessions, across **all** projects
  - **Full conversations**, collapsible, skimmable
- Quickly resume any session
  - Filter, pin, & delete
  - Skim context window & file size
- Read and **EDIT** project memory
- **Customize** session retention period

## Development

Want to edit it? Clone anywhere (your Windows drive is fine for VSCode/Git), then install **from WSL**:

```bash
git clone https://github.com/orditus-llc/claude-gui.git
cd claude-gui
npm install -g .   # or: npm link (live edits)
```

Why WSL? Claude Code writes sessions to `~/.claude/projects` inside WSL. claude-gui reads that path, so it must run there too. The files can live on Windows; the command must run in WSL. Native Windows Node (PowerShell/CMD) can't find your sessions — it won't work.

## How it works

One Node server, one HTML page. Reads `~/.claude/projects/*.jsonl`. Writes only on your action (delete, edit memory, pin, retention), to a local `claude-gui-data.json`.

## Requirements

Node 18+, a browser. Linux, macOS, or Windows via WSL.

## License

MIT

## Future Features (To Do)

- [ ] Add subagent sessions
- [ ] Archive (reversible delete)
- [ ] Compress old conversations
