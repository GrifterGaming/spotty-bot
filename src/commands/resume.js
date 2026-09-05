const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume playback.'),
  async execute(interaction, distube) {
    const queue = distube.getQueue(interaction.guildId);
    if (!queue) {
      return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    }
    if (!queue.paused) {
      return interaction.reply({ content: 'Already playing.', ephemeral: true });
    }

    await queue.resume();
    await interaction.reply('Resumed.');
  },
};
