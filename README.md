# Spotify Discord Bot

A Discord bot with slash commands that plays songs from a Spotify playlist/track/album (or a plain search) directly in a voice channel. Spotify links are resolved to track metadata via the Spotify Web API, then streamed from YouTube into the voice channel — Spotify's own audio can't be extracted or redistributed, so this is the standard approach every Spotify-linked Discord music bot uses.

## Commands

- `/play <query>` — Spotify track/playlist/album link, or a search term
- `/skip` — skip the current song
- `/pause` / `/resume`
- `/stop` — stop playback, clear the queue, leave the voice channel
- `/queue` — show upcoming songs
- `/nowplaying` — show the current song

## Setup

### 1. Create a Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Add Bot** → **Reset Token** → copy it → this is `DISCORD_TOKEN`.
3. **General Information** tab → copy the **Application ID** → this is `DISCORD_CLIENT_ID`.
4. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `View Channels`, `Connect`, `Speak`, `Send Messages`, `Embed Links`
   - Open the generated URL and invite the bot to your server.
5. (Optional, for instant command updates while testing) Enable Developer Mode in Discord, right-click your test server → **Copy Server ID** → this is `DISCORD_GUILD_ID`.

### 2. Create a Spotify application (optional)

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → **Create app**.
2. Fill in any name/description. For the redirect URI, use `http://127.0.0.1:3000/callback` (Spotify requires the literal loopback IP, not `localhost`) — this bot only uses the Client Credentials flow, which doesn't use redirects.
3. Copy the **Client ID** and **Client Secret** → `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`.

**Note:** as of late 2024, Spotify's official API omits the track list from playlist/album responses for apps that haven't been manually approved for "Extended Quota Mode" — even for fully public playlists. Because of this, `/play`'s actual track resolution deliberately does **not** use these credentials (see [src/music/distubeClient.js](src/music/distubeClient.js)) — it scrapes the public `open.spotify.com` page instead, the same way a browser would, which works for any public playlist/track with no API approval needed (capped at ~100 tracks per playlist/album). The Spotify app credentials above are kept in `.env` only as an optional seam for future richer features (album art/exact duration lookups); you can leave them blank and `/play` still works.

### 3. Install and configure

Requires **Node.js 22.12+** (needed for Discord's current voice protocol — see note below). Check with `node --version`; if you're on an older version, install 22 via [nvm](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use 22`.

```bash
npm install
cp .env.example .env
```

Fill in `.env` with the values from steps 1–2.

### 4. Register the slash commands

```bash
npm run deploy-commands
```

With `DISCORD_GUILD_ID` set, commands appear instantly in that server. Without it, commands register globally (can take up to ~1 hour to propagate) — use this once you're ready to deploy for real.

### 5. Run the bot

```bash
npm start
```

You should see `Logged in as <BotName>` in the console and the bot appear online in your server.

## Testing checklist

Note: resolving a song currently takes 1–3+ minutes (see the known limitation below) — `/play` will show "thinking" for a while before replying. Only press it once per song; pressing it again while it's still resolving starts a second, fully redundant lookup and makes the wait longer (there's a guard in [src/commands/play.js](src/commands/play.js) that rejects a second `/play` in the same server while one is already in progress).

- [ ] `/play <a Spotify track URL>` while in a voice channel — bot joins and plays audio
- [ ] `/play <a Spotify playlist URL>` — multiple songs queued
- [ ] `/queue` and `/nowplaying` show correct info
- [ ] `/pause` then `/resume` — playback audibly pauses/resumes
- [ ] `/skip` — advances to the next song
- [ ] `/stop` — stops playback and the bot leaves the channel
- [ ] `/play` with no voice channel joined — graceful error, no crash
- [ ] A garbage/invalid query — graceful error, no crash

## Deploying to Railway

The bot needs a persistent, always-on process (not a serverless function) since it holds a live voice connection — Railway's standard service type works well for this.

1. **Push to GitHub** (Railway deploys from a repo):
   ```bash
   git remote add origin <your-empty-github-repo-url>
   git branch -M main
   git push -u origin main
   ```
2. **Create the Railway project**: [railway.app](https://railway.app) → New Project → **Deploy from GitHub repo** → select this repo. Railway detects it's a Node project automatically (via `package.json`) and will run `npm install` then `npm start`. It also reads `"engines": {"node": ">=22.12.0"}` in `package.json` to provision the right Node version.
3. **Set environment variables**: in the Railway project → **Variables** tab, add the same keys from `.env` (`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`). Leave `DISCORD_GUILD_ID` **unset** here — that's only for instant command updates on your one test server; without it, `deploy-commands` registers commands globally so they work in any server the bot is invited to.
4. **Register commands globally** (only needs to be done once, from anywhere with the same `DISCORD_TOKEN`/`DISCORD_CLIENT_ID` — easiest to just run this locally against your `.env` with `DISCORD_GUILD_ID` removed/commented out):
   ```bash
   npm run deploy-commands
   ```
   Global registration can take up to ~1 hour to propagate to all servers.
5. Railway will build and start the bot automatically on every push to the branch it's watching. Check the **Deployments** tab logs for `Logged in as <BotName>` to confirm it's running.

### YouTube anti-bot workarounds (required on Railway/cloud hosts)

YouTube treats requests from datacenter IPs (Railway, AWS, etc.) far more suspiciously than home connections — confirmed directly: the same code worked immediately on a home network but hit two separate walls on Railway. Both are needed for reliable playback on a cloud host (neither is needed for local/home use):

1. **Cookies**, to get past an outright "Sign in to confirm you're not a bot" block:
   1. Install a cookie-export browser extension like [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) and make sure you're logged into YouTube.
   2. On youtube.com, use the extension to export `cookies.txt`.
   3. In Railway → your service → **Variables** → add `YTDLP_COOKIES` with the entire file's contents as the value.
   4. This ties the bot's YouTube access to your personal account's session — a common practice for bots like this, but worth knowing. Cookies can expire/rotate and may need re-exporting occasionally if this stops working.
2. **A PO token provider**, because cookies alone still aren't enough — YouTube's newer "SABR" system additionally hides most formats behind a proof-of-origin token normally generated by running real browser JavaScript. [railpack.json](railpack.json) adds `python3`/`python3-pip` to Railway's deploy image; from there, [src/music/YtDlpSearchPlugin.js](src/music/YtDlpSearchPlugin.js) pip-installs a real (non-frozen) `yt-dlp` plus the [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) plugin on first startup — yt-dlp's standalone binary builds cannot load this plugin at all (confirmed directly: `--plugin-dirs` is silently ignored by frozen builds), so a genuine Python install is required. [src/music/potProvider.js](src/music/potProvider.js) downloads the plugin's own official Node.js/TypeScript server source, builds it, and runs it — the actual token-generating process the plugin talks to over HTTP. (A standalone Rust reimplementation was tried first since it needs no build step, but forcing yt-dlp to actually use it made requests hang indefinitely, suggesting a protocol mismatch; the official server is what's used now.) `formats=missing_pot` is also applied as a fallback, so a video still returns *something* playable if token generation itself fails for it specifically, rather than erroring out outright.

Locally, none of this is needed — [src/music/YtDlpSearchPlugin.js](src/music/YtDlpSearchPlugin.js) automatically falls back to downloading its own standalone yt-dlp binary when no system `yt-dlp` is on PATH, and cookies are simply unused if `YTDLP_COOKIES` isn't set.

Notes:
- Make sure the host allows outbound network access and spawning subprocesses — the bot shells out to `yt-dlp` and the PO token server. Railway's standard containers support this; some locked-down serverless platforms do not.
- The standalone yt-dlp fallback binary is only downloaded once (not re-downloaded on every restart) to avoid unnecessary delay — set `FORCE_YTDLP_UPDATE=1` as an env var if you deliberately want to force-update it.
- The PO token server's first build (downloading its source, `npm ci`, TypeScript compile) takes real time on a fresh deploy; the server itself can also take 30–60+ seconds to finish initializing after that before it's actually reachable (confirmed directly — a fixed short wait wasn't nearly enough). [src/music/potProvider.js](src/music/potProvider.js) polls for the port actually opening rather than guessing a delay, so `/play` will simply wait longer on first use after a fresh deploy rather than failing.
- Even with both workarounds in place, some individual videos may still fail unpredictably — this is an active, ongoing arms race between YouTube and yt-dlp's community, not something fully "solvable" once and for all.
