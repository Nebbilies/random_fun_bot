import {translateText} from "./translate-text.js";
import {getWebhook} from "./get-webhook.js";

export async function sendLandmine(message) {
    try {
        await message.delete();
        const translated = await translateText(message.content);
        const landmineText = `${translated}`;
        const webhook = await getWebhook(message.channel);
        await webhook.send({
            content: landmineText,
            username: message.member?.displayName || message.author.username,
            avatarURL: message.author.displayAvatarURL(),
            allowedMentions: { parse: [] },
        });

    } catch (err) {
        console.error("error: ", err);
    }
}
