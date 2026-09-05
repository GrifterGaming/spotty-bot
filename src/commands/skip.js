const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current song.'),
  async execute(interaction, distube) {
    const queue = distube.getQueue(interaction.guildId);
    if (!queue) {
      return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    }

    try {
      await queue.skip();
      await interaction.reply('Skipped.');
    } catch (err) {
      await interaction.reply({
        content: "Can't skip — that's the last song in the queue. Use /stop to end playback.",
        ephemeral: true,
      });
    }
  },
};
