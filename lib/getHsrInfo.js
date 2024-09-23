import { getGameId } from './getIdArray.js';
import {generateDynamicSecret} from "./generateDynamicSecret.js";
import axios from "axios";


function recognizeServer(uid) {
    const serverMap = {
        "6": "prod_official_usa",
        "7": "prod_official_eur",
        "8": "prod_official_asia",
        "9": "prod_official_cht",
    };

    const server = serverMap[String(uid)[0]];

    if (server) {
        return server;
    } else {
        throw new AccountNotFound(`UID ${uid} isn't associated with any server`);
    }
}

export async function getHsrInfo(ltoken_v2, ltuid_v2) {
    const idArray = await getGameId(ltoken_v2, ltuid_v2);
    if (idArray.has('hsr')) {
        const ds = generateDynamicSecret();
        const id = idArray.get('hsr');
        const server = recognizeServer(id);
        try {
            const res = await axios.get(`https://bbs-api-os.hoyolab.com/game_record/hkrpg/api/note?server=${server}&role_id=${id}`, {
                headers: {
                    "DS": ds,
                    "x-rpc-client_type": "5",
                    "x-rpc-app_version": "2.19.1",
                    "Cookie": `ltoken_v2=${ltoken_v2}; ltuid_v2=${ltuid_v2};`,
                }
            })
            if (res.data.retcode === 10102) {
                return -2; //Data set to private by user
            }
            console.log(res.data);
            return res.data;
        } catch (e) {
            return -1;
        }
    } else {
        return null;
    }
}

