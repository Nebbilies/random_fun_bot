/** Franchise lookup flags are order-independent; individual !im is not modified. */
export function parseFranchiseCommand(command) {
  const match = /^im([aro]+)$/.exec(command);
  if (!match || !match[1].includes("a")) return null;
  return {
    showRank: match[1].includes("r"),
    showOwner: match[1].includes("o"),
  };
}
