require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { createDisTube } = require('./src/music/distubeClient');

// Node defaults to preferring IPv6 addresses, but the UDP voice connection to
// Discord's voice servers frequently can't complete over IPv6 on many networks,
// causing @discordjs/voice to hang and time out ("Cannot connect to the voice
// channel after 30 seconds"). Prefer IPv4 to avoid that.
dns.setDefaultResultOrder('ipv4first');

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.commands = new Collection();
const commandsDir = path.join(__dirname, 'src', 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  client.commands.set(command.data.name, command);
}

const distube = createDisTube(client);

distube
  .on('playSong', (queue, song) => {
    queue.textChannel?.send(`Now playing: **${song.name}** (requested by ${song.user})`);
  })
  .on('addSong', (queue, song) => {
    queue.textChannel?.send(`Queued: **${song.name}**`);
  })
  .on('addList', (queue, playlist) => {
    queue.textChannel?.send(`Queued **${playlist.songs.length}** songs from **${playlist.name}**`);
  })
  .on('finish', (queue) => {
    // DisTube v5 no longer auto-leaves the voice channel on its own — do it here.
    queue.textChannel?.send('Queue finished — leaving the voice channel.');
    distube.voices.leave(queue.id);
  })
  .on('disconnect', (queue) => {
    queue.textChannel?.send('Disconnected from the voice channel.');
  })
  .on('error', (error, queue, song) => {
    console.error('DisTube error:', error);
    // yt-dlp's underlying error message can be very long (especially in verbose
    // debugging modes) — Discord rejects any message over 4000 characters outright
    // (confirmed directly: DiscordAPIError[50035] Invalid Form Body), which was
    // silently swallowing our own error-reporting message. Truncate defensively.
    const prefix = `Error playing ${song ? `**${song.name}**` : 'that song'}, skipping: `;
    const detail = (error?.message || 'unknown error').slice(0, 1900 - prefix.length);
    queue?.textChannel?.send(prefix + detail).catch((err) => console.error('Failed to send error message:', err));
  });

// DisTube v5 doesn't auto-leave an empty voice channel, so watch for it ourselves.
client.on('voiceStateUpdate', (oldState) => {
  const guildId = oldState.guild.id;
  const queue = distube.getQueue(guildId);
  if (!queue) return;

  const voiceChannel = queue.voice.channel;
  const humanMembers = voiceChannel.members.filter((member) => !member.user.bot);
  if (humanMembers.size === 0) {
    queue.textChannel?.send('Everyone left the voice channel — leaving.');
    queue.stop();
    distube.voices.leave(guildId);
  }
});

const eventsDir = path.join(__dirname, 'src', 'events');
for (const file of fs.readdirSync(eventsDir).filter((f) => f.endsWith('.js'))) {
  const event = require(path.join(eventsDir, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, distube));
  } else {
    client.on(event.name, (...args) => event.execute(...args, distube));
  }
}

client.login(process.env.DISCORD_TOKEN);
