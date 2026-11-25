/** Parse top's order-independent owner and gender suffixes. */
export function parseTopCommand(command) {
  const match = /^top([owh]*)$/i.exec(command);
  if (
    !match ||
    (match[1].toLowerCase().includes("w") &&
      match[1].toLowerCase().includes("h"))
  )
    return null;
  const suffix = match[1].toLowerCase();
  return {
    showOwner: suffix.includes("o"),
    gender: suffix.includes("w")
      ? "female"
      : suffix.includes("h")
        ? "male"
        : null,
  };
}
