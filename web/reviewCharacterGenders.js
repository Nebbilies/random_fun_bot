import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { genderCase } from "../lib/characterGenderReviews.js";
import {
  previewCatalogMutation,
  confirmCatalogMutation,
} from "../lib/catalogMutations.js";
const html = readFileSync(
  new URL("./reviewCharacterGenders.html", import.meta.url),
);
const json = (response, status, value) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};
export async function handleGenderReviewRequest({
  db,
  request,
  response,
  url,
  origin,
}) {
  if (request.method === "GET" && url.pathname === "/gender") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(html);
    return true;
  }
  if (!url.pathname.startsWith("/api/gender/")) return false;
  if (!["admin", "moderator"].includes(request.portalAccount?.role)) {
    json(response, 403, { error: "Catalog access required" });
    return true;
  }
  try {
    if (request.method === "GET" && url.pathname === "/api/gender/next") {
      const next = db
        .prepare(
          `SELECT r.character_id FROM character_gender_reports r JOIN characters c ON c.id=r.character_id
        WHERE review_id IS NULL GROUP BY r.character_id ORDER BY MIN(reported_at), MIN(r.id) LIMIT 1`,
        )
        .get();
      json(response, 200, next ? genderCase(db, next.character_id) : null);
    } else if (
      request.method === "GET" &&
      url.pathname === "/api/gender/history"
    ) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error("Invalid offset");
      json(
        response,
        200,
        db
          .prepare(
            `SELECT r.*, i.name_full AS name,
        (SELECT COUNT(*) FROM character_gender_reports p WHERE p.review_id=r.id) AS reportCount
        FROM character_gender_reviews r JOIN character_identities i ON i.id=r.character_id ORDER BY r.id DESC LIMIT 50 OFFSET ?`,
          )
          .all(offset),
      );
    } else if (
      request.method === "GET" &&
      url.pathname === "/api/gender/overrides"
    ) {
      json(
        response,
        200,
        db
          .prepare(
            "SELECT character_id FROM character_gender_overrides o JOIN characters c ON c.id=o.character_id ORDER BY c.rank",
          )
          .all()
          .map((row) => genderCase(db, row.character_id)),
      );
    } else if (
      request.method === "POST" &&
      url.pathname === "/api/gender/resolve"
    ) {
      if (request.headers.origin !== origin) {
        json(response, 403, { error: "Invalid origin" });
        return true;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        json(response, 415, { error: "JSON required" });
        return true;
      }
      let data = "";
      for await (const chunk of request) {
        data += chunk;
        if (data.length > 8192) throw new Error("Request too large");
      }
      const input = JSON.parse(data);
      const attribution = {
        account: request.portalAccount.username,
        role: request.portalAccount.role,
      };
      const preview = previewCatalogMutation(db, {
        ...attribution,
        operation: "gender_review",
        input,
      });
      const result = confirmCatalogMutation(db, {
        ...attribution,
        previewId: preview.previewId,
        payloadHash: preview.payloadHash,
        idempotencyKey: randomUUID(),
      });
      json(response, 200, result);
    } else json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, /stale/i.test(error.message) ? 409 : 400, {
      error: error.message,
    });
  }
  return true;
}
