# party-reminder-bot

Sends `Reminder:` (or whatever message you set) to your #party-general channel once per day, at a random time between 8:00 AM and 10:00 PM. Runs as a systemd service on your Raspberry Pi so it survives reboots and crashes.

## Files

- `bot.js` — the bot itself
- `package.json` — dependencies
- `.env.example` — template for your secrets (copy to `.env`)
- `party-reminder-bot.service` — systemd unit to run it as a background service

## 1. Copy the project onto the Pi

Put the whole folder somewhere like `/home/pi/party-reminder-bot`. If you're copying from another machine:

```
scp -r party-reminder-bot pi@<pi-ip-address>:/home/pi/
```

Or just `git clone` it if you push it to a repo first.

## 2. Install Node.js on the Pi (if not already installed)

Raspberry Pi OS's apt version of Node is often outdated. Recommended: use `nvm`.

```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
node -v   # should print v20.x
```

## 3. Install dependencies

```
cd /home/pi/party-reminder-bot
npm install
```

## 4. Configure your secrets

```
cp .env.example .env
nano .env
```

Fill in:
- `DISCORD_TOKEN` — from the Discord Developer Portal, your bot's application > **Bot** tab > Reset Token.
- `CHANNEL_ID` — right-click #party-general in Discord (with Developer Mode enabled in User Settings > Advanced) > **Copy Channel ID**.

Make sure the bot is actually invited to your server with **Send Messages** permission in that channel (if the invite link errors out with "Integration requires code grant", turn off **Requires OAuth2 Code Grant** in the Bot tab first).

## 5. Test it manually before setting up the service

```
npm start
```

You should see `Logged in as <botname>` and a line saying when the next reminder is scheduled. Ctrl+C to stop once you've confirmed it connects.

## 6. Install as a systemd service

Edit `party-reminder-bot.service` first if your username or install path differs from `pi` / `/home/pi/party-reminder-bot` — update `WorkingDirectory`, `ExecStart`, and `User` accordingly. Then:

```
sudo cp party-reminder-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable party-reminder-bot
sudo systemctl start party-reminder-bot
```

## 7. Check it's running / view logs

```
sudo systemctl status party-reminder-bot
journalctl -u party-reminder-bot -f
```

`journalctl -f` follows the log live — you'll see "Next reminder scheduled for: ..." and later "Sent reminder to channel ...".

## Managing it afterwards

```
sudo systemctl restart party-reminder-bot   # after editing bot.js or .env
sudo systemctl stop party-reminder-bot      # to pause it
sudo systemctl disable party-reminder-bot   # to stop it from auto-starting on boot
```

## Customizing

- **Message text**: edit the `MESSAGE` constant near the top of `bot.js`, then `sudo systemctl restart party-reminder-bot`.
- **Time window**: edit `WINDOW_START_HOUR` / `WINDOW_END_HOUR` in `bot.js` (24-hour format, currently 8 and 22).
- **Timezone**: the Pi's system clock is almost certainly already set to your local timezone (check with `timedatectl`). `bot.js` uses `setUTCHours` internally, so set `TIMEZONE_OFFSET_HOURS` in `bot.js` to your UTC offset (e.g. `0` for UK, `1` for most of continental Europe in summer) so the 8am–10pm window lines up with your actual local day.

## Why systemd instead of pm2

Since this is already running as a proper Linux service manager, systemd gives you auto-start on boot, auto-restart on crash, and `journalctl` logging for free — no extra npm-installed process manager needed.
