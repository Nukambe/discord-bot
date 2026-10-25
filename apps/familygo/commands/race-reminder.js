import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import {
  RACE_REMINDER_STEPS,
  sendDueRaceReminder,
  startRaceReminders,
  stepTime,
  stopRaceReminders,
} from "../raceReminder.js";

/** e.g. "5:00 PM and 9:00 PM today, then 9:00 AM and 12:00 PM tomorrow". */
const SCHEDULE_TEXT = [0, 1]
  .map((day) => {
    const times = RACE_REMINDER_STEPS.filter((s) => s.dayOffset === day).map(stepTime);
    return `${times.join(" and ")} ${day === 0 ? "today" : "tomorrow"}`;
  })
  .join(", then ");

export default {
  data: new SlashCommandBuilder()
    .setName("race-reminder")
    .setDescription("Remind everyone in their own channel to join their racers team (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("Remind at 5 & 9 PM today, 9 AM & 12 PM tomorrow, until each person presses Yes")
    )
    .addSubcommand((sub) => sub.setName("stop").setDescription("Stop the race reminders that are running")),
  cooldown: 3,

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const { client } = interaction;

    try {
      if (interaction.options.getSubcommand() === "stop") {
        const stopped = await stopRaceReminders(client);
        await interaction.editReply(
          stopped
            ? "🛑 Race reminders stopped. Any Yes buttons already posted still work."
            : "ℹ️ No race reminders are running."
        );
        return;
      }

      const { race, replaced } = await startRaceReminders(client);
      // Started after 5pm: whatever reminder is due right now goes out straight away.
      const now = await sendDueRaceReminder(client);

      const lines = [`🏎️ Race reminders started for **${race.people.length}** channels — ${SCHEDULE_TEXT}.`];
      if (now) {
        const step = RACE_REMINDER_STEPS[now.step];
        lines.push(`It's already past ${stepTime(step)}, so that reminder went out to ${now.sent} channel(s) just now.`);
        if (now.failed.length) lines.push(`⚠️ Couldn't post in: ${now.failed.join(", ")}.`);
      }
      lines.push("Each reminder only goes to people who haven't pressed **Yes** yet.");
      if (replaced) lines.push(`This replaces the race reminders started ${replaced.date}.`);
      await interaction.editReply(lines.join("\n"));
    } catch (err) {
      console.error("💥 Race reminder command failed:", err);
      await interaction.editReply("❌ Couldn't run the race reminders. `/dump-logs` has the details.");
    }
  },
};
