const { EmbedBuilder } = require('discord.js');

function nowPlayingEmbed(song) {
  return new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle('Now Playing')
    .setDescription(`[${song.name}](${song.url})`)
    .addFields(
      { name: 'Duration', value: song.formattedDuration || 'Unknown', inline: true },
      { name: 'Requested by', value: song.user ? `${song.user}` : 'Unknown', inline: true },
    )
    .setThumbnail(song.thumbnail || null);
}

function queueEmbed(queue) {
  const upcoming = queue.songs.slice(1, 11);
  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle('Queue')
    .setDescription(
      `**Now Playing:** [${queue.songs[0].name}](${queue.songs[0].url})\n\n` +
        (upcoming.length
          ? upcoming
              .map((song, i) => `${i + 1}. [${song.name}](${song.url})`)
              .join('\n')
          : '*No more songs queued*'),
    );

  const remaining = queue.songs.length - 1 - upcoming.length;
  if (remaining > 0) {
    embed.setFooter({ text: `+${remaining} more song(s)` });
  }

  return embed;
}

module.exports = { nowPlayingEmbed, queueEmbed };
