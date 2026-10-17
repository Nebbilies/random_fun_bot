import { EmbedBuilder } from "discord.js";

const imageExtensions = new Map([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
]);
const userAgent = process.env.DANBOORU_USER_ID
    ? `RandomFunBot/1.0 (user #${process.env.DANBOORU_USER_ID})`
    : "RandomFunBot/1.0 (https://github.com/Nebbilies/random_fun_bot)";

export async function getTopAstraYaoImage() {
    const url = new URL("https://safebooru.donmai.us/posts.json");
    url.searchParams.set("tags", "astra_yao rating:g order:score");
    url.searchParams.set("limit", "10");

    const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": userAgent },
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Danbooru posts request failed: HTTP ${response.status}`);

    const posts = await response.json();
    const post = posts.find((candidate) =>
        ["jpg", "jpeg", "png", "webp", "gif"].includes(candidate.file_ext) &&
        (candidate.large_file_url || candidate.file_url));
    if (!post) throw new Error("Danbooru returned no general-rated Astra Yao image");

    return { post, imageUrl: post.large_file_url ?? post.file_url };
}

export function astraYaoEmbed(post, imageUrl, method) {
    return new EmbedBuilder()
        .setTitle("Astra Yao")
        .setURL(`https://safebooru.donmai.us/posts/${post.id}`)
        .setDescription(method)
        .setImage(imageUrl)
        .setFooter({ text: `Danbooru post #${post.id} · score ${post.score}` });
}

export async function downloadAstraYaoImage(post, imageUrl) {
    const response = await fetch(imageUrl, {
        headers: {
            "User-Agent": userAgent,
            Referer: `https://safebooru.donmai.us/posts/${post.id}`,
        },
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Danbooru image request failed: HTTP ${response.status}`);

    const contentType = response.headers.get("content-type")?.split(";")[0];
    const extension = imageExtensions.get(contentType);
    if (!extension) throw new Error(`Unsupported Danbooru image type: ${contentType}`);

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        name: `astra-yao-${post.id}.${extension}`,
    };
}
