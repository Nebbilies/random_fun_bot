import { lookup } from "node:dns/promises";
import { get } from "node:https";
import { BlockList, isIP } from "node:net";

const maxBytes = 4 * 1024 * 1024;
const redirectCodes = new Set([301, 302, 303, 307, 308]);
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  blocked.addSubnet(address, prefix);
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
])
  blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

function isPublic(address, family) {
  return family === 4
    ? !blocked.check(address)
    : globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

function openPortrait(url, signal) {
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Portrait URL must use public HTTPS");
  }
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const literalFamily = isIP(hostname);
  if (literalFamily && !isPublic(hostname, literalFamily))
    throw new Error("Portrait address must be public");

  return new Promise((resolve, reject) => {
    // Use the checked address for this connection. A second DNS lookup could return a private address.
    const request = get(
      url,
      {
        signal,
        agent: false,
        autoSelectFamily: false,
        lookup: (host, _options, callback) => {
          lookup(host, { all: true }).then((addresses) => {
            const target = addresses.find(({ address, family }) =>
              isPublic(address, family),
            );
            if (target) callback(null, target.address, target.family);
            else callback(new Error("Portrait address must be public"));
          }, callback);
        },
      },
      resolve,
    );
    request.on("error", reject);
  });
}

function isRaster(buffer) {
  return (
    buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ||
    buffer.subarray(0, 3).toString("hex") === "ffd8ff" ||
    ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6)) ||
    (buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP")
  );
}

export async function downloadProfilePortrait(source) {
  const signal = AbortSignal.timeout(5_000);
  let url = new URL(source);
  for (let hop = 0; ; hop++) {
    const response = await openPortrait(url, signal);
    if (
      redirectCodes.has(response.statusCode) &&
      response.headers.location &&
      hop < 2
    ) {
      response.destroy();
      url = new URL(response.headers.location, url);
      continue;
    }
    if (
      response.statusCode !== 200 ||
      Number(response.headers["content-length"]) > maxBytes
    ) {
      response.destroy();
      throw new Error("Portrait download unavailable");
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("Portrait exceeds the size limit");
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks, bytes);
    if (!isRaster(buffer)) throw new Error("Unsupported portrait format");
    return buffer;
  }
}
