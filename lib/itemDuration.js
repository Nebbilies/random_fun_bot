// Pure formatting: callers capture their clock once and subtract the fixed deadline.
export function formatItemLifetime(remainingMs) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "";
  let seconds = Math.max(1, Math.floor(remainingMs / 1000));
  const parts = [];
  const units = /** @type {Array<[string, number]>} */ ([
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ]);
  for (const [unit, size] of units) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(`${count}${unit}`);
    seconds %= size;
    if (parts.length === 2) break;
  }
  return `(${parts.join(" ")})`;
}

export function formatDuration(durationMs) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return "";
  const parts = [];
  let remaining = durationMs;
  const units = /** @type {Array<[string, number]>} */ ([
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1000],
    ["millisecond", 1],
  ]);
  for (const [name, size] of units) {
    const count = Math.floor(remaining / size);
    if (count) parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
    remaining %= size;
  }
  return parts.join(" ");
}
