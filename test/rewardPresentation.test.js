import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContainerBuilder,
  ContainerComponent,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";
import { rewardPresentationMatches } from "../lib/rewardPresentation.js";

const json = (value) => JSON.parse(JSON.stringify(value));
function desired() {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      new ContainerBuilder().setAccentColor(123).addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("vault:test:replace")
            .setPlaceholder("Replace")
            .addOptions({
              value: "1",
              label: "Inventory entry",
              description: "3 charges",
            }),
        ),
      ),
    ],
  };
}

test("Discord component wrappers and default fields compare equal without ignoring meaningful controls", () => {
  const payload = desired();
  const raw = json(payload);
  raw.components[0].id = 10;
  raw.components[0].spoiler = false;
  raw.components[0].components[0].id = 11;
  const select = raw.components[0].components[0].components[0];
  Object.assign(select, {
    id: 12,
    disabled: false,
    min_values: 1,
    max_values: 1,
  });
  select.options[0].default = false;
  const message = {
    content: "",
    embeds: [],
    flags: { bitfield: payload.flags },
    components: raw.components.map((data) => new ContainerComponent(data)),
  };
  assert.equal(rewardPresentationMatches(message, payload), true);
  for (const mutate of [
    (s) => {
      s.custom_id = "vault:forged:replace";
    },
    (s) => {
      s.disabled = true;
    },
    (s) => {
      s.options[0].value = "2";
    },
    (s) => {
      s.options[0].label = "Different entry";
    },
    (s) => {
      s.options[0].description = "2 charges";
    },
    (s) => {
      s.options[0].default = true;
    },
    (s) => {
      s.max_values = 2;
    },
    (s) => {
      s.placeholder = "Different";
    },
  ]) {
    const changed = json(raw);
    mutate(changed.components[0].components[0].components[0]);
    assert.equal(rewardPresentationMatches(changed, payload), false);
  }
  assert.equal(
    rewardPresentationMatches({ ...message, content: "stale text" }, payload),
    false,
  );
  assert.equal(
    rewardPresentationMatches(
      { ...message, embeds: [{ title: "stale" }] },
      payload,
    ),
    false,
  );
  assert.equal(
    rewardPresentationMatches({ ...message, flags: 0 }, payload),
    false,
  );
});
