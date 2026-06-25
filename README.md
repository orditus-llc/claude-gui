# claude-gui

A lightweight local web interface for your Claude Code sessions and memory. Browse, search, resume, and clean up your history in one place. Zero dependencies, one command.

Claude Code's CLI does not show session IDs in its resume picker. claude-gui gives you a searchable view of every session with one-click resume, plus deletion, pinning, and memory editing.

## Install

On Windows, run these in a WSL terminal. On Linux and macOS, use your normal terminal.

Install globally to add a `claude-gui` command to your shell:

```bash
npm install -g github:orditus-llc/claude-gui
```

Or clone it, so you can edit it in VSCode or keep it in your GitHub folder. On Windows you can clone into your Windows files with Git or VSCode, then run the install from a WSL terminal pointed at that folder:

```bash
git clone https://github.com/orditus-llc/claude-gui.git
cd claude-gui
npm install -g .
```

## Run

```bash
claude-gui
```

This starts a local server at `http://localhost:3131` and opens it in your browser. Use a different port by passing it as an argument:

```bash
claude-gui 8080
```

To run without installing globally, use `node index.js` from the project folder (from a WSL terminal on Windows).

## Features

- Browse and search every session across all projects
- View full conversations with rendered Markdown and collapsible tool calls
- Copy a ready-to-run `claude --resume` command for any session
- Pin favorites, delete sessions, and filter by project
- Per-session context-window and size badges
- Read and edit your project memory files
- Adjustable session retention and light or dark themes

## Requirements

- Node.js 18 or newer
- A web browser
- Linux, macOS, or Windows with WSL

## Launch it from the same place you run Claude Code

Claude Code writes its sessions to `~/.claude/projects` inside whatever environment it runs in, and claude-gui reads that same location. So launch claude-gui from the same place you run Claude Code.

On Windows that means a **WSL terminal**: you run Claude Code in WSL, so run claude-gui in WSL. The project files themselves can live anywhere, including your Windows drive (for example `Documents\GitHub`, so you can edit them in VSCode and commit with Windows Git). Only the terminal you launch from matters.

The one thing that does not work is running it with **native Windows Node** (from PowerShell or CMD): Node on Windows does not set `HOME`, so it cannot find your sessions. Always launch from WSL.

### Platform support

| Platform                                 | Supported |
| ---------------------------------------- | :-------: |
| Linux                                    |    Yes    |
| macOS                                    |    Yes    |
| Windows, launched from WSL               |    Yes    |
| Windows, native Node (PowerShell or CMD) |    No     |

## How it works

claude-gui is a single zero-dependency Node server plus one HTML page. It reads the `.jsonl` session logs in `~/.claude/projects` and renders them in your browser. It writes only when you ask it to: deleting a session, editing a memory file, changing retention, or saving a pin (stored in a local `claude-gui-data.json`).

## Roadmap

- Subagent drill-in: open a subagent's transcript from its Task badge
- Archive: hide a session with a reversible move instead of deleting

## License

MIT
