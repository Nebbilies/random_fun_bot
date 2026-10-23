import { transaction } from './catalogDb.js';
import { hourglassOfHaste } from './items/hourglassOfHaste.js';
import { loveLetter } from './items/loveLetter.js';
import { bagOfHolding } from './items/bagOfHolding.js';
import { fourLeafClover } from './items/fourLeafClover.js';
import { rollingFever } from './items/rollingFever.js';
import { adrenalineRush } from './items/adrenalineRush.js';
import { doubleDate } from './items/doubleDate.js';
import { engagementRing } from './items/engagementRing.js';
import { pinata } from './items/pinata.js';
import { goldenHour } from './items/goldenHour.js';
import { crownOfTheSovereign } from './items/crownOfTheSovereign.js';
import { pickpocketsHook } from './items/pickpocketsHook.js';
import { masterKey } from './items/masterKey.js';
import { aegisOfFidelity } from './items/aegisOfFidelity.js';
import { wishUponAStar } from './items/wishUponAStar.js';
import { franchisePassport } from './items/franchisePassport.js';
import { bloodPact } from './items/bloodPact.js';

export const useHourglassOfHaste = (db, guildId, userId, now) =>
  hourglassOfHaste.execute({ db, guildId, userId, now });

export const useLoveLetter = (db, guildId, userId) =>
  loveLetter.execute({ db, guildId, userId });

export const useBagOfHolding = (db, guildId, userId) =>
  bagOfHolding.execute({ db, guildId, userId });

export const useFourLeafClover = (db, guildId, userId) =>
  fourLeafClover.execute({ db, guildId, userId });

export const useRollingFever = (db, guildId, userId) =>
  rollingFever.execute({ db, guildId, userId });

export const useAdrenalineRush = (db, guildId, userId, now) =>
  adrenalineRush.execute({ db, guildId, userId, now });

export const useDoubleDate = (db, guildId, userId, now) =>
  doubleDate.execute({ db, guildId, userId, now });

export const useEngagementRing = (db, guildId, userId) =>
  engagementRing.execute({ db, guildId, userId });

export const usePinata = (db, guildId, userId) =>
  pinata.execute({ db, guildId, userId });

export const useGoldenHour = (db, guildId, userId, now) =>
  goldenHour.execute({ db, guildId, userId, now });

export const useCrownOfTheSovereign = (db, guildId, userId) =>
  crownOfTheSovereign.execute({ db, guildId, userId });

export const usePickpocketsHook = (db, guildId, attackerId, targetUserId, random, now) =>
  transaction(db, () => pickpocketsHook.execute({ db, guildId, userId: attackerId, args: [targetUserId], random, now }));

export const useMasterKey = (db, guildId, attackerId, targetUserId, characterNameQuery, now) =>
  transaction(db, () => masterKey.execute({ db, guildId, userId: attackerId, args: [targetUserId, characterNameQuery], now }));

export const useAegisOfFidelity = (db, guildId, userId, characterNameQuery) =>
  aegisOfFidelity.execute({ db, guildId, userId, args: [characterNameQuery] });

export const useWishUponAStar = (db, guildId, userId, franchiseQuery, random) =>
  wishUponAStar.execute({ db, guildId, userId, args: [franchiseQuery], random });

export const useFranchisePassport = (db, guildId, userId, franchiseQuery) =>
  franchisePassport.execute({ db, guildId, userId, args: [franchiseQuery] });

export const useBloodPact = (db, guildId, userId, args) =>
  bloodPact.execute({ db, guildId, userId, args });
