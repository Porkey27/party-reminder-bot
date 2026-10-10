// party-reminder-bot
// Sends a text reminder to a channel once per day, at a random time
// between 8:00 AM and 10:00 PM (in the timezone set below), AND joins
// whichever voice channel currently has people in it and speaks the
// message out loud via TTS.
//
// SPOOKY OCTOBER MODE: during October, all spoken TTS (daily reminder and
// /voices samples) is played as two layers: the normal voice mixed with a
// copy pitched down an octave (x0.5), time-stretched so both stay in sync.
// Override with FORCE_SPOOKY=1 (always on) or FORCE_SPOOKY=0 (always off)
// in .env.
//
// Slash commands (usable by anyone in the server, replies are ephemeral):
//   /resetday          - clears "already sent today" state and re-rolls a
//                         random time within TODAY's remaining window. Use
//                         this after a restart if the bot skipped ahead to
//                         tomorrow by mistake.
//   /skipday           - forces the next send to tomorrow's window.
//   /nextsend          - shows when the next reminder is currently scheduled.
//   /settime date time - pins the next send to an exact local date/time,
//                         e.g. date: 2025-01-15  time: 09:30 (24h).
//                         Bypasses the random window for that one send only;
//                         after it fires, normal random daily scheduling
//                         resumes.
//   /voices            - plays a sample of each TTS voice in your voice call.
//   /setvoice code     - sets which voice the daily reminder is spoken in.
//
// Setup:
//   .env needs: DISCORD_TOKEN, CHANNEL_ID, CLIENT_ID, GUILD_ID
//   Optional:   FORCE_SPOOKY=1 / FORCE_SPOOKY=0
//   (OWNER_ID no longer used — commands are open to anyone.)
//
//   npm install   (deps are in package.json)
//   (tweetnacl doesn't support the encryption modes Discord's DAVE E2E voice
//   protocol requires as of March 2026 -- libsodium-wrappers does. Without
//   it, joinVoiceChannel silently stalls: Hello, then a closed connection,
//   with no application-level error. Also requires @discordjs/voice 0.19.x+.)
//
//   Bot role permissions needed:
//     - text channel (CHANNEL_ID): Send Messages, Send TTS Messages
//     - any voice channel it might join: Connect, Speak
//
//   Voice speech only happens if someone is currently in a voice channel
//   at send time — if no voice channel has anyone in it, the bot just
//   posts the text message and skips the speaking part (logged, not an
//   error).

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // fixes @discordjs/voice getting stuck in a connecting/signalling loop on networks where IPv6 to Discord's voice gateway fails silently

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  ChannelType,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} = require('@discordjs/voice');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ---- STATE (survives restarts) -----------------------------------------

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
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTtsVoice() {
  return loadState().ttsVoice || 'en-GB-RyanNeural';
}

function setTtsVoice(voice) {
  const state = loadState();
  state.ttsVoice = voice;
  saveState(state);
}

// ---- CONFIG ------------------------------------------------------------

const CHANNEL_ID = process.env.CHANNEL_ID; // text channel for the message
const CLIENT_ID = process.env.CLIENT_ID;   // bot's Application ID
const GUILD_ID = process.env.GUILD_ID;     // server to register slash commands to
const MESSAGE = `Reminder: TUCK IN YOUR SHIRT`; // <-- edit this to whatever you want the bot to say

const WINDOW_START_HOUR = 8;  // 8 AM local
const WINDOW_END_HOUR = 22;   // 10 PM local

// Spooky October mode tuning
const SPOOKY_PITCH = 0.5;     // 0.5 = one octave down, 0.7 = subtler
const SPOOKY_LOW_GAIN = 1.0;  // volume of the low layer relative to the normal one
const SPOOKY_MASTER = 0.7;    // overall level after mixing (prevents clipping)

// -------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates, // needed to see who's in voice channels + join them
  ],
});

let scheduledTimeout = null;
let scheduledFor = null;

function getRandomDelayMsUntilNextWindow(forceNextDay = false) {
  const now = new Date();

  const windowStart = new Date(now);
  windowStart.setHours(WINDOW_START_HOUR, 0, 0, 0);

  const windowEnd = new Date(now);
  windowEnd.setHours(WINDOW_END_HOUR, 0, 0, 0);

  let targetWindowStart = windowStart;
  let targetWindowEnd = windowEnd;

  if (now >= windowEnd || forceNextDay) {
    targetWindowStart = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
    targetWindowEnd = new Date(windowEnd.getTime() + 24 * 60 * 60 * 1000);
  }

  const rangeStart = now > targetWindowStart ? now : targetWindowStart;
  const rangeEnd = targetWindowEnd;

  const rangeMs = rangeEnd.getTime() - rangeStart.getTime();
  const randomOffsetMs = Math.floor(Math.random() * Math.max(rangeMs, 0));

  const targetTime = new Date(rangeStart.getTime() + randomOffsetMs);
  return targetTime.getTime() - now.getTime();
}

// Finds the first voice channel in the guild that currently has at least
// one non-bot member in it.
async function findActiveVoiceChannel(guild) {
  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    if (!channel || channel.type !== ChannelType.GuildVoice) continue;
    const humanMembers = channel.members.filter((m) => !m.user.bot);
    if (humanMembers.size > 0) return channel;
  }
  return null;
}

// A curated set of Microsoft Edge neural voices, for /voices to preview.
// Unlike Google Translate TTS, Edge has multiple named male/female voices
// per language. Full catalog: run `npx edge-tts --list-voices` or see
// https://github.com/Migushthe2nd/MsEdgeTTS
const VOICE_SAMPLES = [
  { code: 'en-GB-RyanNeural', label: 'English UK (Male — Ryan)' },
  { code: 'en-GB-SoniaNeural', label: 'English UK (Female — Sonia)' },
  { code: 'en-US-GuyNeural', label: 'English US (Male — Guy)' },
  { code: 'en-US-AriaNeural', label: 'English US (Female — Aria)' },
  { code: 'en-AU-WilliamNeural', label: 'English AU (Male — William)' },
  { code: 'en-IE-ConnorNeural', label: 'English Ireland (Male — Connor)' },
  { code: 'fr-FR-HenriNeural', label: 'French (Male — Henri)' },
  { code: 'de-DE-ConradNeural', label: 'German (Male — Conrad)' },
  { code: 'es-ES-AlvaroNeural', label: 'Spanish (Male — Alvaro)' },
  { code: 'it-IT-DiegoNeural', label: 'Italian (Male — Diego)' },
  { code: 'pt-BR-AntonioNeural', label: 'Portuguese Brazil (Male — Antonio)' },
  { code: 'ru-RU-DmitryNeural', label: 'Russian (Male — Dmitry)' },
  { code: 'ja-JP-KeitaNeural', label: 'Japanese (Male — Keita)' },
  { code: 'ko-KR-InJoonNeural', label: 'Korean (Male — InJoon)' },
  { code: 'zh-CN-YunxiNeural', label: 'Chinese Mandarin (Male — Yunxi)' },
  { code: 'hi-IN-MadhurNeural', label: 'Hindi (Male — Madhur)' },
  { code: 'ar-SA-HamedNeural', label: 'Arabic (Male — Hamed)' },
  { code: 'nl-NL-MaartenNeural', label: 'Dutch (Male — Maarten)' },
  { code: 'sv-SE-MattiasNeural', label: 'Swedish (Male — Mattias)' },
  { code: 'cy-GB-AledNeural', label: 'Welsh (Male — Aled)' },
];

// Joins a voice channel and returns a ready connection + player.
async function joinAndGetPlayer(voiceChannel, guild) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  connection.on('stateChange', (oldState, newState) => {
    if (oldState.status !== newState.status) {
      console.log(`Voice connection: ${oldState.status} -> ${newState.status}`);
    }
  });
  connection.on('error', (err) => {
    console.error('Voice connection error:', err);
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

  const player = createAudioPlayer();
  connection.subscribe(player);
  return { connection, player };
}

// ---- SPOOKY OCTOBER MODE -------------------------------------------------

function isSpookySeason(date = new Date()) {
  if (process.env.FORCE_SPOOKY === '1') return true;
  if (process.env.FORCE_SPOOKY === '0') return false;
  return date.getMonth() === 9; // 0-based, 9 = October
}

// Pipes Edge's WebM/Opus stream through ffmpeg: the normal voice mixed with
// a pitched-down copy. Returns the ffmpeg process; its stdout is s16le
// 48kHz stereo PCM (StreamType.Raw).
function makeSpookyStream(inputStream) {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not found');

  const lowRate = Math.round(48000 * SPOOKY_PITCH);
  const tempo = 1 / SPOOKY_PITCH; // atempo puts the speed back after asetrate slows it

  const filter =
    `[0:a]aresample=48000,asplit=2[dry][wet];` +
    `[wet]asetrate=${lowRate},aresample=48000,atempo=${tempo},volume=${SPOOKY_LOW_GAIN}[low];` +
    `[dry][low]amix=inputs=2:normalize=0,volume=${SPOOKY_MASTER}[out]`;

  const ff = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-filter_complex', filter,
    '-map', '[out]',
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  ff.on('error', (err) => console.error('ffmpeg spawn error:', err));
  ff.stdin.on('error', () => {}); // EPIPE if ffmpeg is killed early
  ff.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));
  inputStream.on('error', (err) => console.error('TTS stream error:', err));
  inputStream.pipe(ff.stdin);

  return ff;
}

// Speaks `text` in the given Edge neural voice through an already-joined
// player, waiting for playback to finish before returning. In October the
// audio goes through the spooky dual-layer ffmpeg chain first.
async function speakText(player, text, voiceName) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voiceName, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
  const { audioStream } = await tts.toStream(text);

  let ff = null;
  let resource;
  if (isSpookySeason()) {
    ff = makeSpookyStream(audioStream);
    resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw });
  } else {
    resource = createAudioResource(audioStream, { inputType: StreamType.WebmOpus });
  }

  try {
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, 10_000);
    await new Promise((resolve) => player.once(AudioPlayerStatus.Idle, resolve));
  } finally {
    if (ff && ff.exitCode === null) ff.kill('SIGKILL');
  }
}

// Joins the active voice channel, speaks `text` via Edge TTS, then leaves.
async function speakInVoiceChannel(guild, text) {
  const voiceChannel = await findActiveVoiceChannel(guild);
  if (!voiceChannel) {
    console.log('No active voice call found — skipping spoken reminder.');
    return;
  }

  let connection;
  try {
    const joined = await joinAndGetPlayer(voiceChannel, guild);
    connection = joined.connection;
    await speakText(joined.player, text, getTtsVoice());
    console.log(`Spoke reminder in voice channel #${voiceChannel.name}${isSpookySeason() ? ' (spooky mode)' : ''}`);
  } catch (err) {
    console.error('Failed to speak reminder in voice channel:', err);
  } finally {
    if (connection) connection.destroy();
  }
}

async function sendReminder() {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send({ content: MESSAGE });
    console.log(`[${new Date().toISOString()}] Sent reminder to channel ${CHANNEL_ID}`);
    saveState({ ...loadState(), lastSent: todayKey(new Date()) });

    await speakInVoiceChannel(channel.guild, MESSAGE);
  } catch (err) {
    console.error('Failed to send reminder:', err);
  }
}

function scheduleNextReminder(forceNextDay = false, clearState = false) {
  if (scheduledTimeout) {
    clearTimeout(scheduledTimeout);
    scheduledTimeout = null;
  }

  if (clearState) {
    saveState({ ...loadState(), lastSent: null });
  }

  const state = loadState();
  const alreadySentToday = state.lastSent === todayKey(new Date());
  const effectiveForceNextDay = forceNextDay || alreadySentToday;

  const delayMs = getRandomDelayMsUntilNextWindow(effectiveForceNextDay);
  scheduledFor = new Date(Date.now() + delayMs);
  console.log(`Next reminder scheduled for: ${scheduledFor.toString()}`);

  scheduledTimeout = setTimeout(async () => {
    await sendReminder();
    scheduleNextReminder(true);
  }, delayMs);
}

function scheduleExactTime(targetDate) {
  if (scheduledTimeout) {
    clearTimeout(scheduledTimeout);
    scheduledTimeout = null;
  }

  scheduledFor = targetDate;
  const delayMs = targetDate.getTime() - Date.now();
  console.log(`Next reminder manually pinned to: ${scheduledFor.toString()}`);

  scheduledTimeout = setTimeout(async () => {
    await sendReminder();
    scheduleNextReminder(true);
  }, delayMs);
}

// ---- SLASH COMMANDS ------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('resetday')
    .setDescription('Clear "already sent today" and re-roll a time within today\'s window'),
  new SlashCommandBuilder()
    .setName('skipday')
    .setDescription('Force the next reminder to tomorrow\'s window'),
  new SlashCommandBuilder()
    .setName('nextsend')
    .setDescription('Show when the next reminder is currently scheduled'),
  new SlashCommandBuilder()
    .setName('settime')
    .setDescription('Pin the next reminder to an exact local date/time')
    .addStringOption((opt) => opt.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
    .addStringOption((opt) => opt.setName('time').setDescription('HH:MM, 24h, local time').setRequired(true)),
  new SlashCommandBuilder()
    .setName('voices')
    .setDescription('Play a sample of each available TTS voice/language in your current voice call'),
  new SlashCommandBuilder()
    .setName('setvoice')
    .setDescription('Set which voice the daily reminder is spoken in')
    .addStringOption((opt) =>
      opt.setName('code')
        .setDescription('Voice name, e.g. en-GB-RyanNeural — see /voices for options')
        .setRequired(true)),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'resetday') {
    scheduleNextReminder(false, true);
    await interaction.reply({
      content: `Reset. Next reminder now scheduled for **${scheduledFor.toString()}**.`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (interaction.commandName === 'skipday') {
    scheduleNextReminder(true);
    await interaction.reply({
      content: `Skipped to tomorrow. Next reminder scheduled for **${scheduledFor.toString()}**.`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (interaction.commandName === 'nextsend') {
    await interaction.reply({
      content: scheduledFor
        ? `Next reminder scheduled for **${scheduledFor.toString()}**.`
        : 'Nothing scheduled yet.',
      flags: MessageFlags.Ephemeral,
    });
  } else if (interaction.commandName === 'settime') {
    const datePart = interaction.options.getString('date');
    const timePart = interaction.options.getString('time');

    const valid = /^\d{4}-\d{2}-\d{2}$/.test(datePart) && /^\d{2}:\d{2}$/.test(timePart);
    if (!valid) {
      await interaction.reply({
        content: 'Date must be YYYY-MM-DD and time must be HH:MM (24h).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute] = timePart.split(':').map(Number);
    const target = new Date(year, month - 1, day, hour, minute, 0, 0);

    if (isNaN(target.getTime())) {
      await interaction.reply({ content: "That date/time didn't parse.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (target.getTime() <= Date.now()) {
      await interaction.reply({ content: 'That time is in the past — pick a future date/time.', flags: MessageFlags.Ephemeral });
      return;
    }

    scheduleExactTime(target);
    await interaction.reply({
      content: `Next reminder pinned to **${target.toString()}**.`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (interaction.commandName === 'voices') {
    const voiceChannel = await findActiveVoiceChannel(interaction.guild);
    if (!voiceChannel) {
      await interaction.reply({ content: "No one's in a voice call right now — join one first.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply(`Playing ${VOICE_SAMPLES.length} voice samples in **#${voiceChannel.name}** — this'll take a minute or two.`);

    let connection;
    try {
      const joined = await joinAndGetPlayer(voiceChannel, interaction.guild);
      connection = joined.connection;
      for (const voice of VOICE_SAMPLES) {
        await interaction.followUp(`🔊 **${voice.label}** — \`${voice.code}\``);
        await speakText(joined.player, 'Hello, this is a voice test.', voice.code);
      }
      await interaction.followUp(`Done. Use \`/setvoice code:<name>\` to pick one — e.g. \`/setvoice code:en-GB-RyanNeural\`.`);
    } catch (err) {
      console.error('Failed during /voices:', err);
      await interaction.followUp('Something went wrong partway through — check the logs.');
    } finally {
      if (connection) connection.destroy();
    }
  } else if (interaction.commandName === 'setvoice') {
    const code = interaction.options.getString('code').trim();
    setTtsVoice(code);
    await interaction.reply({
      content: `Reminder voice set to \`${code}\`. Run \`/voices\` if you want to double check how it sounds first.`,
      flags: MessageFlags.Ephemeral,
    });
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Spooky October mode: ${isSpookySeason() ? 'ON' : 'off'}`);
  await registerCommands();
  scheduleNextReminder();
});

client.login(process.env.DISCORD_TOKEN);
