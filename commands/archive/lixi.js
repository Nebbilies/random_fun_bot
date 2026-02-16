export const run = async (ctx) => {
    const author = ctx.message.author;
    const members = await ctx.message.guild.members.fetch();
    const chooseUser = members.filter((member) => !member.user.bot && member.id !== author.id).random().user;

    const commandCooldown = ctx.yoshiko.cooldowns.find((cc) => cc.commandName === "lixi");
    const cooldown = await commandCooldown.getUser(author.id);

    if (cooldown) {
        ctx.message.reply(`Còn **${cooldown.msLeft / 1000} giây** cooldown!`);
        return;
    }

    ctx.message.channel.send(`<@${chooseUser.id}> sẽ được lì xì 1000 VNĐ bởi <@${author.id}>`);
    await commandCooldown.addUser(author.id);
};
