import { MessageFlags } from 'discord.js';

// Presentation equality is deliberately independent of builder identity and object
// key order. Keep unknown control fields: silently dropping a new Discord control
// field would be less safe than doing an extra edit until it is understood.
function normalize(value, context = '') {
  if (value?.toJSON) value = value.toJSON();
  if (Array.isArray(value)) return value.map(entry => normalize(entry, context));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  const component = context === 'components';
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry == null) continue;
    if (component && key === 'id') continue; // Discord-assigned component ID, not custom_id or emoji ID.
    if (['proxy_url', 'proxy_icon_url', 'height', 'width'].includes(key)
      && ['image', 'thumbnail', 'icon', 'media', 'footer', 'author', 'video'].includes(context)) continue;
    if (context === 'embeds' && key === 'type' && entry === 'rich') continue;
    if (['disabled', 'spoiler', 'default', 'animated', 'inline'].includes(key) && entry === false) continue;
    if (component && ['min_values', 'max_values'].includes(key) && entry === 1) continue;
    result[key] = normalize(entry, key);
  }
  return result;
}

function presentation(value) {
  // payload is only a compatibility fallback for legacy transport adapters. Real
  // Discord Message properties take precedence, including an empty components array.
  const data = value.payload ?? value;
  const flags = value.flags?.bitfield ?? value.flags ?? data.flags?.bitfield ?? data.flags ?? 0;
  return {
    content: value.content ?? data.content ?? '',
    embeds: normalize(value.embeds ?? data.embeds ?? [], 'embeds'),
    components: normalize(value.components ?? data.components ?? [], 'components'),
    flags: Number(flags) & (MessageFlags.IsComponentsV2 | MessageFlags.SuppressEmbeds),
  };
}

/** Compare fetched Discord data with controlled display fields, not delivery metadata. */
export function rewardPresentationMatches(message, payload) {
  return JSON.stringify(presentation(message)) === JSON.stringify(presentation(payload));
}
