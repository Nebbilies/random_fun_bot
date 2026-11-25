export const run = async (ctx) => {
  if (ctx.message.channelId !== ctx.yoshiko.config.channelId) {
    ctx.message.reply("Command không được sử dụng ở channel này!");
    return;
  }

  const author = ctx.message.author;
  const members = await ctx.message.guild.members.fetch();
  const chooseUser = members
    .filter((member) => !member.user.bot && member.id !== author.id)
    .random().user;

  const commandCooldown = ctx.yoshiko.cooldowns.find(
    (cc) => cc.commandName === "chooserandom",
  );
  const cooldown = await commandCooldown.getUser(author.id);

  if (cooldown) {
    ctx.message.reply(`Còn **${cooldown.msLeft / 1000} giây** cooldown!`);
    return;
  }

  ctx.message.channel.send(
    `<@${chooseUser.id}> là người được chọn bởi <@${author.id}>`,
  );
  await commandCooldown.addUser(author.id);
};
