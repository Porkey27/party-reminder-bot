# party-reminder-bot

Posts a reminder (the `MESSAGE` constant in `bot.js`) to a text channel once per day at a random time between 8:00 AM and 10:00 PM local time. If anyone is in a voice channel at that moment, the bot joins and speaks the message using Microsoft Edge neural TTS, then leaves.

**Spooky October mode:** throughout October, all spoken TTS is two layers mixed together: the normal voice plus an octave-down copy, kept in sync. Set `FORCE_SPOOKY=1` / `0` in `.env` to force it on or off.

Runs as a systemd service on a Raspberry Pi so it survives reboots and crashes.

## Files

- `bot.js`: the bot
- `package.json`: dependencies
- `.env.example`: template for your secrets (copy to `.env`)
- `party-reminder-bot.service`: systemd unit

## Slash commands

All replies are ephemeral; anyone in the server can use them.

| Command | What it does |
|---|---|
| `/resetday` | Clears "already sent today" and re-rolls a time in today's remaining window |
| `/skipday` | Pushes the next send to tomorrow's window |
| `/nextsend` | Shows when the next reminder is scheduled |
| `/settime date time` | Pins the next send to an exact local time (`2026-10-31`, `21:00`) |
| `/voices` | Plays a sample of each TTS voice in your current voice call |
| `/setvoice code` | Sets the reminder voice, e.g. `en-GB-RyanNeural` |

## 1. Copy the project onto the Pi

```bash
git clone https://github.com/Porkey27/party-reminder-bot.git ~/party-reminder-bot
```

## 2. Install Node.js (if not already)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22
node -v
```

## 3. Install dependencies

```bash
cd ~/party-reminder-bot
npm install
```

`ffmpeg-static` downloads its own ffmpeg binary, so no system ffmpeg is needed.

## 4. Configure

```bash
cp .env.example .env
nano .env
```

Fill in `DISCORD_TOKEN`, `CHANNEL_ID`, `CLIENT_ID` and `GUILD_ID` (enable Developer Mode in Discord under User Settings > Advanced to copy IDs).

Bot permissions needed:
- Text channel: **Send Messages**
- Voice channels: **Connect**, **Speak**

## 5. Test manually

```bash
npm start            # normal
npm run spooky       # force spooky mode on for testing
```

You should see `Logged in as ...`, `Spooky October mode: ON/off`, `Slash commands registered.` and the next scheduled time. Join a voice channel and run `/voices` to hear it. Ctrl+C to stop.

## 6. Install as a systemd service

Edit `party-reminder-bot.service` first: set `User`, `WorkingDirectory`, and make `ExecStart` point to the output of `which node`.

```bash
sudo cp party-reminder-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now party-reminder-bot
```

## Managing it

```bash
sudo systemctl restart party-reminder-bot   # after editing bot.js or .env
sudo systemctl stop party-reminder-bot      # pause it
sudo systemctl status party-reminder-bot    # is it running?
journalctl -u party-reminder-bot -f         # live logs
```

## Customizing

- **Message**: `MESSAGE` in `bot.js`
- **Time window**: `WINDOW_START_HOUR` / `WINDOW_END_HOUR` (24h). Uses the Pi's local timezone, so check `timedatectl` shows `Europe/London` (or wherever you are).
- **Spooky sound**: `SPOOKY_PITCH` (0.5 = octave down), `SPOOKY_LOW_GAIN` (louder low layer), `SPOOKY_MASTER` (lower this if it distorts)
