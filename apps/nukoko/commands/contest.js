import { SlashCommandBuilder, EmbedBuilder } from "discord.js";

// Bond Contest is empty for every character in the source sheet, so only
// the Bond Contest Res value ("Xatt – Y%") is tracked as `bond`.
// Talent Contest / Talent Contest Res are both free-text talent notes and
// are combined into a single `talent` string.

const ROSTER = {
  PG: [
    { name: "Yukio", contest: 86, contestRes: 93, pass: 124 },
    { name: "Shoichi", contest: 92, contestRes: 98, pass: 117, talent: "5% side hop shot; 5% forward hop layup; 5% up and under layup" },
    { name: "Kuroko", contest: 74, contestRes: 86, pass: 122, bond: "5att – 1.5%" },
    { name: "Shun", contest: 89, contestRes: 90, pass: 127, bond: "3att – 1.5%", talent: "5% Sidestep layup" },
    { name: "Takao", contest: 89, contestRes: 90, pass: 130, talent: "5% Falcon strike layup" },
    { name: "akashi", contest: 94, contestRes: 98, pass: 132, bond: "10att – 3%", talent: "5% Crimson emperor steps; 5% Crossover layup(?); 5% Lightening shot" },
    { name: "Koki", contest: 92, contestRes: 88, pass: 122, talent: "5% Quick layup" },
  ],
  SG: [
    { name: "Himuro", contest: 72, contestRes: 108, pass: 127, bond: "3att – 1.5%", talent: "5% stepback fadeaway" },
    { name: "Junpei", contest: 70, contestRes: 114, pass: 112, bond: "6att – 3%", talent: "5% fast break shot" },
    { name: "Moriyama", contest: 72, contestRes: 101, pass: 117, bond: "3att – 1.5%", talent: "10.00%" },
    { name: "Midorima", contest: 75, contestRes: 102, pass: 110, bond: "6att – 3%", talent: `5% "overwhelmed" (?); 5% ready catch 3pointer` },
    { name: "Ryo", contest: 80, contestRes: 98, pass: 122, bond: "3att – 1.5%", talent: "5% drive quick shot" },
  ],
  SF: [
    { name: "Liu", contest: 90, contestRes: 94, pass: 102, bond: "5att – 1.5%", talent: "5% volley ball blk; 5% catch and floater" },
    { name: "Kotaro", contest: 70, contestRes: 109, pass: 115, bond: "3att – 1.5%", talent: "5% Thunder aerial floater (?); 5% stop pump fake shot" },
    { name: "Shinji", contest: 70, contestRes: 109, pass: 115, bond: "5att – 1.5%", talent: "5% Nimble fadeaway" },
    { name: "Kise", contest: 72, contestRes: 114, pass: 117, talent: "7% stepback jumper" },
  ],
  PF: [
    { name: "zao", contest: 94, contestRes: 85, pass: 121, talent: "5% side hook, after ankles" },
    { name: "Satoshi", contest: 91, contestRes: 70, pass: 103, talent: "5% nimble layup; 5% landing stepback shot" },
    { name: "Chihiro", contest: 86, contestRes: 82, pass: 123, talent: "5% catch flash pass" },
    { name: "Kagami", contest: 98, contestRes: 70, pass: 105, talent: "8% Stop and fadeaway; 10% spin stop & dunk" },
    { name: "Hayakawa", contest: 96, contestRes: 65, pass: 101, talent: "10% Quick release poster" },
    { name: "ao", contest: 94, contestRes: 85, pass: 121, talent: "5% raid block; 5% formless: Prone fade; 5% Formless paint spin (?)" },
    { name: "zkag", contest: 96, contestRes: 80, pass: 119, talent: "5% blazing lockdown; 5% instant catch and shoot" },
  ],
  C: [
    { name: "Mura", contest: 121, contestRes: 70, pass: 92, talent: "5.00%; 5% destructive dunk" },
    { name: "Mitobe", contest: 101, contestRes: 82, pass: 101, talent: "5.00%; 5% hook shot; 5% catch and layup" },
    { name: "Otsubo", contest: 111, contestRes: 65, pass: 95, talent: "5% Roar Blk" },
    { name: "Koji", contest: 106, contestRes: 68, pass: 95 },
    { name: "teppei", contest: 108, contestRes: 82, pass: 104, talent: "5% Reactive side sky hook" },
    { name: "Wakamatsu", contest: 101, contestRes: 82, pass: 101, talent: "5% Catch quick shot, in burst" },
  ],
};

const COLLAB = {
  PG: [
    { name: "Hanamiya", contest: 75, contestRes: 75, pass: 101 },
    { name: "Miracle Kuroko", contest: 60, contestRes: 68, pass: 98, bond: "5att – 1.5%", talent: "5% catch and shoot" },
    { name: "SP akashi", contest: 80, contestRes: 80, pass: 100, bond: "10att – 3%", talent: "5% burst block; 5% catch and step layup; 5% stop and pull up" },
  ],
  SG: [
    { name: "Div Mido", contest: 81, contestRes: 76, pass: 82, bond: "6att – 3%", talent: "5.00%; 5% raccoon; 5% step back jumper; 5% alley oop 3pt; 5% oop land jumper" },
    { name: "Reo", contest: 70, contestRes: 80, pass: 85, bond: "6att – 3%", talent: "5% Heaven's shot; 5% catch and shoot; 5% lateral hop shot" },
  ],
  SF: [
    { name: "PC Kise", contest: 78, contestRes: 85, pass: 90, bond: "10att – 3%", talent: "5% Composure shot (?)" },
  ],
  PF: [
    { name: "LG Kag", contest: 82, contestRes: 75, pass: 88, talent: "5% Meteor Board self alley; 5% alleyoop windmill" },
  ],
  C: [
    { name: "Silver", contest: 95, contestRes: 70, pass: 70 },
    { name: "Z Mura", contest: 95, contestRes: 70, pass: 70, talent: "5% 2 arm shroud; 5% landing 1 arm slam" },
  ],
};

const POSITION_EMOJI = { PG: "🔴", SG: "🟢", SF: "🟡", PF: "🔵", C: "🟣" };
const POSITION_ORDER = ["PG", "SG", "SF", "PF", "C"];

function buildGroupField(position, entries) {
  const nameWidth = Math.max(...entries.map((e) => e.name.length), 4);
  const header = `${"Name".padEnd(nameWidth)}  Cont CRes Pass`;
  const rows = entries.map(
    (e) =>
      `${e.name.padEnd(nameWidth)}  ${String(e.contest).padStart(4)} ${String(
        e.contestRes
      ).padStart(4)} ${String(e.pass).padStart(4)}`
  );
  const table = "```\n" + [header, ...rows].join("\n") + "\n```";

  const notes = entries
    .filter((e) => e.bond || e.talent)
    .map((e) => {
      const parts = [];
      if (e.bond) parts.push(`Bond ${e.bond}`);
      if (e.talent) parts.push(`Talent: ${e.talent}`);
      return `• **${e.name}** — ${parts.join(" | ")}`;
    })
    .join("\n");

  return {
    name: `${POSITION_EMOJI[position]} ${position}`,
    value: notes ? `${table}\n${notes}` : table,
  };
}

function buildEmbed(title, color, data) {
  const fields = POSITION_ORDER.filter((pos) => data[pos]?.length).map((pos) =>
    buildGroupField(pos, data[pos])
  );

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription("**Cont** = Contest, **CRes** = Contest Res, **Pass** = Pass rating")
    .addFields(fields);
}

export default {
  data: new SlashCommandBuilder()
    .setName("contest")
    .setDescription("Shows Base Attribute / Bond / Talent contest stats for every character"),
  async execute(interaction) {
    const rosterEmbed = buildEmbed("📊 Contest Stats — Main Roster", 0x3498db, ROSTER);
    const collabEmbed = buildEmbed("📊 Contest Stats — Limited / Collab", 0x9b59b6, COLLAB);

    await interaction.reply({ embeds: [rosterEmbed, collabEmbed] });
  },
};
