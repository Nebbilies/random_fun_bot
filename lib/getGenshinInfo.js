import { getGameId } from './getIdArray.js';
import {generateDynamicSecret} from "./generateDynamicSecret.js";
import axios from "axios";
class AccountNotFound extends Error {
    constructor(message) {
        super(message);
        this.name = "AccountNotFound";
    }
}

function recognizeServer(uid) {
    const serverMap = {
        "1": "cn_gf01",
        "2": "cn_gf01",
        "5": "cn_qd01",
        "6": "os_usa",
        "7": "os_euro",
        "8": "os_asia",
        "9": "os_cht",
    };

    const server = serverMap[String(uid)[0]];

    if (server) {
        return server;
    } else {
        throw new AccountNotFound(`UID ${uid} isn't associated with any server`);
    }
}

export async function getGenshinInfo(Cookie) {
    const idArray = await getGameId(Cookie);
    if (idArray.has('gi')) {
        const ds = generateDynamicSecret();
        const id = idArray.get('gi');
        const server = recognizeServer(id);
        try {
            const res = await axios.get(`https://bbs-api-os.hoyolab.com/game_record/app/genshin/api/dailyNote?server=${server}&role_id=${id}`, {
                headers: {
                    "DS": ds,
                    "x-rpc-client_type": "5",
                    "x-rpc-app_version": "2.19.1",
                    "Cookie": `${Cookie};`,
                }
            })
            if (res.data.retcode === 10102) {
                return -2; //Data set to private by user
            }
            return res.data;
        } catch (e) {
            return -1;
        }
    } else {
        return null;
    }
}

