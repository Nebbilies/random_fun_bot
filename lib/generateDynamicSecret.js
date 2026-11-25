import crypto from "crypto";

export function generateDynamicSecret(
  salt = "6s25p5ox5y14umn1p61aqyyvbvvl3lrt",
) {
  const t = Math.floor(Date.now() / 1000);
  const r = Array.from({ length: 6 }, () => Math.random().toString(36)[2]).join(
    "",
  );
  const data = `salt=${salt}&t=${t}&r=${r}`;

  // Generate MD5 hash
  const hash = crypto.createHash("md5").update(data).digest("hex");

  return `${t},${r},${hash}`;
}
