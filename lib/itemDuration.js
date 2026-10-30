// Pure formatting: callers capture their clock once and subtract the fixed deadline.
export function formatItemLifetime(remainingMs) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '';
  let seconds = Math.max(1, Math.floor(remainingMs / 1000));
  const parts = [];
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(`${count}${unit}`);
    seconds %= size;
    if (parts.length === 2) break;
  }
  return `(${parts.join(' ')})`;
}
