const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tar = require('tar');

// YouTube's SABR rollout hides most usable formats from any request that can't
// prove it came from a real browser, via a "PO token" — a cryptographic value
// normally produced by running YouTube's own BotGuard JavaScript challenge in a
// real browser. This builds and runs bgutil-ytdlp-pot-provider's own official
// Node.js/TypeScript server, which reimplements that challenge so yt-dlp can
// generate valid tokens itself. A standalone Rust reimplementation
// (bgutil-ytdlp-pot-provider-rs) was tried first since it needs no build step, but
// forcing yt-dlp to actually use it caused requests to hang indefinitely in
// production — using the official server the plugin was actually built against, to
// rule out a protocol/version mismatch as the cause.
// See https://github.com/Brainicism/bgutil-ytdlp-pot-provider

const SERVER_VERSION = '1.3.2';
const SERVER_TARBALL_URL = `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${SERVER_VERSION}.tar.gz`;
const POT_DIR = path.join(__dirname, '..', '..', '.pot-provider');
const SERVER_ROOT = path.join(POT_DIR, 'ts-server');
const SERVER_DIR = path.join(SERVER_ROOT, 'server');
const SERVER_ENTRY = path.join(SERVER_DIR, 'build', 'main.js');

// The server can take well over a minute to fully initialize (confirmed directly:
// a fixed 1s wait was nowhere near enough) — likely loading a WASM-based BotGuard
// challenge emulator. Poll for the port actually accepting connections instead of
// guessing a fixed delay.
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`PO token server did not open port ${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 1000);
        }
      });
    };
    attempt();
  });
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function downloadAndBuildServer() {
  console.log('[potProvider] downloading official PO token server source (v' + SERVER_VERSION + ')');
  const res = await fetch(SERVER_TARBALL_URL);
  if (!res.ok) throw new Error(`Failed to download server source: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(SERVER_ROOT, { recursive: true });
  const tarPath = path.join(POT_DIR, 'ts-server.tar.gz');
  await fs.promises.writeFile(tarPath, buffer);
  // GitHub tarballs wrap everything in a top-level "<repo>-<tag>/" folder — strip it
  // so SERVER_ROOT directly contains the repo's own top-level contents (server/, etc).
  await tar.extract({ file: tarPath, cwd: SERVER_ROOT, strip: 1 });
  await fs.promises.rm(tarPath, { force: true });

  console.log('[potProvider] npm ci in', SERVER_DIR);
  await run('npm', ['ci'], SERVER_DIR);

  console.log('[potProvider] compiling TypeScript server');
  await run('npx', ['tsc'], SERVER_DIR);
}

let serverProcess = null;

// Downloads+builds (if missing) and starts the local PO token server. Idempotent —
// safe to call once at startup. The yt-dlp plugin auto-discovers it on the default
// port (4416) with no extra configuration needed on yt-dlp's side.
async function ensurePotProvider() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    await downloadAndBuildServer();
  }

  if (!serverProcess) {
    console.log('[potProvider] starting PO token server');
    serverProcess = spawn('node', [SERVER_ENTRY], { stdio: 'inherit' });
    serverProcess.on('exit', (code) => {
      console.error(`[potProvider] server exited with code ${code}`);
      serverProcess = null;
    });
    await waitForPort(4416, 60000);
  }
}

module.exports = { ensurePotProvider };
