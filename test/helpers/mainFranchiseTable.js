import { MAIN_FRANCHISE_DDL } from "../../lib/catalogFinalSchema.js";

/** Install the main-assignment relation in a synthetic legacy fixture. */
export function ensureMainFranchiseTable(db) {
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE name='character_main_franchises'",
      )
      .get()
  )
    return;
  const id = db
    .prepare("PRAGMA table_info(characters)")
    .all()
    .find((column) => column.name === "id");
  db.exec(
    String(id?.type).toUpperCase() === "INTEGER"
      ? MAIN_FRANCHISE_DDL.replace("character_id TEXT", "character_id INTEGER")
      : MAIN_FRANCHISE_DDL,
  );
}
