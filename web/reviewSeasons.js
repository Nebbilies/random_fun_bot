import { cancelRollover, getSeasonStatus, previewRollover, queueRollover, saveSeasonSettings } from '../features/seasons/seasonSchedule.js';

const path = '/api/game/seasons';

export async function handleSeasonRequest({db,request,response,url,origin,json,readJsonBody}) {
  const action = url.pathname.slice(path.length+1);
  if (url.pathname !== path && !url.pathname.startsWith(path+'/')) return false;
  try {
    if (request.method === 'GET' && (!action || action === 'preview')) {
      const guildId = url.searchParams.get('guildId');
      if (!/^[1-9]\d{0,19}$/.test(guildId ?? '')) json(response,400,{error:'Enter a valid server ID.'});
      else json(response,200,action ? previewRollover(db,guildId) : getSeasonStatus(db,guildId));
      return true;
    }
    if (request.method !== 'POST' || !['settings','confirm','cancel'].includes(action)) {
      json(response,405,{error:'Method not allowed'});
      return true;
    }
    if (request.headers.origin !== origin) {
      json(response,403,{error:'Invalid origin'});
      return true;
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      json(response,415,{error:'JSON required'});
      return true;
    }
    const body = await readJsonBody(request);
    const guildId = body?.guildId;
    if (typeof guildId !== 'string' || !/^[1-9]\d{0,19}$/.test(guildId)) {
      json(response,400,{error:'Enter a valid server ID.'});
      return true;
    }
    if (action === 'settings') saveSeasonSettings(db,{guildId,channelId:body.channelId,targetDays:body.targetDays,revision:body.revision});
    if (action === 'confirm') queueRollover(db,{guildId,requester:request.portalAccount.username,preview:body.preview});
    if (action === 'cancel') cancelRollover(db,{guildId,revision:body.revision});
    json(response,200,getSeasonStatus(db,guildId));
  } catch (error) {
    json(response,error.code === 'SEASON_STALE' ? 409 : 400,{error:error.message});
  }
  return true;
}
