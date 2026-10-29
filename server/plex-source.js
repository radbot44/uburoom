'use strict';
const {PlaybackError}=require('./av1');
const partId=part=>String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1] || '');
const missing=value=>value===false || value===0 || value==='0';
const partAvailable=part=>!missing(part.exists) && !missing(part.accessible);
function available(item) {
  return !item.Media?.length || item.Media.some(media=>!media.Part?.length || media.Part.every(partAvailable));
}
function unavailableError(item) {
  const title=String(item.title || 'This video').slice(0,200);
  return Object.assign(new PlaybackError(title+' is unavailable.'),{code:'MEDIA_UNAVAILABLE',status:409,mediaId:String(item.ratingKey || ''),title});
}
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
  if(!available(item))throw unavailableError(item);
  const entries=inventory(item);
  const found=pinned?entries.find(({identity})=>identity.mediaId===pinned.mediaId && identity.partId===pinned.partId &&
    identity.partKey===pinned.partKey && identity.edition===pinned.edition && identity.duration===pinned.duration):entries.find(entry=>entry.eligible && partAvailable(entry.part));
  if(found && !partAvailable(found.part))throw unavailableError(item);
  if(!found?.eligible)throw new PlaybackError(pinned?'The selected Plex source changed or is no longer available. Choose the title again.':'Media is not playable as one complete file. Split-file playback is not supported yet.');
  return found;
}
module.exports={inventory,select,available,partAvailable,unavailableError};
