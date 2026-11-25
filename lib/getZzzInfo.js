import { getGameId } from "./getIdArray.js";
import { generateDynamicSecret } from "./generateDynamicSecret.js";
import axios from "axios";
class AccountNotFound extends Error {
  constructor(message) {
    super(message);
    this.name = "AccountNotFound";
  }
}

function recognizeServer(uid) {
  const serverMap = {
    0: "prod_gf_us",
    3: "prod_gf_jp",
    5: "prod_gf_eu",
    7: "prod_gf_sg",
  };

  const server = serverMap[String(uid)[1]];

  if (server) {
    return server;
  } else {
    throw new AccountNotFound(`UID ${uid} isn't associated with any server`);
  }
}

export async function getZzzInfo(Cookie) {
  const idArray = await getGameId(Cookie);
  if (idArray.has("zzz")) {
    const ds = generateDynamicSecret();
    const id = idArray.get("zzz");
    const server = recognizeServer(id);
    try {
      const res = await axios.get(
        `https://sg-act-nap-api.hoyolab.com/event/game_record_zzz/api/zzz/note?server=${server}&role_id=${id}`,
        {
          headers: {
            DS: ds,
            "x-rpc-client_type": "5",
            "x-rpc-app_version": "2.19.1",
            Cookie: `${Cookie}`,
          },
        },
      );
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
