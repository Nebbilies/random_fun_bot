# Local landmine settings

`data/landmine-config.json` is local runtime state and is ignored by Git. Startup creates it if missing, with `landmineRate: 0.036` (percent) and `landminePity: 0`. Existing settings are preserved. Rate and pity commands continue saving to this file.

For the first pull that removes the tracked file, back up your deployment's copy outside the repository, pull the update, then restore it before restarting the bot. Later pulls leave the ignored local file alone.
