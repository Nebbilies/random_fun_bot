# Glass Bridge design

Glass Bridge is an enabled mystery event with weight 1. Players join on the first step by choosing Left or Right and may revise their public choice until the deadline. Later steps list survivors who have not chosen under Unpicked. The safe side is selected uniformly before each step and saved. Wrong or missed choices eliminate a player.

The last survivor wins. When all remaining players fall after at least one successful crossing, select the winner uniformly from those who fell, including players who missed. If nobody crosses the first step, there is no winner. A single participant wins only by crossing the first step.

There is no step limit. Default first-step, later-step, and result durations are 25, 15, and 8 seconds, configurable per server and captured at event start. Each step extends the event deadline. The existing protected mystery claim and consolation rules apply. Binoculars is unavailable and server rolling remains paused throughout.

Display public Left and Right lists, with Unpicked on later steps, using non-pinging mentions. Reveal the safe side and outcomes after each deadline; after the final result show the existing mystery reveal and claim flow.

Choice cards update in place. Results replace the step card and remove its controls. The final result remains visible for the configured result period before the final outcome and existing winner countdown. Oversized participant lists use the existing chunked message fallback without truncating names or pinging players.

Save the winner of an all-fall tiebreak before the result period, so recovery cannot redraw it. Extend the Glass Bridge session deadline atomically with each saved transition, while retaining fixed deadlines for other events. Delayed timers still provide a full result period and a fresh next-step choice window.

Portal settings are supplied by the existing configuration registry under mysteryEvents.glass_bridge; there is no database schema migration. Existing server overrides continue to resolve against the new defaults. Disable the event in the portal to stop new selections.

Author review: the rules preserve one shared prize and the existing claim flow. Persisting the safe side and deadline prevents retries from rerolling a step or expiring a live game.
