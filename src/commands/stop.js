const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave the voice channel.'),
  async execute(interaction, distube) {
    const queue = distube.getQueue(interaction.guildId);
    if (!queue) {
      return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    }

    await queue.stop();
    distube.voices.leave(interaction.guildId);
    await interaction.reply('Stopped and left the voice channel.');
  },
};
