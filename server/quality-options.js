'use strict';
const {qualityDefinition} = require('../shared/room-protocol');
function alternatives(choices, requested) {
  const target = qualityDefinition(requested);
  const sorted = [...choices].sort((a,b)=>(b.height||Infinity)-(a.height||Infinity)||(b.bitrate||Infinity)-(a.bitrate||Infinity));
  const lower = sorted.filter(q=>q.id!==requested && q.bitrate && (!target?.bitrate || q.height<=target.height && q.bitrate<=target.bitrate));
  return [...lower,...sorted.reverse().filter(q=>q.id!==requested && !lower.includes(q))];
}
module.exports={alternatives};
