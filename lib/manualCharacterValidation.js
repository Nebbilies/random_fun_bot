const LIMITS = Object.freeze({ name: 120, alias: 120, aliases: 50, description: 4000, referenceUrl: 2048, portraitUrl: 2048 });
const GENDERS = new Set(['male', 'female', 'nonbinary', 'unknown']);

function text(value, label, max, required = true) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  const result = value.normalize('NFKC').trim();
  if (!result && !required) return null;
  if (!result || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) {
    throw new Error(`Invalid ${label}`);
  }
  return result;
}

function url(value, label, required) {
  const result = text(value, label, 2048, required);
  if (result === null) return null;
  let parsed;
  try { parsed = new URL(result); } catch { throw new Error(`Invalid ${label}`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`Invalid ${label}: use HTTPS without credentials`);
  return parsed.href;
}

/** Validate submitted metadata only; identity, likes and provenance are server-owned. */
export function validateManualCharacter(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid character');
  const name = /** @type {string} */ (text(input.name, 'display name', LIMITS.name));
  if (!Array.isArray(input.aliases ?? []) || (input.aliases?.length ?? 0) > LIMITS.aliases) throw new Error('Invalid aliases');
  const seen = new Set([name.toLocaleLowerCase('en-US')]);
  const aliases = [];
  for (const value of input.aliases ?? []) {
    const alias = /** @type {string} */ (text(value, 'alias', LIMITS.alias));
    const normalized = alias.toLocaleLowerCase('en-US');
    if (!seen.has(normalized)) { aliases.push(alias); seen.add(normalized); }
  }
  if (!GENDERS.has(input.gender)) throw new Error('Select an explicit gender');
  if (!Array.isArray(input.franchiseIds) || !input.franchiseIds.length
    || input.franchiseIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Select at least one valid franchise');
  }
  return {
    name,
    aliases,
    gender: input.gender,
    franchiseIds: [...new Set(input.franchiseIds)],
    portraitUrl: url(input.portraitUrl, 'portrait URL', true),
    referenceUrl: url(input.referenceUrl, 'reference URL', false),
    description: text(input.description, 'description', LIMITS.description, false),
  };
}
