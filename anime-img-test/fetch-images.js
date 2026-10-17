import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDir = join(dirname(fileURLToPath(import.meta.url)), 'output');
const imageTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
]);

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function saveImage(url, name, headers = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);

  const contentType = response.headers.get('content-type')?.split(';')[0];
  const extension = imageTypes.get(contentType);
  if (!extension) throw new Error(`${url}: unexpected content type ${contentType}`);

  const path = join(outputDir, `${name}.${extension}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  console.log(`Saved ${path}`);
}

async function fetchDanbooru() {
  const savedIds = new Set(
    (await readdir(outputDir))
      .map((name) => /^danbooru-astra-yao-(\d+)\./.exec(name)?.[1])
      .filter(Boolean),
  );
  const url = new URL('https://safebooru.donmai.us/posts.json');
  url.searchParams.set('tags', 'astra_yao rating:g');
  url.searchParams.set('random', 'true');
  url.searchParams.set('limit', '10');

  const userId = process.env.DANBOORU_USER_ID;
  const userAgent = userId
    ? `RandomFunBotImageTest/1.0 (user #${userId})`
    : 'RandomFunBotImageTest/1.0 (anonymous)';
  let saved = 0;

  for (let batch = 0; batch < 5 && saved < 10; batch++) {
    if (batch > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    const posts = await getJson(url, { 'User-Agent': userAgent });

    for (const post of posts) {
      if (saved === 10) break;
      const id = String(post.id);
      const imageUrl = post.large_file_url ?? post.file_url;
      if (savedIds.has(id) || !imageUrl) continue;

      try {
        await saveImage(imageUrl, `danbooru-astra-yao-${id}`, {
          'User-Agent': userAgent,
          Referer: `https://safebooru.donmai.us/posts/${id}`,
        });
        savedIds.add(id);
        saved++;
      } catch (error) {
        console.warn(`Skipped post ${id}: ${error.message}`);
      }
    }
  }

  if (saved < 10) throw new Error(`Saved only ${saved} new Astra Yao images; try again.`);
}

await mkdir(outputDir, { recursive: true });
await fetchDanbooru();
