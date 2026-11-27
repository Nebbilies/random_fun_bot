import { getGameConfig } from "../lib/gameConfig.js";
import {
  setWeeklyControls,
  weeklyThemes,
  weeklyView,
} from "../features/weeklyEvents/weeklyEvents.js";

export async function handleWeeklyEventsRequest({
  db,
  request,
  response,
  url,
  origin,
  json,
  readJsonBody,
}) {
  if (url.pathname !== "/api/game/weekly-events") return false;
  try {
    let body;
    if (request.method === "POST") {
      if (request.headers.origin !== origin) {
        json(response, 403, { error: "Invalid origin" });
        return true;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        json(response, 415, { error: "JSON required" });
        return true;
      }
      body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Weekly Event settings are required.");
    } else if (request.method !== "GET") {
      json(response, 405, { error: "Method not allowed" });
      return true;
    }
    const guildId = body?.guildId ?? url.searchParams.get("guildId");
    if (typeof guildId !== "string" || !/^[1-9]\d{0,19}$/.test(guildId))
      throw new Error("Enter a valid server ID.");
    if (body) {
      if (
        typeof body.channelId !== "string" ||
        !/^[1-9]\d{0,19}$/.test(body.channelId)
      )
        throw new Error("Enter a valid announcement channel ID.");
      setWeeklyControls(db, {
        guildId,
        channelId: body.channelId,
        enabled: body.enabled,
        nextTheme: body.nextTheme,
      });
    }
    const { contest, controls, errors } = weeklyView(
      db,
      guildId,
      null,
      Date.now(),
      { reconcile: false },
    );
    const config = getGameConfig(db, guildId);
    json(response, 200, {
      guildId,
      controls,
      contest,
      errors,
      themes: weeklyThemes,
      schedule: {
        day: config.weeklyEvents.day,
        minute: config.weeklyEvents.minute,
        offset: config.schedules.timezoneOffsetMinutes,
      },
    });
  } catch (error) {
    json(response, 400, { error: error.message });
  }
  return true;
}
