
import { readFileSync, writeFileSync } from 'fs';
import userDailies from "./userDailies.js";
import { getGenshinInfo } from "./getGenshinInfo.js";
import { getHsrInfo } from "./getHsrInfo.js";
import { getZzzInfo } from "./getZzzInfo.js";
import config from "../config.js";
import {yoshiko} from "../index.js";

//err_ms is the error time in milliseconds, which the bot will ping (5 mins +- err_ms)
export default function checkTimeouts(err_s) {

    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const checkTimeout = async () => {
        let dailies = JSON.parse(readFileSync('./data/user_dailies.txt', 'utf-8'));
        const channel = await yoshiko.client.channels.fetch(yoshiko.config.channelId);
        for (let i = 0; i < dailies.length; i++) {
            let ltuid_v2 = dailies[i].ltuid_v2;
            let ltoken_v2 = dailies[i].ltoken_v2;
            let giInfo = await getGenshinInfo(ltoken_v2, ltuid_v2);
            await delay(50);
            let hsrInfo = await getHsrInfo(ltoken_v2, ltuid_v2);
            await delay(50);
            let zzzInfo = await getZzzInfo(ltoken_v2, ltuid_v2);
            if (giInfo === -2 || hsrInfo === -2 || zzzInfo === -2) {
                continue;
            }
            if (giInfo !== -1 && giInfo !== null) {
                dailies[i].gi = giInfo.data.resin_recovery_time;
                //debug
                console.log(`Updated gi for ${dailies[i].id} to ${dailies[i].gi}`);
            }
            if (hsrInfo !== -1 && hsrInfo !== null) {
                dailies[i].hsr = hsrInfo.data.stamina_recover_time;
                 console.log(`Updated hsr for ${dailies[i].id} to ${dailies[i].hsr}`);
            }
            if (zzzInfo !== -1 && zzzInfo !== null) {
                dailies[i].zzz = zzzInfo.data.energy.restore;
                 console.log(`Updated zzz for ${dailies[i].id} to ${dailies[i].zzz}`);
            }
            if (dailies[i].gi !== -1) {
                if (dailies[i].gi <= 300 + err_s && dailies[i].gi >= 300 - err_s) {
                    await channel.send(`<@${dailies[i].id}> Your **Genshin Impact** energy is almost full!`);
                }
            }
            if (dailies[i].hsr !== -1) {
                if (dailies[i].hsr <= 300 + err_s && dailies[i].hsr >= 300 - err_s) {
                    await channel.send(`<@${dailies[i].id}> Your **Honkai Star Rail** energy is almost full!`);
                }
            }
            if (dailies[i].zzz !== -1) {
                if (dailies[i].zzz <= 300 + err_s && dailies[i].zzz >= 300 - err_s) {
                    await channel.send(`<@${dailies[i].id}> Your **Zenless Zone Zero** energy is almost full!`);
                }
            }
        }
        writeFileSync('./data/user_dailies.txt', JSON.stringify(dailies, null, 2));
    }
    setInterval(checkTimeout, err_s * 1000);
}