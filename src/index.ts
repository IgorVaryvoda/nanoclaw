import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import Groq from 'groq-sdk';
import pino from 'pino';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  DATA_DIR,
  TRIGGER_PATTERN,
  MAIN_GROUP_FOLDER,
  IPC_POLL_INTERVAL,
  TIMEZONE
} from './config.js';
import { RegisteredGroup, Session, NewMessage } from './types.js';
import { initDatabase, storeGenericMessage, storeChatMetadata, getNewMessages, getMessagesSince, getAllTasks, getAllChats } from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot, AvailableGroup } from './container-runner.js';
import { loadJson, saveJson } from './utils.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

// Telegram bot (required)
const telegramBot = process.env.TELEGRAM_BOT_TOKEN
  ? new Telegraf(process.env.TELEGRAM_BOT_TOKEN)
  : null;

// Map JID -> Telegram chat ID for routing responses
const telegramChatIds: Map<string, number> = new Map();

// Groq client for voice transcription
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

async function transcribeAudio(buffer: Buffer): Promise<string | null> {
  if (!groq) {
    logger.warn('GROQ_API_KEY not set, cannot transcribe audio');
    return null;
  }
  try {
    // Create a File object from the buffer for the Groq API
    const file = new File([buffer], 'audio.ogg', { type: 'audio/ogg' });
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3-turbo',
      temperature: 0,
      response_format: 'json'
    });
    logger.info({ length: transcription.text.length }, 'Audio transcribed');
    return transcription.text;
  } catch (err) {
    logger.error({ err }, 'Failed to transcribe audio');
    return null;
  }
}

let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

async function setTypingIndicator(chatId: number): Promise<void> {
  if (!telegramBot) return;
  try {
    await telegramBot.telegram.sendChatAction(chatId, 'typing');
  } catch (err) {
    logger.debug({ chatId, err }, 'Failed to send typing indicator');
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_timestamp?: string; last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_timestamp: lastTimestamp, last_agent_timestamp: lastAgentTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

/**
 * Get available groups list for the agent.
 * Returns registered groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter(c => registeredJids.has(c.jid))
    .map(c => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: true
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Main group responds to all messages; other groups require trigger prefix
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(msg.chat_jid, sinceTimestamp, ASSISTANT_NAME);

  const lines = missedMessages.map(m => {
    // Escape XML special characters in content
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');

  // Send typing indicator to Telegram
  const chatId = telegramChatIds.get(msg.chat_jid);
  if (chatId) await setTypingIndicator(chatId);

  const response = await runAgent(group, prompt, msg.chat_jid);

  if (response) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${response}`);
  }
}

async function runAgent(group: RegisteredGroup, prompt: string, chatJid: string): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(group.folder, isMain, tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run
  })));

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return null;
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  const chatId = telegramChatIds.get(jid);
  if (!chatId || !telegramBot) {
    logger.warn({ jid }, 'No Telegram chat ID found for JID, cannot send message');
    return;
  }

  try {
    await telegramBot.telegram.sendMessage(chatId, text);
    logger.info({ chatId, length: text.length }, 'Telegram message sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send Telegram message');
  }
}

async function sendMedia(jid: string, filePath: string, mediaType: string, caption?: string): Promise<void> {
  const chatId = telegramChatIds.get(jid);
  if (!chatId || !telegramBot) {
    logger.warn({ jid }, 'No Telegram chat ID found for JID, cannot send media');
    return;
  }

  const source = { source: filePath };
  const sendMethod = {
    video: () => telegramBot.telegram.sendVideo(chatId, source, { caption }),
    audio: () => telegramBot.telegram.sendAudio(chatId, source, { caption }),
    image: () => telegramBot.telegram.sendPhoto(chatId, source, { caption }),
  }[mediaType] ?? (() => telegramBot.telegram.sendDocument(chatId, source, { caption }));

  try {
    await sendMethod();
    logger.info({ chatId, mediaType, filePath }, 'Telegram media sent');
  } catch (err) {
    logger.error({ chatId, filePath, err }, 'Failed to send Telegram media');
  }
}

function translateContainerPath(containerPath: string, groupFolder: string): string {
  // Translate container paths to host paths
  // /workspace/group/... -> groups/{groupFolder}/...
  // /workspace/project/... -> {projectRoot}/...

  const projectRoot = process.cwd();
  let basePath: string;
  let relativePath: string;

  if (containerPath.startsWith('/workspace/group/')) {
    basePath = path.join(projectRoot, 'groups', groupFolder);
    relativePath = containerPath.slice('/workspace/group/'.length);
  } else if (containerPath.startsWith('/workspace/project/')) {
    basePath = projectRoot;
    relativePath = containerPath.slice('/workspace/project/'.length);
  } else {
    // Unknown prefix - reject to prevent path injection
    throw new Error(`Invalid container path prefix: ${containerPath}`);
  }

  const resolved = path.resolve(basePath, relativePath);

  // Prevent path traversal - resolved path must stay within basePath
  if (!resolved.startsWith(basePath + path.sep) && resolved !== basePath) {
    throw new Error(`Path traversal detected: ${containerPath}`);
  }

  return resolved;
}


const MAX_IPC_FILE_SIZE = 1024 * 1024; // 1MB limit for IPC files

async function processIpcDirectory(
  dir: string,
  sourceGroup: string,
  ipcBaseDir: string,
  processor: (data: Record<string, unknown>) => Promise<void>,
  logType: string
): Promise<void> {
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      // Check file size before reading to prevent memory exhaustion
      const stats = fs.statSync(filePath);
      if (stats.size > MAX_IPC_FILE_SIZE) {
        throw new Error(`IPC file too large: ${stats.size} bytes (max ${MAX_IPC_FILE_SIZE})`);
      }

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      await processor(data);
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, `Error processing IPC ${logType}`);
      const errorDir = path.join(ipcBaseDir, 'errors');
      fs.mkdirSync(errorDir, { recursive: true });
      fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
    }
  }
}

function startIpcWatcher(): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter(f => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      await processIpcDirectory(messagesDir, sourceGroup, ipcBaseDir, async (data) => {
        const targetGroup = registeredGroups[data.chatJid as string];
        const isAuthorized = isMain || (targetGroup && targetGroup.folder === sourceGroup);

        if (data.type === 'message' && data.chatJid && data.text) {
          if (isAuthorized) {
            await sendMessage(data.chatJid as string, `${ASSISTANT_NAME}: ${data.text}`);
            logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
          } else {
            logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
          }
        } else if (data.type === 'media' && data.chatJid && data.filePath && data.mediaType) {
          if (isAuthorized) {
            const hostPath = translateContainerPath(data.filePath as string, (data.groupFolder as string) || sourceGroup);
            await sendMedia(data.chatJid as string, hostPath, data.mediaType as string, data.caption as string | undefined);
            logger.info({ chatJid: data.chatJid, sourceGroup, mediaType: data.mediaType, hostPath }, 'IPC media sent');
          } else {
            logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC media attempt blocked');
          }
        }
      }, 'message');

      await processIpcDirectory(tasksDir, sourceGroup, ipcBaseDir, async (data) => {
        await processTaskIpc(data as Parameters<typeof processTaskIpc>[0], sourceGroup, isMain);
      }, 'task');
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string,  // Verified identity from IPC directory
  isMain: boolean       // Verified from directory path
): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const { createTask, updateTask, deleteTask, getTaskById: getTask } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && data.groupFolder) {
        // Authorization: non-main groups can only schedule for themselves
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn({ sourceGroup, targetGroup }, 'Unauthorized schedule_task attempt blocked');
          break;
        }

        // Resolve the correct JID for the target group (don't trust IPC payload)
        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup
        )?.[0];

        if (!targetJid) {
          logger.warn({ targetGroup }, 'Cannot schedule task: target group not registered');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode = (data.context_mode === 'group' || data.context_mode === 'isolated')
          ? data.context_mode
          : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString()
        });
        logger.info({ taskId, sourceGroup, targetGroup, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info({ sourceGroup }, 'Group list refresh requested via IPC');
        const availableGroups = getAvailableGroups();
        writeGroupsSnapshot(sourceGroup, true, availableGroups, new Set(Object.keys(registeredGroups)));
      } else {
        logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig
        });
      } else {
        logger.warn({ data }, 'Invalid register_group request - missing required fields');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error({ err, msg: msg.id }, 'Error processing message, will retry');
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

function ensureContainerSystemRunning(): void {
  // On Linux, use Docker (no system start needed)
  if (process.platform === 'linux') {
    try {
      execSync('docker info', { stdio: 'pipe' });
      logger.debug('Docker is running');
      return;
    } catch {
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Docker is not running                                  ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without Docker. To fix:                    ║');
      console.error('║  1. Start Docker: sudo systemctl start docker                 ║');
      console.error('║  2. Or install Docker if not installed                        ║');
      console.error('║  3. Restart NanoClaw                                          ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Docker is required but not running');
    }
  }

  // On macOS, try Apple Container first
  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system');
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Apple Container system failed to start                 ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without Apple Container. To fix:           ║');
      console.error('║  1. Install from: https://github.com/apple/container/releases ║');
      console.error('║  2. Run: container system start                               ║');
      console.error('║  3. Restart NanoClaw                                          ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Apple Container system is required but failed to start');
    }
  }
}

async function connectTelegram(): Promise<void> {
  if (!telegramBot) {
    logger.error('TELEGRAM_BOT_TOKEN not set - cannot start');
    process.exit(1);
  }

  // Get the main group JID for routing
  const mainJid = Object.entries(registeredGroups).find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
  if (!mainJid) {
    logger.warn('No main group registered. First message will auto-register.');
  }

  // Handle text messages
  telegramBot.on(message('text'), async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.message.chat.id;
    const userId = ctx.message.from?.id || chatId;
    const userName = ctx.message.from?.first_name || ctx.message.from?.username || 'Telegram User';
    const msgId = `tg-${ctx.message.message_id}`;

    // Check for trigger pattern (or if from private chat, always respond)
    const isPrivateChat = ctx.message.chat.type === 'private';
    if (!isPrivateChat && !TRIGGER_PATTERN.test(text)) {
      return; // Ignore messages without trigger in group chats
    }

    // Use virtual JID for this Telegram chat
    const jid = `telegram:${chatId}`;

    // Auto-register main group on first message if not registered
    if (!registeredGroups[jid] && isPrivateChat) {
      const chatName = ctx.message.chat.type === 'private'
        ? `${userName}'s Chat`
        : (ctx.message.chat as any).title || 'Telegram Chat';
      registerGroup(jid, {
        name: chatName,
        folder: MAIN_GROUP_FOLDER,
        trigger: ASSISTANT_NAME,
        added_at: new Date().toISOString()
      });
      logger.info({ jid, chatName }, 'Auto-registered Telegram chat as main group');
    }

    if (!registeredGroups[jid]) {
      return; // Not a registered chat
    }

    logger.info({ chatId, userName, text: text.slice(0, 50) }, 'Telegram message received');

    // Store chat metadata first (foreign key), then message
    storeChatMetadata(jid, new Date().toISOString());
    storeGenericMessage(msgId, jid, `telegram:${userId}`, userName, text, false);

    // Map JID to chat ID for responses
    telegramChatIds.set(jid, chatId);
  });

  // Handle voice messages
  telegramBot.on(message('voice'), async (ctx) => {
    const chatId = ctx.message.chat.id;
    const userId = ctx.message.from?.id || chatId;
    const userName = ctx.message.from?.first_name || ctx.message.from?.username || 'Telegram User';
    const msgId = `tg-${ctx.message.message_id}`;
    const jid = `telegram:${chatId}`;

    if (!registeredGroups[jid]) {
      return; // Not a registered chat
    }

    logger.info({ chatId, userName }, 'Telegram voice message received');

    try {
      // Download voice file
      const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
      const response = await fetch(fileLink.href);
      const buffer = Buffer.from(await response.arrayBuffer());

      // Transcribe
      const transcribed = await transcribeAudio(buffer);
      if (!transcribed) {
        await ctx.reply('Could not transcribe voice message');
        return;
      }

      const text = `[Voice message]: ${transcribed}`;

      // Store chat metadata first (foreign key), then message
      storeChatMetadata(jid, new Date().toISOString());
      storeGenericMessage(msgId, jid, `telegram:${userId}`, userName, text, false);

      telegramChatIds.set(jid, chatId);
    } catch (err) {
      logger.error({ err }, 'Failed to process Telegram voice message');
      await ctx.reply('Error processing voice message');
    }
  });

  // Start scheduler, IPC watcher, and message loop
  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions
  });
  startIpcWatcher();

  // Launch bot (don't await - it runs the polling loop and only resolves on stop)
  telegramBot.launch().then(() => {
    logger.info('Telegram bot stopped');
  }).catch(err => {
    logger.error({ err }, 'Telegram bot error');
  });
  logger.info('Telegram bot connected');

  // Graceful shutdown
  process.once('SIGINT', () => telegramBot.stop('SIGINT'));
  process.once('SIGTERM', () => telegramBot.stop('SIGTERM'));

  // Start message loop (blocking)
  await startMessageLoop();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Restore Telegram chat ID mappings from registered groups
  for (const jid of Object.keys(registeredGroups)) {
    if (jid.startsWith('telegram:')) {
      const chatId = parseInt(jid.slice('telegram:'.length), 10);
      if (!isNaN(chatId)) {
        telegramChatIds.set(jid, chatId);
      }
    }
  }

  await connectTelegram();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
