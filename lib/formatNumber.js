const formatter = new Intl.NumberFormat("en-US");

/** @param {number | bigint} value */
export function formatNumber(value) {
  return formatter.format(value);
}
