const { SlashCommandBuilder } = require('discord.js');
const { nowPlayingEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing song.'),
  async execute(interaction, distube) {
    const queue = distube.getQueue(interaction.guildId);
    if (!queue || !queue.songs.length) {
      return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    }

    await interaction.reply({ embeds: [nowPlayingEmbed(queue.songs[0])] });
  },
};
