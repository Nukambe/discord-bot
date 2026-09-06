import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import { checkForUpdate, installUpdate, isPackaged, relaunch } from "../selfUpdate.js";

// Only one update may be in flight: a second /update landing mid-download would
// rename the exe aside twice and race the first one's file copy.
let updating = false;

export default {
  data: new SlashCommandBuilder()
    .setName("update")
    .setDescription("Check GitHub for a newer MogoBot release and install it (restarts the bot).")
    .addBooleanOption((opt) =>
      opt
        .setName("check-only")
        .setDescription("Only report whether an update is available; don't install it.")
        .setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  cooldown: 10,
  async execute(interaction) {
    const checkOnly = interaction.options.getBoolean("check-only") ?? false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isPackaged()) {
      return interaction.editReply(
        "ℹ️ This bot is running from source, not the packaged MogoBot.exe — nothing to update. Pull the repo and restart instead.",
      );
    }

    if (updating) {
      return interaction.editReply("⏳ An update is already in progress — the bot will restart when it's done.");
    }

    let status;
    try {
      status = await checkForUpdate();
    } catch (err) {
      console.warn(`⚠️ /update: update check failed: ${err.message}`);
      return interaction.editReply(`❌ Couldn't reach GitHub to check for updates: ${err.message}`);
    }

    const { installedTag, latestTag, release, updateAvailable } = status;

    if (!installedTag) {
      return interaction.editReply(
        `⚠️ Couldn't determine the installed version (no version file next to the exe). Latest release is **${latestTag}** — restart the bot to record a baseline, then run \`/update\` again.`,
      );
    }

    if (!updateAvailable) {
      return interaction.editReply(`✅ MogoBot is up to date (**${installedTag}**).`);
    }

    if (checkOnly) {
      return interaction.editReply(
        `⬆️ Update available: **${installedTag}** → **${latestTag}**. Run \`/update\` without \`check-only\` to install it.`,
      );
    }

    updating = true;
    await interaction.editReply(`⬆️ Updating MogoBot **${installedTag}** → **${latestTag}**... downloading now.`);
    console.log(`⬆️ /update: updating MogoBot ${installedTag} -> ${latestTag} (requested by ${interaction.user.tag})...`);

    try {
      await installUpdate(release);
    } catch (err) {
      updating = false;
      console.error("💥 /update: install failed, continuing with current build:", err);
      return interaction.editReply(
        `❌ Update to **${latestTag}** failed: ${err.message}\nThe current build (**${installedTag}**) is still running.`,
      );
    }

    await interaction.editReply(
      `✅ Installed **${latestTag}**. Restarting now — the bot will be back online in about a minute.`,
    );

    // Log out before the new process logs in so two copies are never live at
    // once (they'd both answer commands and double-post the crons). The new
    // instance opens its own console window and runs the normal startup update
    // check, which sees the version file already at the new tag and starts.
    try { await interaction.client.destroy(); } catch { }
    relaunch();
    process.exit(0);
  },
};
