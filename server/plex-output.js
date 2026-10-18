'use strict';
const {PlaybackError}=require('./av1');
const selected=value=>[true,1,'1'].includes(value);

// A request describes desired output; only the decision describes confirmed output.
// maxVideoBitrate limits video, whereas Media.bitrate may include audio/container overhead.
function confirm(decision,{audio,burn,subtitle,ceiling}) {
  const outputs=decision.Metadata?.flatMap(item=>item.Media || []) || [];
  const output=outputs[0],parts=output?.Part || [],videos=parts[0]?.Stream?.filter(s=>Number(s.streamType)===1) || [];
  if(Number(decision.generalDecisionCode)>=2000 || outputs.length!==1 || parts.length!==1 || videos.length!==1 ||
    videos[0].codec!=='h264' || output.videoCodec && output.videoCodec!=='h264') {
    throw new PlaybackError('Plex could not provide H.264 video; check transcoding settings');
  }
  const streams=parts[0].Stream,listedAudio=streams.filter(s=>Number(s.streamType)===2);
  const marked=listedAudio.filter(s=>selected(s.selected));
  const decided=listedAudio.filter(s=>['copy','transcode'].includes(s.decision));
  const chosen=marked.length?marked:decided.length?decided:listedAudio;
  if((audio || output.audioCodec || listedAudio.length) && (chosen.length!==1 || chosen[0].codec!=='aac' ||
    output.audioCodec && output.audioCodec!=='aac' || audio && String(chosen[0].id)!==audio.id)) {
    throw new PlaybackError('Plex did not confirm the requested audio stream and AAC output.');
  }
  if(burn && !streams.some(s=>Number(s.streamType)===3 && String(s.id)===subtitle.id &&
    (s.decision==='burn' || output.subtitleDecision==='burn'))) {
    throw new PlaybackError('Plex did not confirm burning the requested subtitle. Your previous player is unchanged.');
  }
  const result={videoCodec:'h264',audioCodec:chosen.length?'aac':undefined};
  for(const field of ['width','height','bitrate']) {
    const reported=output[field] ?? (field!=='bitrate'?videos[0][field]:undefined);
    if(reported===undefined)continue;
    const value=Number(reported);
    if(!Number.isFinite(value) || value<=0 || field!=='bitrate' && ceiling[field] && value>ceiling[field]) {
      throw new PlaybackError('Plex did not honor the requested output limits. Your previous player is unchanged.');
    }
    if(field!=='bitrate' && output[field]!=null && videos[0][field]!=null && Number(videos[0][field])!==value) {
      throw new PlaybackError('Plex returned contradictory output dimensions.');
    }
    result[field]=value;
  }
  if(videos[0].bitrate!=null) {
    const bitrate=Number(videos[0].bitrate);
    if(!Number.isFinite(bitrate) || bitrate<=0 || ceiling.bitrate && bitrate>ceiling.bitrate)
      throw new PlaybackError('Plex did not honor the requested output limits. Your previous player is unchanged.');
    result.videoBitrate=bitrate;
  }
  return result;
}
module.exports={confirm};
