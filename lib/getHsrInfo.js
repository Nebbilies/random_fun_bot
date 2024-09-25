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

export async function getHsrInfo(ltoken_v2, ltuid_v2, ltmid_v2) {
    const idArray = await getGameId(ltoken_v2, ltuid_v2);
    if (idArray.has('hsr')) {
        const ds = generateDynamicSecret();
        const id = idArray.get('hsr');
        const server = recognizeServer(id);
        try {
            const res = await axios.get(`https://bbs-api-os.hoyolab.com/game_record/hkrpg/api/note?server=${server}&role_id=${id}`, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                    "Accept": "application/json, text/plain, */*",
                    "Accept-Language": "en-US,en;q=0.5",
                    "Accept-Encoding": "gzip, deflate, br",
                    "DS": ds,
                    "x-rpc-client_type": "5",
                    "x-rpc-app_version": "1.5.0",
                    "x-rpc-language": "en-us",
                    "Origin": "https://act.hoyolab.com/",
                    "Referer": "https://act.hoyolab.com/",
                    "Connection": "keep-alive",
                    "Cookie": `ltoken_v2=${ltoken_v2}; ltuid_v2=${ltuid_v2}; ltmid_v2=${ltmid_v2};`,
                    "Sec-Fetch-Dest": "empty",
                    "Sec-Fetch-Mode": "cors",
                    "Sec-Fetch-Site": "same-site",
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

