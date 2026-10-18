'use strict';
const {PlaybackError}=require('./av1');
const partId=part=>String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1] || '');
function inventory(item) {
  const entries=[];
  for(const [mediaIndex,media] of (item.Media || []).entries()) {
    for(const [partIndex,part] of (media.Part || []).entries()) {
      const identity={mediaId:media.id==null?undefined:String(media.id),partId:partId(part),partKey:part.key,
        edition:String(item.editionTitle || ''),duration:item.duration};
      const eligible=(media.Part.length===1 && /^\/library\/parts\/\d+\//.test(part.key || '') &&
        Number.isFinite(item.duration) && item.duration>0 && ![media.duration,part.duration].some(value=>value!=null &&
          (!Number.isFinite(Number(value)) || Math.abs(Number(value)-item.duration)>1000)));
      entries.push({media,part,mediaIndex,partIndex,identity,eligible});
    }
  }
  return entries;
}
function select(item,pinned) {
  const entries=inventory(item);
  const found=pinned?entries.find(({identity})=>identity.mediaId===pinned.mediaId && identity.partId===pinned.partId &&
    identity.partKey===pinned.partKey && identity.edition===pinned.edition && identity.duration===pinned.duration):entries.find(entry=>entry.eligible);
  if(!found?.eligible)throw new PlaybackError(pinned?'The selected Plex source changed or is no longer available. Choose the title again.':'Media is not playable as one complete file. Split-file playback is not supported yet.');
  return found;
}
module.exports={inventory,select};
