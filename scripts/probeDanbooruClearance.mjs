import { chromium } from "playwright";

const origin = "https://danbooru.donmai.us";
const apiUrl = `${origin}/tags.json?limit=1`;
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const firstResponse = await page.goto(apiUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  console.log(
    `First browser API request: HTTP ${firstResponse?.status() ?? "no response"}`,
  );
  const challenged =
    (await firstResponse?.headerValue("cf-mitigated")) === "challenge" ||
    firstResponse?.status() === 403;

  let clearance;
  for (let second = 0; second < (challenged ? 30 : 1); second++) {
    clearance = (await context.cookies(origin)).find(
      (cookie) => cookie.name === "cf_clearance",
    );
    if (clearance) break;
    await page.waitForTimeout(1_000);
  }
  console.log(`Page title: ${await page.title()}`);
  console.log(`Clearance cookie: ${clearance ? "issued" : "not issued"}`);

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const browserResponse = await page.goto(apiUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  console.log(
    `Browser API: HTTP ${browserResponse?.status() ?? "no response"}; ` +
      `content-type=${(await browserResponse?.headerValue("content-type")) ?? "none"}; ` +
      `cf-mitigated=${(await browserResponse?.headerValue("cf-mitigated")) ?? "none"}`,
  );

  const headers = { accept: "application/json", "user-agent": userAgent };
  if (clearance) headers.cookie = `cf_clearance=${clearance.value}`;
  const nodeResponse = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const contentType = nodeResponse.headers.get("content-type") ?? "none";
  console.log(
    `Node API: HTTP ${nodeResponse.status}; content-type=${contentType}; ` +
      `cf-mitigated=${nodeResponse.headers.get("cf-mitigated") ?? "none"}`,
  );

  if (clearance) console.log(`cf_clearance=${clearance.value}`);
  if (!nodeResponse.ok || !contentType.includes("application/json"))
    process.exitCode = 1;
} finally {
  await browser.close();
}
