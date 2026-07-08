// party-reminder-bot
// Sends a message to a specific channel once per day, at a random time
// between 8:00 AM and 10:00 PM (in the timezone set below).

const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ---- STATE (survives restarts) -----------------------------------------
// Tracks the date (YYYY-MM-DD, local machine time) the reminder was last
// sent, so a service restart mid-window doesn't cause a duplicate send.

const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastSent: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function todayKey(date) {
  // Local calendar date (YYYY-MM-DD), not UTC — keeps this consistent with
  // the local-time window logic above, especially right around midnight.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---- CONFIG ------------------------------------------------------------

const CHANNEL_ID = process.env.CHANNEL_ID; // #party-general channel ID
const MESSAGE = 'Reminder:'; // <-- edit this to whatever you want the bot to say
// Uses the Pi's own local timezone (setHours/getHours, not UTC), so as long
// as the Pi's system timezone is set to Europe/London (check with
// `timedatectl`), this window correctly stays 8am-10pm local time across
// both GMT and BST without needing any manual offset.

const WINDOW_START_HOUR = 8;  // 8 AM local
const WINDOW_END_HOUR = 22;   // 10 PM local

// -------------------------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

function getRandomDelayMsUntilNextWindow(forceNextDay = false) {
  const now = new Date();

  // Build today's window start/end in the machine's local timezone
  const windowStart = new Date(now);
  windowStart.setHours(WINDOW_START_HOUR, 0, 0, 0);

  const windowEnd = new Date(now);
  windowEnd.setHours(WINDOW_END_HOUR, 0, 0, 0);

  let targetWindowStart = windowStart;
  let targetWindowEnd = windowEnd;

  // If today's window has already fully passed, OR we were just told to skip
  // ahead (e.g. right after sending today's reminder), schedule for tomorrow.
  if (now >= windowEnd || forceNextDay) {
    targetWindowStart = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
    targetWindowEnd = new Date(windowEnd.getTime() + 24 * 60 * 60 * 1000);
  }

  // If we're currently inside today's window (and not forced ahead), pick a
  // random time from now until window end
  const rangeStart = now > targetWindowStart ? now : targetWindowStart;
  const rangeEnd = targetWindowEnd;

  const rangeMs = rangeEnd.getTime() - rangeStart.getTime();
  const randomOffsetMs = Math.floor(Math.random() * Math.max(rangeMs, 0));

  const targetTime = new Date(rangeStart.getTime() + randomOffsetMs);
  return targetTime.getTime() - now.getTime();
}

async function sendReminder() {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send(MESSAGE);
    console.log(`[${new Date().toISOString()}] Sent reminder to channel ${CHANNEL_ID}`);
    saveState({ lastSent: todayKey(new Date()) });
  } catch (err) {
    console.error('Failed to send reminder:', err);
  }
}

function scheduleNextReminder(forceNextDay = false) {
  // If today's reminder already went out (e.g. before a restart), don't
  // pick a new time within today's remaining window — jump to tomorrow.
  const state = loadState();
  const alreadySentToday = state.lastSent === todayKey(new Date());
  const effectiveForceNextDay = forceNextDay || alreadySentToday;

  const delayMs = getRandomDelayMsUntilNextWindow(effectiveForceNextDay);
  const sendAt = new Date(Date.now() + delayMs);
  console.log(`Next reminder scheduled for: ${sendAt.toString()}`);

  setTimeout(async () => {
    await sendReminder();
    // After sending, always jump ahead to tomorrow's window rather than
    // recalculating within today's remaining time (which would otherwise
    // pick another random slot later today and send a second reminder).
    scheduleNextReminder(true);
  }, delayMs);
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  scheduleNextReminder();
});

client.login(process.env.DISCORD_TOKEN);
