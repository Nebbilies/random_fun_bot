import { readFileSync, writeFileSync } from "fs";

let config = JSON.parse(
    readFileSync("./data/landmine-config.json", "utf8")
);

export const landmineRuntime = {
    get chance() {
        return config.landmineRate / 100;
    },
    get pity() {
        return config.landminePity;
    },
    reload() {
        config = JSON.parse(
            readFileSync("./data/landmine-config.json", "utf8")
        );
    },
    setRate(newRate) {
        config.landmineRate = newRate;
        writeFileSync(
            "./data/landmine-config.json",
            JSON.stringify(config, null, 2)
        );
    },
    setPity(newPity) {
        config.landminePity = newPity;
        writeFileSync(
            "./data/landmine-config.json",
            JSON.stringify(config, null, 2)
        );
    }
};
