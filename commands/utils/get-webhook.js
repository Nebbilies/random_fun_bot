export async function getWebhook(channel) {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.owner.id === channel.client.user.id);
    if (!webhook) {
        webhook = await channel.createWebhook({
            name: "Meow Meow Bomb"
        });
    }
    return webhook;
}