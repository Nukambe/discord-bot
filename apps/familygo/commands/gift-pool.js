import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from "discord.js";
import { getDb, updateDb, defaultDb } from "../db.js";
import { poolsFromDb, getRotationState } from "../giftRotation.js";

// The db keys behind the two rosters, and how they read in replies.
const LISTS = {
  giftee: { key: "giftees", label: "giftee" },
  gifter: { key: "gifters", label: "gifter" },
};

function isSnowflake(s) {
  return typeof s === "string" && /^[0-9]{17,20}$/.test(s);
}

/**
 * Entry id for a member who has no Discord account in the server — a slug of their name,
 * matching the hand-written ids the rosters were seeded with ("oly-lifts", "mech-e").
 * Real users are keyed by their snowflake instead.
 */
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** How a roster entry renders in a reply: a mention for real users, the name otherwise. */
function describeEntry(entry) {
  const who = isSnowflake(entry.id) ? `<@${entry.id}>` : `**${entry.name || entry.id}**`;
  return entry.channel ? `${who} — <#${entry.channel}>` : who;
}

function listLines(entries) {
  return entries.length ? entries.map(e => `• ${describeEntry(e)}`) : ["• —"];
}

/**
 * The roster as stored, falling back to the seed when the key is absent (a db written
 * before the rosters moved into it). Incomplete entries — a seed slot whose env var is
 * unset — are dropped rather than written back, since the rotation ignores them anyway.
 */
function rawList(db, key) {
  const stored = db.giftRotation?.[key];
  const list = Array.isArray(stored) ? stored : defaultDb().giftRotation[key];
  return list.filter(e => e?.id && e?.channel);
}

/** Write both rosters back in one db update, preserving the rest of giftRotation. */
function writeLists(client, db, lists) {
  return updateDb(client, {
    giftRotation: { ...(db.giftRotation ?? defaultDb().giftRotation), ...lists },
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName("gift-pool")
    .setDescription("View or change who's in the gift rotation (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub
        .setName("view")
        .setDescription("Show the giftee/gifter rosters and the current rotation cycle")
    )
    .addSubcommand(sub =>
      sub
        .setName("add")
        .setDescription("Add someone to the giftee or gifter roster")
        .addStringOption(opt =>
          opt
            .setName("list")
            .setDescription("Which roster to add them to")
            .setRequired(true)
            .addChoices(
              { name: "giftee (in the rotation — can be selected)", value: "giftee" },
              { name: "gifter (always gifts, never selected)", value: "gifter" }
            )
        )
        .addChannelOption(opt =>
          opt
            .setName("channel")
            .setDescription("Their channel (where their rotation announcement goes)")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread)
        )
        .addUserOption(opt =>
          opt
            .setName("user")
            .setDescription("Their Discord account, if they have one in this server")
        )
        .addStringOption(opt =>
          opt
            .setName("name")
            .setDescription("Display name — required when there's no Discord user")
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("remove")
        .setDescription("Remove someone from the giftee or gifter roster")
        .addStringOption(opt =>
          opt
            .setName("list")
            .setDescription("Which roster to remove them from")
            .setRequired(true)
            .addChoices(
              { name: "giftee (in the rotation — can be selected)", value: "giftee" },
              { name: "gifter (always gifts, never selected)", value: "gifter" }
            )
        )
        .addUserOption(opt =>
          opt
            .setName("user")
            .setDescription("Their Discord account")
        )
        .addStringOption(opt =>
          opt
            .setName("entry")
            .setDescription("Name, entry id, or channel ID — for members without a Discord user")
        )
    ),
  cooldown: 3,

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const sub = interaction.options.getSubcommand();
      const db = (await getDb(interaction.client)) ?? defaultDb();

      if (sub === "view") {
        const { giftees, gifters } = poolsFromDb(db);
        // The cycle lives in the rotation channel's STATE line, not the db — read it so
        // the roster and "who's still up" are answered by one command.
        const state = await getRotationState(interaction.client).catch(() => null);
        const remaining = state
          ? state.remaining.map(id => giftees.find(g => g.id === id)).filter(Boolean)
          : [];

        const lines = [
          "🎁 **Gift Rotation Roster**",
          "",
          `**Giftees — selectable (${giftees.length}):**`,
          ...listLines(giftees),
          "",
          `**Gifters — always gift, never selected (${gifters.length}):**`,
          ...listLines(gifters),
          "",
          `**Remaining this cycle (${remaining.length}):**`,
          ...(state ? listLines(remaining) : ["• (couldn't read the rotation channel)"]),
        ];
        if (state?.skip) lines.push("", "⏭️ The next scheduled rotation is flagged to be skipped.");

        await interaction.editReply(lines.join("\n"));
        return;
      }

      const list = LISTS[interaction.options.getString("list", true)];
      const other = list === LISTS.giftee ? LISTS.gifter : LISTS.giftee;
      const current = rawList(db, list.key);
      const otherCurrent = rawList(db, other.key);

      if (sub === "add") {
        const channel = interaction.options.getChannel("channel", true);
        const user = interaction.options.getUser("user");
        const nameOpt = interaction.options.getString("name")?.trim();

        if (!user && !nameOpt) {
          await interaction.editReply("❌ Provide a **user**, a **name**, or both.");
          return;
        }

        const name = nameOpt || user.displayName || user.username;
        const id = user ? user.id : slugify(name);
        if (!id) {
          await interaction.editReply("❌ That name has no letters or numbers to key the entry on — pick another.");
          return;
        }

        const entry = { id, channel: channel.id, name };

        // Someone can only be in one roster, so adding to the other one moves them.
        const movedFrom = otherCurrent.some(e => e.id === id) ? other : null;
        const alreadyHere = current.find(e => e.id === id);

        const nextList = alreadyHere
          ? current.map(e => (e.id === id ? entry : e))
          : [...current, entry];

        await writeLists(interaction.client, db, {
          [list.key]: nextList,
          [other.key]: movedFrom ? otherCurrent.filter(e => e.id !== id) : otherCurrent,
        });

        const verb = movedFrom
          ? `Moved from **${movedFrom.label}s** to **${list.label}s**`
          : alreadyHere
            ? `Already a **${list.label}** — updated`
            : `Added as a **${list.label}**`;
        await interaction.editReply(
          `✅ ${verb}: ${describeEntry(entry)}\n**${list.label}s** now: **${nextList.length}**.`
        );
        return;
      }

      if (sub === "remove") {
        const user = interaction.options.getUser("user");
        const entryOpt = interaction.options.getString("entry")?.trim();

        if (!user && !entryOpt) {
          await interaction.editReply("❌ Provide a **user** or an **entry** (name, entry id, or channel ID).");
          return;
        }

        // A channel mention pastes as <#id>; accept that as readily as a bare id.
        const needle = (entryOpt ?? "").replace(/^<#(\d+)>$/, "$1").toLowerCase();
        const found = user
          ? current.find(e => e.id === user.id)
          : current.find(e =>
              e.id?.toLowerCase() === needle ||
              e.name?.toLowerCase() === needle ||
              e.channel === needle
            );

        if (!found) {
          await interaction.editReply(
            `ℹ️ ${user ? `<@${user.id}>` : `\`${entryOpt}\``} isn't in the **${list.label}** roster. Check \`/gift-pool view\`.`
          );
          return;
        }

        const nextList = current.filter(e => e.id !== found.id);
        await writeLists(interaction.client, db, { [list.key]: nextList, [other.key]: otherCurrent });

        await interaction.editReply(
          `✅ Removed ${describeEntry(found)} from **${list.label}s**.\n**${list.label}s** now: **${nextList.length}**.`
        );
      }
    } catch (err) {
      console.error("💥 Gift pool command failed:", err);
      await interaction.editReply("❌ Failed to update the gift rotation roster.");
    }
  },
};
