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

Notes:
- Make sure the host allows outbound network access and spawning subprocesses — the bot shells out to a `yt-dlp` binary to fetch YouTube audio (see [src/music/YtDlpSearchPlugin.js](src/music/YtDlpSearchPlugin.js)). Railway's standard containers support this; some locked-down serverless platforms do not.
- On first start (or whenever the `yt-dlp` binary is missing — e.g., a fresh Railway deploy), the bot downloads the correct **standalone** `yt-dlp` build for the current OS so it never depends on a system Python install. It does **not** re-download on every restart (only if missing), to avoid unnecessary delay — set `FORCE_YTDLP_UPDATE=1` as an env var if you deliberately want to force-update it.
- yt-dlp may warn `No supported JavaScript runtime could be found` — some YouTube formats need it to run a JS challenge solver. Installing `deno` on the host silences this and can improve extraction reliability, but it's not required for the bot to work.
- **Known current limitation:** yt-dlp's requests to YouTube can currently take 1–3+ minutes per song to resolve (confirmed: this is YouTube-side throttling of automated extraction tools, not a bug here — plain network access to YouTube is fast, but yt-dlp's own request pattern is slow right now). This affects any host, not just Railway. The first song in a queue will be slow to start; this may improve as yt-dlp's community releases updates to keep pace with YouTube's changes.
