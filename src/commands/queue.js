const { SlashCommandBuilder } = require('discord.js');
const { queueEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current queue.'),
  async execute(interaction, distube) {
    const queue = distube.getQueue(interaction.guildId);
    if (!queue || !queue.songs.length) {
      return interaction.reply({ content: 'The queue is empty.', ephemeral: true });
    }

    await interaction.reply({ embeds: [queueEmbed(queue)] });
  },
};
