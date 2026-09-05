const { SlashCommandBuilder } = require('discord.js');

// yt-dlp resolution can take a couple of minutes right now (see README). Without this
// guard, pressing /play again while the first attempt is still resolving spawns a
// second, fully redundant yt-dlp search+stream lookup for the same track — observed
// directly during testing (multiple concurrent identical yt-dlp processes), which
// only makes the wait longer for everyone.
const resolvingGuilds = new Set();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a Spotify track/playlist/album link, or search by name.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Spotify link or search text')
        .setRequired(true),
    ),
  async execute(interaction, distube) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: 'Join a voice channel first.',
        ephemeral: true,
      });
    }

    if (resolvingGuilds.has(interaction.guildId)) {
      return interaction.reply({
        content:
          "Still working on the last /play — resolving a song can take a couple of minutes right now, please wait for it to finish before trying again.",
        ephemeral: true,
      });
    }

    const query = interaction.options.getString('query', true);
    await interaction.deferReply();
    resolvingGuilds.add(interaction.guildId);

    try {
      await distube.play(voiceChannel, query, {
        member: interaction.member,
        textChannel: interaction.channel,
      });
      await interaction.editReply(`Looking that up and queuing: **${query}**`);
    } catch (err) {
      console.error('Error in /play:', err);

      let message = "Couldn't play that. Check the link/search term and try again.";
      if (err.errorCode === 'VOICE_MISSING_PERMS') {
        message = `I don't have permission to join **${voiceChannel.name}**. Check that my role (or this channel's permission overrides) allows Connect and Speak.`;
      } else if (err.errorCode === 'JOIN_VOICE_CHANNEL_FAILED') {
        message = `Couldn't join **${voiceChannel.name}** — try again in a moment.`;
      }

      await interaction.editReply(message);
    } finally {
      resolvingGuilds.delete(interaction.guildId);
    }
  },
};
