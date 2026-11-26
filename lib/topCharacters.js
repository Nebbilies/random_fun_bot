import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  escapeMarkdown,
  TextDisplayBuilder,
} from "discord.js";
import {
  characterMainFranchises,
  hydrateCharacterMainFranchises,
} from "./characterSeries.js";
import { formatNumber } from "./formatNumber.js";
import { characterListName } from "./characterOwnershipDisplay.js";

/** How many characters the top list covers. */
export const TOP_LIMIT = 1000;
/** How many characters fit on one page of the top list. */
export const TOP_PAGE_SIZE = 15;
/** The heading of the top list. */
export const TOP_TITLE = ":trophy: TOP 1000";

/**
 * The highest ranked characters of the catalog, best rank first.
 * @param {any} db catalog database
 * @param {number} [limit] how many characters the list covers
 * @param {'female'|'male'|null} [gender] eligible gender, including other/unknown
 */
export function topCharacters(db, limit = TOP_LIMIT, gender = null) {
  const rows = db
    .prepare(
      `SELECT id, rank, name_full FROM characters
    WHERE ? IS NULL OR LOWER(TRIM(COALESCE(gender, ''))) NOT IN ('female', 'male')
      OR LOWER(TRIM(gender)) = ?
    ORDER BY rank ASC LIMIT ?`,
    )
    .all(gender, gender, limit);
  hydrateCharacterMainFranchises(db, rows);
  return rows.map((row) => ({
    id: row.id,
    rank: row.rank,
    name: row.name_full || `Character ${row.id}`,
    main_franchise_names: row.main_franchise_names,
  }));
}

/** How many pages the top list has. */
export function topPageCount(rows) {
  return Math.max(1, Math.ceil(rows.length / TOP_PAGE_SIZE));
}

/** The lines of one page of the top list. */
export function topLines(rows, page = 0, showOwner = false) {
  const start = page * TOP_PAGE_SIZE;
  return rows.slice(start, start + TOP_PAGE_SIZE).map((row) => {
    const franchises = characterMainFranchises(row, 120, escapeMarkdown);
    return `**#${formatNumber(row.rank)} - ${characterListName(row.name, row.married)}**${franchises ? ` - ${franchises.text}` : ""}${showOwner && row.ownerId ? ` => <@${row.ownerId}>` : ""}`;
  });
}

/**
 * The Components V2 container that lists one page of the top list.
 * @param {any[]} rows characters, already sorted by rank
 * @param {number} [page]
 * @param {{disabled?: boolean, prevId?: string, nextId?: string, showOwner?: boolean, gender?: 'female'|'male'|null}} [options]
 */
export function topListComponents(rows, page = 0, options = {}) {
  const {
    disabled = false,
    prevId = "top:prev",
    nextId = "top:next",
  } = options;
  const pages = topPageCount(rows);
  const lines = topLines(rows, page, options.showOwner);
  const start = page * TOP_PAGE_SIZE;
  const end = Math.min(start + TOP_PAGE_SIZE, rows.length);
  const range = rows.length
    ? ` • Entries ${formatNumber(start + 1)}–${formatNumber(end)}`
    : "";
  const title = options.gender
    ? `${TOP_TITLE} — ${options.gender === "female" ? "Female" : "Male"} / Other`
    : TOP_TITLE;
  const container = new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${title}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        lines.length
          ? lines.join("\n")
          : options.gender
            ? "No characters match this gender filter."
            : "No characters in the catalog yet.",
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Page ${page + 1} of ${pages}${range}`,
      ),
    );
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(prevId)
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page === 0),
      new ButtonBuilder()
        .setCustomId(nextId)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page >= pages - 1),
    ),
  );
  return [container];
}
