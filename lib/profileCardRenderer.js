import { fileURLToPath } from "node:url";
import { Canvas, FontLibrary, loadImage } from "skia-canvas";
import { downloadProfilePortrait } from "./profileCardPortraits.js";

const width = 1440;
const height = 1080;
const paper = "#f5efe4";
const ink = "#2d211c";
const muted = "#604c40";
const accent = "#873943";
const rule = "#bfae9c";
const serif = '"Profile Serif", serif';
const sans = '"Profile Sans", sans-serif';
const mono = '"Profile Mono", monospace';
const numbers = new Intl.NumberFormat("en-US");
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
let fontsReady = false;

function registerFonts() {
  if (fontsReady) return;
  const fontPath = (name) =>
    fileURLToPath(new URL(`../assets/profile-fonts/${name}`, import.meta.url));
  const registered = FontLibrary.use({
    "Profile Serif": [
      "InstrumentSerif-Regular.ttf",
      "InstrumentSerif-Italic.ttf",
    ].map(fontPath),
    "Profile Sans": [fontPath("Geist.ttf")],
    "Profile Mono": [fontPath("IBMPlexMono-Medium.ttf")],
  });
  if (Object.values(registered).some((faces) => !faces.length))
    throw new Error("Couldn’t load profile card fonts");
  fontsReady = true;
}

export async function preparePortraits(
  model,
  download = downloadProfilePortrait,
) {
  const sources = new Set(
    [
      model.avatarUrl,
      model.soulmate?.portraitUrl,
      ...model.topCharacters.map((character) => character.portraitUrl),
    ].filter(Boolean),
  );
  const portraits = await Promise.all(
    [...sources].map(async (url) => {
      try {
        const image = await loadImage(await download(url));
        return [url, image.width && image.height ? image : null];
      } catch {
        return [url, null];
      }
    }),
  );
  return new Map(portraits);
}

function box(ctx, x, y, w, h, radius, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function ellipsis(ctx, value, maxWidth) {
  if (ctx.measureText(value).width <= maxWidth) return value;
  const parts = Array.from(graphemes.segment(value), (part) => part.segment);
  while (
    parts.length &&
    ctx.measureText(`${parts.join("").trimEnd()}…`).width > maxWidth
  )
    parts.pop();
  return `${parts.join("").trimEnd()}…`;
}

function text(
  ctx,
  value,
  x,
  y,
  { font, color = ink, align = "left", maxWidth = Infinity, compact } = {},
) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  if (compact && ctx.measureText(value).width > maxWidth) ctx.font = compact;
  ctx.fillText(ellipsis(ctx, value, maxWidth), x, y);
}

function twoLines(ctx, value, maxWidth) {
  const words = value.trim().split(/\s+/);
  let first = words[0];
  let next = 1;
  while (
    next < words.length &&
    ctx.measureText(`${first} ${words[next]}`).width <= maxWidth
  ) {
    first += ` ${words[next++]}`;
  }
  return next === words.length ? [first] : [first, words.slice(next).join(" ")];
}

function drawPortrait(ctx, image, x, y, w, h, radius = 0) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.clip();
  if (image) {
    const scale = Math.max(w / image.width, h / image.height);
    const imageWidth = image.width * scale;
    const imageHeight = image.height * scale;
    ctx.drawImage(
      image,
      x + (w - imageWidth) / 2,
      y + (h - imageHeight) / 2,
      imageWidth,
      imageHeight,
    );
  } else {
    ctx.fillStyle = "#d9ccba";
    ctx.fillRect(x, y, w, h);
    text(ctx, "?", x + w / 2, y + h / 2, {
      font: `600 ${Math.round(Math.min(w, h) * 0.42)}px ${sans}`,
      align: "center",
      color: muted,
    });
  }
  ctx.restore();
}

function heart(ctx, x, y, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.beginPath();
  ctx.moveTo(12, 22);
  ctx.lineTo(2.9, 13.2);
  ctx.bezierCurveTo(-3.9, 6.6, 3.5, -2.1, 9.9, 2.6);
  ctx.lineTo(12, 4.1);
  ctx.lineTo(14.1, 2.6);
  ctx.bezierCurveTo(20.5, -2.1, 27.9, 6.6, 21.1, 13.2);
  ctx.closePath();
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.75;
  ctx.stroke();
  ctx.restore();
}

function drawSoulmate(ctx, soulmate, portraits) {
  box(ctx, 816, 32, 576, 416, 5, "#efe3d4", rule);
  if (!soulmate) {
    text(ctx, "SOULMATE", 852, 184, {
      font: `600 38px ${sans}`,
      color: accent,
    });
    text(ctx, "No soulmate selected", 852, 245, {
      font: `51px ${serif}`,
      maxWidth: 504,
    });
    return;
  }

  drawPortrait(ctx, portraits.get(soulmate.portraitUrl), 1153, 33, 238, 414, 4);
  ctx.fillStyle = "#a16c68";
  ctx.fillRect(1151, 33, 2, 414);
  const nameWidth = 284;
  let nameFont = `italic 94px ${serif}`;
  let lineHeight = 105;
  ctx.font = nameFont;
  let lines = twoLines(ctx, soulmate.name, nameWidth);
  if (lines.some((line) => ctx.measureText(line).width > nameWidth)) {
    nameFont = `italic 65px ${serif}`;
    lineHeight = 72;
    ctx.font = nameFont;
    lines = twoLines(ctx, soulmate.name, nameWidth);
  }
  const blockHeight = 45 + lines.length * lineHeight + 64 + 32;
  const top = 32 + (416 - blockHeight) / 2;
  text(ctx, "SOULMATE", 852, top + 22, {
    font: `600 38px ${sans}`,
    color: accent,
  });
  lines.forEach((line, i) =>
    text(ctx, line, 852, top + 61 + (i + 0.5) * lineHeight, {
      font: nameFont,
      maxWidth: nameWidth,
    }),
  );
  const scoreY = top + 109 + lines.length * lineHeight;
  heart(ctx, 852, scoreY - 15, 33);
  text(ctx, numbers.format(soulmate.affection), 899, scoreY, {
    font: `500 46px ${mono}`,
    color: accent,
  });
}

function drawHeader(ctx, model, portraits) {
  ctx.fillStyle = accent;
  ctx.fillRect(48, 32, 736, 2);
  ctx.letterSpacing = "1.8px";
  text(ctx, "COLLECTION PROFILE", 48, 72, {
    font: `600 35px ${sans}`,
    color: accent,
  });
  ctx.letterSpacing = "0px";
  box(ctx, 48, 111, 168, 168, 84, "#b18d78");
  drawPortrait(ctx, portraits.get(model.avatarUrl), 52, 115, 160, 160, 80);
  text(ctx, model.displayName, 250, 166, {
    font: `120px ${serif}`,
    maxWidth: 534,
  });
  // TODO: add profile titles feature later
  text(ctx, "Waifu Roller", 254, 257, {
    font: `italic 52px ${serif}`,
    color: accent,
  });

  const rank =
    model.serverRank === null
      ? "Unranked"
      : `#${numbers.format(model.serverRank)}`;
  for (const [x, w, title, value] of [
    [48, 298, "Characters", numbers.format(model.characterCount)],
    [378, 406, "Server Rank", rank],
  ]) {
    ctx.fillStyle = rule;
    ctx.fillRect(x, 308, w, 2);
    text(ctx, title, x, 340, { font: `600 35px ${sans}`, color: muted });
    text(ctx, value, x, 409, { font: `72px ${serif}`, maxWidth: w });
  }
  drawSoulmate(ctx, model.soulmate, portraits);
  ctx.fillStyle = accent;
  ctx.fillRect(48, 478, 1344, 2);
}

function drawRanking(ctx, { x, title, rows, empty, portraits }) {
  text(ctx, title, x, 552, { font: `72px ${serif}` });
  if (!rows.length) {
    box(ctx, x, 616, 656, 424, 5, "#f0e7da", "#dacdbd");
    text(ctx, empty, x + 328, 828, {
      font: `52px ${serif}`,
      align: "center",
      maxWidth: 616,
    });
    return;
  }

  rows.forEach((row, i) => {
    const y = 616 + i * 87;
    const middle = y + 38;
    box(
      ctx,
      x,
      y,
      656,
      76,
      5,
      i ? "#f0e7da" : "#ecdacb",
      i ? "#dacdbd" : "#b88d7d",
    );
    text(ctx, String(i + 1), x + 35, middle, {
      font: `500 39px ${mono}`,
      color: accent,
      align: "center",
    });
    if (portraits) {
      drawPortrait(ctx, portraits.get(row.portraitUrl), x + 68, y, 82, 76);
      text(ctx, row.name, x + 164, middle, {
        font: `54px ${serif}`,
        compact: `45px ${serif}`,
        maxWidth: 283,
      });
      text(ctx, numbers.format(row.affection), x + 601, middle, {
        font: `500 41px ${mono}`,
        align: "right",
        color: i ? ink : accent,
        maxWidth: 138,
      });
      heart(ctx, x + 615, y + 25, 26);
    } else {
      const count = numbers.format(row.count);
      const countFont = `500 ${count.length > 3 ? 34 : 41}px ${mono}`;
      ctx.font = countFont;
      const nameWidth = Math.min(
        475,
        638 - 76 - Math.ceil(ctx.measureText(count).width) - 16,
      );
      text(ctx, row.name, x + 76, middle, {
        font: `41px ${serif}`,
        maxWidth: nameWidth,
      });
      text(ctx, count, x + 638, middle, {
        font: countFont,
        align: "right",
        color: i ? ink : accent,
      });
    }
  });
}

export async function renderProfileCard(model, portraits) {
  registerFonts();
  const canvas = new Canvas(width, height, { gpu: false });
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "middle";
  box(ctx, 0, 0, width, height, 10, paper);
  drawHeader(ctx, model, portraits);
  drawRanking(ctx, {
    x: 48,
    title: "Top characters",
    rows: model.topCharacters,
    empty: "No characters collected yet",
    portraits,
  });
  drawRanking(ctx, {
    x: 736,
    title: "Top franchises",
    rows: model.topFranchises,
    empty: "No franchises yet",
  });
  return canvas.toBuffer("png");
}
