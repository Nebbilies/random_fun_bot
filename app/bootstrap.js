import {
  Client,
  Events,
  Collection,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { BirthdayStore } from "../lib/birthdays.js";
import { startBirthdayScheduler } from "../lib/birthdayScheduler.js";
import { openCatalog } from "../lib/catalogDb.js";
import { getCatalogCache } from "../lib/catalogCache.js";
import { assertCatalogRuntimeRestartReady } from "../lib/catalogRuntimeRecovery.js";
import { createCharacterImagePicker } from "../lib/characterImages.js";
import {
  recoverRollRuntime,
  recoverForcedEscapes,
  recoverOpenEscapes,
} from "../lib/characterRollRuntime.js";
import { recoverPendingRollDeliveries } from "../lib/rollDelivery.js";
import {
  cancelMysteryRuntime,
  recoverMysteryRuntime,
} from "../lib/mysteryRuntime.js";
import {
  recoverVaultRewards,
  recoverVaultSessions,
} from "../lib/vaultRuntime.js";
import { recoverItemActionRuntime } from "../lib/itemActionRuntime.js";
import { cleanupExpiredItems } from "../lib/itemExpiryCleanup.js";
import { recoverBinocularsUses } from "../lib/binocularsUse.js";
import { recoverSelectedAffectionRewards } from "../lib/affectionRewards.js";
import { runGameRecovery } from "../lib/gameRecovery.js";
import {
  createRecoveryObserver,
  recoveryError,
} from "../lib/recoveryObservation.js";
import { createMessageHandler } from "./events/messageCreate.js";
import { createInteractionHandler } from "./events/interactionCreate.js";
import { createReactionHandler } from "./events/messageReactionAdd.js";
import { createLandmineHandler } from "../features/landmine/landmineMessageHandler.js";
import { startVoicePing } from "../features/voicePing/voicePingRuntime.js";
import { startRecoveryWorker } from "./recoveryWorker.js";
import {
  loadUtilityCommands,
  registerUtilityCommands,
} from "./utilityCommands.js";
import { runSeasonWork } from "../features/seasons/seasonRuntime.js";
import { runWeeklyWork } from "../features/weeklyEvents/weeklyRuntime.js";
import { hasWeeklyEventSchema } from "../lib/weeklyEventSchema.js";
/** @param {any} config @param {any} [options] */
export async function startBot(config, options = {}) {
  const startup = createRecoveryObserver();
  let finishDiscordLogin;
  const recoveryOperations = {
    recoverBinocularsUses,
    recoverItemActionRuntime,
    recoverPendingRollDeliveries,
    recoverForcedEscapes,
    recoverOpenEscapes,
    recoverMysteryRuntime,
    recoverVaultSessions,
    recoverSelectedAffectionRewards,
    recoverVaultRewards,
    cleanupExpiredItems,
  };
  // Create a new client instance
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ];
  const client =
    options.client ??
    new Client({
      intents,
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
  client.cooldowns = new Collection();
  client.catalogDb = startup.runSync("catalog-open", () =>
    (options.openCatalog ?? openCatalog)(),
  );
  // Final-schema startup must not silently cancel paid actions or guess recovery.
  // Run before handlers, timers, recovery writes, or Discord login are enabled.
  startup.runSync("restart-validation", () => {
    if (
      client.catalogDb.prepare("PRAGMA user_version").get().user_version === 12
    ) {
      (options.validateRestart ?? assertCatalogRuntimeRestartReady)(
        client.catalogDb,
      );
    }
  });
  const catalogCache = getCatalogCache(client.catalogDb);
  const yoshiko = {
    client: client,
    config,
    cooldowns: client.cooldowns,
    catalogDb: client.catalogDb,
    catalogCache,
    get catalogSnapshot() {
      return catalogCache.get();
    },
    get characterIndex() {
      return catalogCache.get().characterIndex;
    },
    get franchiseIndex() {
      return catalogCache.get().franchiseIndex;
    },
    imagePicker: createCharacterImagePicker(),
    vaultEnabled: process.env.VAULT_ROLLS_DISABLED !== "1",
  };
  startup.runSync("runtime-detach", () => {
    cancelMysteryRuntime(client.catalogDb);
    recoverRollRuntime(client.catalogDb);
  });
  let gameRuntimeReady = false;
  const isReady = () => gameRuntimeReady;
  client.on(
    Events.MessageReactionAdd,
    createReactionHandler({ yoshiko, isReady }),
  );
  client.once(Events.ClientReady, async () => {
    client.user.setActivity("Se hoat dong khi thay 727");
    console.log("dmLam");
    await prepareGameRuntime({
      yoshiko,
      startup,
      catalogCache,
      recoveryOperations,
      finishDiscordLogin,
      setReady: () => {
        gameRuntimeReady = true;
      },
    });
    startRecoveryWorker({ yoshiko, recoveryOperations });
    startBirthdayScheduler(client, new BirthdayStore());
    await startVoicePing(yoshiko);
  });
  client.on(
    Events.MessageCreate,
    createMessageHandler({
      yoshiko,
      isReady,
      handleLandmine: createLandmineHandler(),
    }),
  );
  await loadUtilityCommands(yoshiko);
  client.on(
    Events.InteractionCreate,
    createInteractionHandler({ yoshiko, isReady }),
  );
  registerUtilityCommands(yoshiko);
  finishDiscordLogin = startup.begin("discord-login");
  client.login(config.token).catch((error) => {
    finishDiscordLogin(error);
    console.error("Discord login failed:", recoveryError(error));
  });
  return yoshiko;
}
/** @param {any} context */
export async function prepareGameRuntime({
  yoshiko,
  startup,
  catalogCache,
  recoveryOperations,
  finishDiscordLogin,
  setReady,
  runRecovery = runGameRecovery,
}) {
  finishDiscordLogin?.();
  await runSeasonWork({
    db: yoshiko.catalogDb,
    client: yoshiko.client,
    prefix: yoshiko.config?.prefix,
  }).catch((error) =>
    console.error("Season startup recovery failed:", recoveryError(error)),
  );
  if (hasWeeklyEventSchema(yoshiko.catalogDb)) {
    await runWeeklyWork({
      db: yoshiko.catalogDb,
      client: yoshiko.client,
    }).catch((error) =>
      console.error(
        "Weekly Event startup recovery failed:",
        recoveryError(error),
      ),
    );
  }
  const stats = await startup.run("post-client-ready", () =>
    runRecovery({
      db: yoshiko.catalogDb,
      client: yoshiko.client,
      imagePicker: yoshiko.imagePicker,
      startup: true,
      observer: startup,
      operations: recoveryOperations,
    }),
  );
  startup.runSync("search-cache", () => {
    catalogCache.get();
    catalogCache.warmRollPools?.();
  });
  setReady();
  console.log("Character game ready.");
  startup.finish(stats);
}
