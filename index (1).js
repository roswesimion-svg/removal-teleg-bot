// Telegram Channel Join-Request Auto-Approver Bot
// -------------------------------------------------
// Listens for join requests on a private channel, queues them, and
// automatically approves them in batches once the queue reaches
// APPROVE_THRESHOLD pending requests.
//
// Requires:
//   1. Bot added to the channel as an ADMIN with "Invite Users via Link" permission.
//   2. Channel configured so new members must be approved (either a private
//      channel where joining requires admin approval, or a channel with a
//      "join request" invite link).

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // e.g. -1003772364454
const ADMIN_ID = process.env.ADMIN_ID; // your personal Telegram user ID, for notifications
const APPROVE_THRESHOLD = parseInt(process.env.APPROVE_THRESHOLD || '10', 10);
const PORT = process.env.PORT || 3000;
const QUEUE_FILE = path.join(__dirname, 'queue.json');

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error('FATAL: BOT_TOKEN and CHANNEL_ID must be set as environment variables.');
  process.exit(1);
}

// ---------- Persistence (simple JSON file) ----------
// NOTE: On Render's free web service tier, disk storage is ephemeral —
// it resets on redeploy/restart. That's fine for short-lived queues
// (you'll rarely have >10 pending long enough for a restart to matter),
// but if you need bulletproof persistence across deploys, swap this out
// for a Supabase table (id, user_id, chat_id, username, requested_at).
function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load queue file, starting fresh:', err.message);
  }
  return [];
}

function saveQueue(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (err) {
    console.error('Failed to save queue file:', err.message);
  }
}

let pendingQueue = loadQueue();

// ---------- Bot setup ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('Bot started. Watching for join requests on channel:', CHANNEL_ID);

async function notifyAdmin(text) {
  if (!ADMIN_ID) return;
  try {
    await bot.sendMessage(ADMIN_ID, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Failed to notify admin:', err.message);
  }
}

async function approveBatch() {
  const batch = pendingQueue.splice(0, pendingQueue.length);
  saveQueue(pendingQueue);

  let approved = 0;
  let failed = 0;

  for (const req of batch) {
    try {
      await bot.approveChatJoinRequest(req.chatId, req.userId);
      approved++;
    } catch (err) {
      failed++;
      console.error(`Failed to approve user ${req.userId}:`, err.message);
    }
  }

  await notifyAdmin(
    `✅ *Batch approved*\n` +
    `Approved: ${approved}\n` +
    (failed ? `Failed: ${failed}\n` : '') +
    `Queue is now empty.`
  );
}

// ---------- Core event: someone requests to join the channel ----------
bot.on('chat_join_request', async (req) => {
  const chatId = req.chat.id;

  // Only act on requests for our configured channel
  if (String(chatId) !== String(CHANNEL_ID)) return;

  const user = req.from;
  const entry = {
    chatId,
    userId: user.id,
    username: user.username ? `@${user.username}` : (user.first_name || 'Unknown'),
    requestedAt: new Date().toISOString(),
  };

  pendingQueue.push(entry);
  saveQueue(pendingQueue);

  console.log(`New join request from ${entry.username} (${user.id}). Queue: ${pendingQueue.length}/${APPROVE_THRESHOLD}`);

  await notifyAdmin(
    `🔵 New join request from *${entry.username}*\n` +
    `Queue: ${pendingQueue.length}/${APPROVE_THRESHOLD}`
  );

  if (pendingQueue.length >= APPROVE_THRESHOLD) {
    await approveBatch();
  }
});

// ---------- Admin commands (only usable by ADMIN_ID) ----------
function isAdmin(msg) {
  return ADMIN_ID && String(msg.from.id) === String(ADMIN_ID);
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `👋 Channel Join-Approver Bot is running.\nYour Telegram ID: \`${msg.from.id}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
  if (!isAdmin(msg)) return;
  const names = pendingQueue.map((r, i) => `${i + 1}. ${r.username}`).join('\n') || 'No pending requests.';
  bot.sendMessage(
    msg.chat.id,
    `📊 *Queue status*\nPending: ${pendingQueue.length}/${APPROVE_THRESHOLD}\n\n${names}`,
    { parse_mode: 'Markdown' }
  );
});

// Force-approve whatever is currently queued, regardless of threshold
bot.onText(/\/forceapprove/, async (msg) => {
  if (!isAdmin(msg)) return;
  if (pendingQueue.length === 0) {
    bot.sendMessage(msg.chat.id, 'Queue is already empty.');
    return;
  }
  const count = pendingQueue.length;
  await approveBatch();
  bot.sendMessage(msg.chat.id, `✅ Force-approved ${count} pending request(s).`);
});

// Clear the queue without approving (e.g. to reject stale requests manually via Telegram UI)
bot.onText(/\/clearqueue/, (msg) => {
  if (!isAdmin(msg)) return;
  pendingQueue = [];
  saveQueue(pendingQueue);
  bot.sendMessage(msg.chat.id, '🗑️ Queue cleared (no one was approved or declined — this only clears the bot\'s tracking list).');
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

// ---------- Minimal HTTP server (Render web services need an open port) ----------
const app = express();
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    queueLength: pendingQueue.length,
    threshold: APPROVE_THRESHOLD,
  });
});
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));
