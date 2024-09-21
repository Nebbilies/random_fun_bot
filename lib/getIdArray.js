import axios from "axios";
import * as crypto from "crypto";
import { generateDynamicSecret } from "./generateDynamicSecret.js";

const ds = generateDynamicSecret(); // Call this function to get the `ds` value

/*axios.get("https://bbs-api-os.hoyolab.com/game_record/hkrpg/api/note?server=prod_official_asia&role_id=829488974", {
    headers: {
        "accept": "application/json, text/plain, *!/!*",
        "accept-language": "en-US,en;q=0.9",
        "ds": ds, //must have

        "x-rpc-app_version": "1.5.0", // must have
        "x-rpc-client_type": "5", // must have

        "cookie": `ltoken_v2=${ltoken_v2}; ltuid_v2=${ltuid_v2};`,

    }
})
    .then(response => {
        //console.log(response.data);
    })
    .catch(error => {
        console.error(error);
    });*/

export async function getGameId(ltoken_v2, ltuid_v2) {
    let gameUid = new Map();
    try {
        let res = await axios.get(`https://bbs-api-os.hoyolab.com/game_record/card/wapi/getGameRecordCard?uid=${ltuid_v2}`, {
            "headers": {
                "accept": "application/json, text/plain, */*",
                "accept-language": "en-US,en;q=0.9",
                "ds": ds,
                "x-rpc-app_version": "1.5.0",
                "x-rpc-client_type": "5",
                "cookie": `ltoken_v2=${ltoken_v2}; ltuid_v2=${ltuid_v2};`,
                "Referer": "https://act.hoyolab.com/",
                "Referrer-Policy": "strict-origin-when-cross-origin"
            },
            timeout: 5000
        })
        const gameList = res.data.data.list;
        for (let i = 0; i < gameList.length; i++) {
            switch (gameList[i].game_name) {
                case "原神":
                    gameUid.set("gi", gameList[i].game_role_id);
                    break;
                case "崩坏3":
                    gameUid.set("hi3", gameList[i].game_role_id);
                case "崩坏：星穹铁道":
                    gameUid.set("hsr", gameList[i].game_role_id);
                case "绝区零":
                    gameUid.set("zzz", gameList[i].game_role_id);
            }
        }
        return gameUid;
    } catch (error) {
        console.error(error);
    }
}

// [GI, HI3, HSR, ZZZ]


/*
1726834770,z56wTW,2208fcf7a1e4efc9a2598b0392e59396
1726838177,4FcXzp,cf84af632886268f98c8909b6553c409
1726838391,aSiaze,dfc0a1952e584c6dbbd892bf862d21f1
1726838462,wN4EJ3,067efb7078e730aa1af1dbe90cf15275*/
