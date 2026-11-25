/**
 * Resolves a target user ID and validity from an argument token or Discord message.
 *
 * @param {string | undefined} token - Command argument token (e.g. '<@123>', '123', or undefined)
 * @param {string} defaultId - Fallback user ID (typically message.author.id)
 * @param {any} [message] - Optional Discord message for mention collection lookups
 * @returns {{ targetId: string, isSelf: boolean, valid: boolean }}
 */
export function resolveUserTarget(token, defaultId, message = null) {
  if (!token) {
    return { targetId: defaultId, isSelf: true, valid: true };
  }

  const mention = token.match(/^<@!?(\d+)>$/);
  if (mention) {
    const id = mention[1];
    return { targetId: id, isSelf: id === defaultId, valid: true };
  }

  if (/^\d+$/.test(token)) {
    return { targetId: token, isSelf: token === defaultId, valid: true };
  }

  if (message?.mentions?.users?.size) {
    const mentioned = message.mentions.users.first();
    if (mentioned) {
      return {
        targetId: mentioned.id,
        isSelf: mentioned.id === defaultId,
        valid: true,
      };
    }
  }

  return { targetId: defaultId, isSelf: true, valid: false };
}

/**
 * Resolves the username or display tag for a user ID.
 *
 * @param {any} message - Discord message object
 * @param {string} targetId - The target user ID
 * @param {string | null} [defaultName] - Default fallback name
 * @returns {Promise<string>}
 */
export async function resolveTargetUsername(
  message,
  targetId,
  defaultName = null,
) {
  if (targetId === message?.author?.id) {
    return message.author.username || defaultName || targetId;
  }

  const mentionedUser = message?.mentions?.users?.get(targetId);
  if (mentionedUser?.username) {
    return mentionedUser.username;
  }

  const cachedMember = message?.guild?.members?.cache?.get(targetId);
  if (cachedMember?.user?.username) {
    return cachedMember.user.username;
  }

  if (message?.client?.users?.fetch) {
    try {
      const fetched = await message.client.users.fetch(targetId);
      if (fetched?.username) return fetched.username;
    } catch {
      // Ignore fetch error
    }
  }

  return defaultName || `User ${targetId}`;
}
