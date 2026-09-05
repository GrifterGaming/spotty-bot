module.exports = {
  name: 'interactionCreate',
  once: false,
  async execute(interaction, distube) {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: 'This bot only works inside a server, not in DMs.',
        ephemeral: true,
      });
    }

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, distube);
    } catch (err) {
      console.error(`Error executing /${interaction.commandName}:`, err);
      const payload = {
        content: 'Something went wrong running that command.',
        ephemeral: true,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  },
};
