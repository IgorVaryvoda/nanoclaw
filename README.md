<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Personal Claude assistant over Telegram. Runs in Docker containers with filesystem isolation.
</p>

## What's Different From Upstream

This is a fork of [gavrielc/nanoclaw](https://github.com/gavrielc/nanoclaw). Key changes:

- **Telegram instead of WhatsApp** - Uses Telegraf, no WhatsApp/Baileys dependency
- **Voice transcription** - Voice messages transcribed via Groq Whisper API
- **Rich media** - Send videos, images, audio, documents from the agent
- **Markdown→HTML** - Bot messages rendered with Telegram formatting (bold, code blocks, links)
- **Linux/Docker first** - Designed for Linux servers with Docker, no Apple Container dependency

## Quick Start

```bash
git clone https://github.com/IgorVaryvoda/nanoclaw.git
cd nanoclaw
claude
```

Then run `/setup`. Claude Code handles dependencies, Telegram bot setup, Docker config, and service registration.

## Philosophy

**Small enough to understand.** One process, a few source files. No microservices, no message queues, no abstraction layers.

**Secure by isolation.** Agents run in Docker containers. They can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for one user.** This isn't a framework. It's working software. Fork it and make it yours.

## What It Supports

- **Telegram I/O** - Message Claude from any device
- **Voice transcription** - Send voice messages, get text responses (via Groq Whisper)
- **Rich media** - Agent can send videos, images, audio, documents back to you
- **Isolated group context** - Each group has its own `CLAUDE.md` memory and isolated filesystem
- **Main channel** - Your private chat for admin control
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content
- **Container isolation** - Agents sandboxed in Docker containers

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

There are no configuration files to learn. Just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

PRs for bug fixes and improvements welcome. For the upstream project's skill-based contribution model, see [gavrielc/nanoclaw](https://github.com/gavrielc/nanoclaw).

## Requirements

- Linux (or macOS with Docker)
- Node.js 20+
- Docker
- [Claude Code](https://claude.ai/download)
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Groq API key (optional, for voice transcription)

## Architecture

```
Telegram (telegraf) --> SQLite --> Docker container (Claude Agent SDK) --> Response
```

Single Node.js process. Agents execute in isolated Docker containers with mounted directories. IPC via filesystem.

Key files:
- `src/index.ts` - Telegram bot, message routing, IPC
- `src/container-runner.ts` - Spawns agent containers
- `src/task-scheduler.ts` - Scheduled tasks
- `src/db.ts` - SQLite
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Why Telegram?**

Works on all devices, has a proper bot API, supports rich formatting and media. The upstream uses WhatsApp—if you want that, use [gavrielc/nanoclaw](https://github.com/gavrielc/nanoclaw).

**Does voice transcription cost money?**

Groq's free tier is generous. You'll probably never hit it for personal use.

**Is this secure?**

Agents run in Docker containers with only their group's filesystem mounted. Review `src/container-runner.ts` if you want details.

**How do I debug issues?**

Run `claude` then `/debug`.

## License

MIT
