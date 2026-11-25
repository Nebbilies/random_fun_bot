import { TranslationServiceClient } from "@google-cloud/translate";

const translationClient = new TranslationServiceClient({
  keyFilename: "./service-account.json",
});

const GCP_PROJECT_ID = "dark-park-482517-m0";

const TRANSLATE_LANGS = [
  "fr",
  "de",
  "ja",
  "es",
  "ru",
  "pl",
  "it",
  "zh-CN",
  "ko",
  "ar",
];
export async function translateText(text) {
  const target =
    TRANSLATE_LANGS[Math.floor(Math.random() * TRANSLATE_LANGS.length)];
  if (!text || text.trim() === "") {
    return text;
  }

  try {
    const [response] = await translationClient.translateText({
      parent: `projects/${GCP_PROJECT_ID}/locations/global`,
      contents: [text],
      mimeType: "text/plain",
      targetLanguageCode: target,
    });

    return response.translations[0].translatedText;
  } catch (err) {
    console.error("Translation failed:", err);
    return text;
  }
}
