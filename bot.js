// party-reminder-bot
// Sends a message to a specific channel once per day, at a random time
// between 8:00 AM and 10:00 PM (in the timezone set below).

const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

// ---- CONFIG ------------------------------------------------------------

const CHANNEL_ID = process.env.CHANNEL_ID; // #party-general channel ID
const MESSAGE = 'Reminder:'; // <-- edit this to whatever you want the bot to say
const TIMEZONE_OFFSET_HOURS = 0; // set to your UTC offset if you want local-time windows (e.g. -5 for EST)

const WINDOW_START_HOUR = 8;  // 8 AM
const WINDOW_END_HOUR = 22;   // 10 PM

// -------------------------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

function getRandomDelayMsUntilNextWindow() {
  const now = new Date();

  // Build today's window start/end, adjusted for timezone offset
  const windowStart = new Date(now);
  windowStart.setUTCHours(WINDOW_START_HOUR - TIMEZONE_OFFSET_HOURS, 0, 0, 0);

  const windowEnd = new Date(now);
  windowEnd.setUTCHours(WINDOW_END_HOUR - TIMEZONE_OFFSET_HOURS, 0, 0, 0);

  let targetWindowStart = windowStart;
  let targetWindowEnd = windowEnd;

  // If today's window has already fully passed, schedule for tomorrow's window
  if (now >= windowEnd) {
    targetWindowStart = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
    targetWindowEnd = new Date(windowEnd.getTime() + 24 * 60 * 60 * 1000);
  }

  // If we're currently inside today's window, pick a random time from now until window end
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
  } catch (err) {
    console.error('Failed to send reminder:', err);
  }
}

function scheduleNextReminder() {
  const delayMs = getRandomDelayMsUntilNextWindow();
  const sendAt = new Date(Date.now() + delayMs);
  console.log(`Next reminder scheduled for: ${sendAt.toString()}`);

  setTimeout(async () => {
    await sendReminder();
    scheduleNextReminder(); // queue up tomorrow's random time
  }, delayMs);
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  scheduleNextReminder();
});

client.login(process.env.DISCORD_TOKEN);
