const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause playback.'),
  async execute(interaction, distube) {
    const queue = distube.getQueue(interaction.guildId);
    if (!queue) {
      return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    }
    if (queue.paused) {
      return interaction.reply({ content: 'Already paused.', ephemeral: true });
    }

    await queue.pause();
    await interaction.reply('Paused.');
  },
};
