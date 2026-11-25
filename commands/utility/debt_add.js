import { SlashCommandBuilder, Embed } from "discord.js";
import { readFileSync, writeFileSync } from "fs";

export const data = new SlashCommandBuilder()
  .setName("debt")
  .setDescription("Add a debt")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add a debt")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("The user to add the debt to")
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("amount")
          .setDescription("The amount of debt to add (don vi: K)")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("list").setDescription("List all debts"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove a debt")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("The user to remove the debt from")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("amount")
          .setDescription("The amount of debt to remove (don vi: K)")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("ping").setDescription("Ping mấy con nợ"),
  );

async function handleAddCommand(client, interaction, debt, creditorRecord) {
  const debtor = interaction.options.getUser("user"); //con no
  const amount = interaction.options.getInteger("amount");
  if (!creditorRecord.debtors[debtor]) {
    creditorRecord.debtors[debtor] = amount;
  } else {
    creditorRecord.debtors[debtor] += amount;
  }
  writeFileSync("./data/debt.txt", JSON.stringify(debt, null, 2));
  await interaction.reply({
    content: `Đã cộng **${amount}K** vào tổng nợ của ${debtor} **(${creditorRecord.debtors[debtor]}K)**`,
    ephemeral: true,
  });
}

async function handleListCommand(interaction, debt, creditorRecord) {
  const creditor = interaction.user.id;
  let embedDescription = "";
  for (let debtor in creditorRecord.debtors) {
    embedDescription += `${debtor}: ${creditorRecord.debtors[debtor]}K\n`;
  }
  const embed = new Embed({
    title: `May con no cua ${interaction.user.globalName}`,
    color: 0x00ff00,
    description: embedDescription,
  });
  await interaction.reply({ embeds: [embed], ephemeral: false });
}

async function handleRemoveCommand(interaction, debt, creditorRecord) {
  const debtor = interaction.options.getUser("user");
  const amount = interaction.options.getString("amount");
  if (!creditorRecord.debtors[debtor]) {
    await interaction.reply({
      content: `**${debtor} khong co no voi ban**`,
      ephemeral: true,
    });
  } else {
    creditorRecord.debtors[debtor] -= amount;
    let amountAfter =
      creditorRecord.debtors[debtor] < 0 ? 0 : creditorRecord.debtors[debtor];
    await interaction.reply({
      content: `Đã trừ **${amount}K** từ tổng nợ của ${debtor} **(${amountAfter}K)**`,
      ephemeral: true,
    });
    if (amountAfter === 0) {
      delete creditorRecord.debtors[debtor];
    }
    writeFileSync("./data/debt.txt", JSON.stringify(debt, null, 2));
  }
}

async function handlePingCommand(interaction, debt) {
  const creditor = interaction.user.id;
  let creditorRecord = debt.find((record) => record.creditorId === creditor);
  if (!creditorRecord || Object.keys(creditorRecord.debtors).length === 0) {
    await interaction.reply({ content: "Chua co ai no ban", ephemeral: true });
  } else {
    let embedDescription = "";
    for (let debtor in creditorRecord.debtors) {
      embedDescription += `${debtor}: ${creditorRecord.debtors[debtor]}K\n`;
    }
    await interaction.reply({
      content: `Ping trả nợ của **<@${creditor}>**\n` + embedDescription,
    });
  }
}

export async function execute(interaction) {
  let debt = readFileSync("./data/debt.txt", "utf-8");
  if (debt === "") {
    debt = [];
  } else {
    debt = JSON.parse(debt);
  } //con no
  const creditor = interaction.user.id; //chu no
  let creditorRecord = debt.find((record) => record.creditorId === creditor);
  if (!creditorRecord) {
    creditorRecord = {
      creditorId: creditor,
      debtors: {},
    };
    debt.push(creditorRecord);
  }
  switch (interaction.options.getSubcommand()) {
    case "add":
      await handleAddCommand(interaction, debt, creditorRecord);
      break;
    case "list":
      await handleListCommand(interaction, debt, creditorRecord);
      break;
    case "remove":
      await handleRemoveCommand(interaction, debt, creditorRecord);
      break;
    case "ping":
      await handlePingCommand(interaction, debt);
      break;
  }
}
