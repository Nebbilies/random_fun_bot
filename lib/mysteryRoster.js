export function validateMysteryRoster(roster) {
  if (!Array.isArray(roster))
    throw new Error("Mystery roster must be an array");
  const ids = new Set();
  for (const entry of roster) {
    if (typeof entry?.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(entry.id)) {
      throw new Error("Mystery event ID must be stable lower-case snake case");
    }
    if (ids.has(entry.id))
      throw new Error(`Duplicate mystery event ID: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.enabled !== "boolean")
      throw new Error(`Mystery event ${entry.id} needs an enabled flag`);
    if (!Number.isFinite(entry.weight) || entry.weight <= 0) {
      throw new Error(
        `Mystery event ${entry.id} needs a positive finite weight`,
      );
    }
  }
  return roster;
}

export function selectMysteryEvent(roster, availableIds, random = Math.random) {
  validateMysteryRoster(roster);
  if (
    availableIds !== undefined &&
    !Array.isArray(availableIds) &&
    !(availableIds instanceof Set)
  ) {
    throw new Error("Available mystery event IDs must be an array or Set");
  }
  const available = availableIds === undefined ? null : new Set(availableIds);
  const candidates = roster.filter(
    (entry) => entry.enabled && (!available || available.has(entry.id)),
  );
  if (!candidates.length) return null;
  const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
  if (!Number.isFinite(total))
    throw new Error("Mystery event weights exceed the supported range");
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1)
    throw new Error("Invalid random value");
  const target = draw * total;
  let cumulative = 0;
  for (const entry of candidates) {
    cumulative += entry.weight;
    if (target < cumulative) return entry;
  }
  return candidates.at(-1);
}
