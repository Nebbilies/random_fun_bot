import { readdirSync } from "node:fs";
import { Collection, REST, Routes, Events } from "discord.js";
export async function loadUtilityCommands(yoshiko) {
  yoshiko.commands = new Collection();
  const commandFiles = readdirSync(
    new URL("../commands/utility/", import.meta.url),
  ).filter((file) => file.endsWith(".js"));
  for (const file of commandFiles) {
    const command = await import(
      new URL(`../commands/utility/${file}`, import.meta.url).href
    );
    if ("data" in command && "execute" in command) {
      yoshiko.commands.set(command.data.name, command);
    } else {
      console.error(`Command ${file} is missing data or execute method`);
    }
  }
}
/** @param {any} yoshiko @param {any} [restClient] */
export function registerUtilityCommands(yoshiko, restClient) {
  const config = yoshiko.config;
  // Construct and prepare an instance of the REST module
  const rest = restClient ?? new REST().setToken(config.token);
  // Register utility commands in every server the bot serves.
  const utilityCommandBody = yoshiko.commands.map((command) =>
    command.data.toJSON(),
  );
  async function registerGuild(guildId) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(config.clientId, guildId),
        { body: utilityCommandBody },
      );
      console.log(`Reloaded application (/) commands for guild ${guildId}.`);
    } catch (error) {
      console.error(
        `Could not register application (/) commands for guild ${guildId}:`,
        error,
      );
    }
  }
  yoshiko.client.once(Events.ClientReady, async (readyClient) => {
    await Promise.all([...readyClient.guilds.cache.keys()].map(registerGuild));
  });
  yoshiko.client.on(Events.GuildCreate, (guild) => {
    void registerGuild(guild.id);
  });
}
