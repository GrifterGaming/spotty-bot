const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// YouTube's SABR rollout hides most usable formats from any request that can't
// prove it came from a real browser, via a "PO token" — a cryptographic value
// normally produced by running YouTube's own BotGuard JavaScript challenge in a
// real browser. This runs a local server (bgutil-ytdlp-pot-provider-rs, a
// standalone Rust reimplementation of that challenge — no Node/TypeScript build
// step needed) that generates valid tokens on request. The yt-dlp-side half — the
// plugin that actually asks this server for tokens — is installed separately via
// pip (see nixpacks.toml and YtDlpSearchPlugin.js): yt-dlp's standalone/frozen
// binary builds cannot load external Python plugins at all (confirmed directly:
// --plugin-dirs is silently ignored), so a real pip-installed yt-dlp is required
// for the plugin half specifically. This module only handles the server.
// See https://github.com/Brainicism/bgutil-ytdlp-pot-provider

const POT_DIR = path.join(__dirname, '..', '..', '.pot-provider');
const SERVER_ASSET_BY_PLATFORM = {
  linux: process.arch === 'arm64' ? 'bgutil-pot-linux-aarch64' : 'bgutil-pot-linux-x86_64',
  darwin: process.arch === 'arm64' ? 'bgutil-pot-macos-aarch64' : 'bgutil-pot-macos-x86_64',
  win32: 'bgutil-pot-windows-x86_64.exe',
};
const SERVER_ASSET = SERVER_ASSET_BY_PLATFORM[process.platform];
const SERVER_URL = `https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/${SERVER_ASSET}`;
const SERVER_PATH = path.join(POT_DIR, process.platform === 'win32' ? 'bgutil-pot.exe' : 'bgutil-pot');

async function downloadFile(url, destPath, mode) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await fs.promises.writeFile(destPath, buffer, mode ? { mode } : undefined);
}

let serverProcess = null;

// Downloads (if missing) and starts the local PO token server. Idempotent — safe to
// call once at startup. The yt-dlp plugin auto-discovers it on the default port
// (4416) with no extra configuration needed on yt-dlp's side.
async function ensurePotProvider() {
  if (!SERVER_ASSET) {
    console.warn(`[potProvider] no server binary available for platform ${process.platform}, skipping`);
    return;
  }

  if (!fs.existsSync(SERVER_PATH)) {
    console.log('[potProvider] downloading PO token server to', SERVER_PATH);
    await downloadFile(SERVER_URL, SERVER_PATH, 0o755);
  }

  if (!serverProcess) {
    console.log('[potProvider] starting PO token server');
    serverProcess = spawn(SERVER_PATH, ['server'], { stdio: 'inherit' });
    serverProcess.on('exit', (code) => {
      console.error(`[potProvider] server exited with code ${code}`);
      serverProcess = null;
    });
    // Give it a moment to bind its port before yt-dlp tries to reach it.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

module.exports = { ensurePotProvider };
