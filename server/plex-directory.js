'use strict';

// plex.tv's server-share roster is XML. Read only the small allowlisted fields;
// never retain email, share tokens, managed profiles or accounts on other servers.
function attributes(source) {
  const result = {};
  for (const match of source.matchAll(/([A-Za-z][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1]] = (match[2] ?? match[3]).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,entity)=>{
      if (entity[0] !== '#') return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity.toLowerCase()];
      const code = entity[1].toLowerCase()==='x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
      return code>0 && code<=0x10ffff ? String.fromCodePoint(code) : '';
    });
  }
  return result;
}
function parseRoster(xml,machine) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml)>4*1024*1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<MediaContainer\b/.test(xml) || !/<\/MediaContainer>\s*$/.test(xml)) throw new Error('Unsupported Plex directory response');
  const rows = [];
  for (const match of xml.matchAll(/<User\b([^>]*)>([\s\S]*?)<\/User>/g)) {
    const user = attributes(match[1]);
    if (!/^\d{1,20}$/.test(user.id || '') || !user.username || user.restricted === '1' || user.restricted === 'true') continue;
    const server = [...match[2].matchAll(/<Server\b([^>]*)\/?\s*>/g)].map(m=>attributes(m[1]))
      .find(s=>s.machineIdentifier===machine && ['0','false'].includes(s.pending) && (Number(s.numLibraries)>0 || ['1','true'].includes(s.allLibraries)));
    if (server) rows.push({subject:user.id,name:user.title || user.username,alias:user.username});
  }
  return rows;
}
async function plexDirectory(auth) {
  const machine = await auth.machine();
  const response = await auth.fetch('https://plex.tv/api/users/',{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'application/xml','X-Plex-Token':auth.config.plexToken,'X-Plex-Product':'uburoom','X-Plex-Client-Identifier':'uburoom-directory'}});
  if (!response.ok) throw new Error('Plex directory unavailable');
  // Bound the response before buffering; no raw provider payload is persisted.
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes>4*1024*1024) throw new Error('Plex directory too large'); chunks.push(chunk); }
  return parseRoster(Buffer.concat(chunks).toString('utf8'),machine);
}
module.exports = { plexDirectory, parseRoster };
