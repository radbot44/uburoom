'use strict';
const { CacheBudget } = require('./cache-budget');
const { randomUUID, createHash } = require('node:crypto');
const { QUALITIES, qualityId } = require('../shared/engine');
const { AV1, PlaybackError, classifyHdr } = require('./av1');
const Tracks = require('./media-tracks');
const Output = require('./plex-output');
const Sources = require('./plex-source');
const {HLSPool}=require('./hls-pool');
const SubtitleResources=require('./subtitle-resources');
const { resilientFetch } = require('./resilience');
const { ConversionPolicy } = require('./transcoding-policy');
const { planDelivery } = require('./delivery-plan');
const { mediaIdentity } = require('../shared/room-protocol');
const { SharedTask, runOperation, currentSignal } = require('./operation');

function parseChapters(item) {
  if (!Array.isArray(item?.Chapter)) return [];
  const durationSec = Number(item.duration || 0) / 1000;
  return item.Chapter.map((ch, idx) => {
    const start = Number(ch.startTimeOffset || 0) / 1000;
    const rawEnd = Number(ch.endTimeOffset || 0) / 1000;
    const end = rawEnd > start ? rawEnd : (durationSec > start ? durationSec : start);
    return {
      id: String(ch.id ?? idx + 1),
      index: Number(ch.index ?? idx + 1),
      title: String(ch.tag || ('Chapter ' + (ch.index ?? idx + 1))).slice(0, 100),
      startTime: Math.max(0, Math.round(start * 1000) / 1000),
      endTime: Math.max(0, Math.round(end * 1000) / 1000)
    };
  }).filter(ch => Number.isFinite(ch.startTime) && ch.startTime >= 0)
    .sort((a, b) => a.startTime - b.startTime);
}

function parseMarkers(item) {
  if (!Array.isArray(item?.Marker)) return [];
  return item.Marker.map((m, idx) => {
    const type = String(m.type || '').toLowerCase();
    const start = Number(m.startTimeOffset || 0) / 1000;
    const end = Number(m.endTimeOffset || 0) / 1000;
    return {
      id: String(m.id ?? idx + 1),
      type,
      startTime: Math.max(0, Math.round(start * 1000) / 1000),
      endTime: Math.max(0, Math.round(end * 1000) / 1000)
    };
  }).filter(m => ['intro', 'credits'].includes(m.type) &&
                 Number.isFinite(m.startTime) &&
                 Number.isFinite(m.endTime) &&
                 m.endTime > m.startTime)
    .sort((a, b) => a.startTime - b.startTime);
}

// No arbitrary upstream URLs: callers select Plex IDs, and only Plex-produced
// media paths on the configured server are eligible for proxying.
class Plex {
  constructor(config, fetcher = fetch) {
    this.rawFetch = fetcher; this.fetch = resilientFetch(fetcher); this.token = config.plexToken; this.av1 = new AV1(this, config);
    this.cacheBudget = new CacheBudget(); this.fileCache = new Map(); this.catalogCache = new Map(); this.artSources = new Map(); this.imageCache = new Map(); this.randomCache = new Map();
    this.scopes = new Map(); this.principal = 'discord-shared'; this.allowedItems = new Map();
    this.partQueues = new Map();
    this.hlsPool=new HLSPool(media=>(media.plexContext||this).stop(media));
    /** @type {Map<string,{context:any,at:number,stoppedAt?:number}>} Plex transcode sessions uburoom started */
    this.sessions=new Map();
    this.conversionPolicy=new ConversionPolicy(config.transcoding,this);
    this.qualityOptions=config.transcoding?.qualities || QUALITIES;
    this.av1.conversionPolicy=this.conversionPolicy;
    if (config.plexUrl) {
      this.base = new URL(config.plexUrl);
      if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/') throw new Error('PLEX_URL must be an HTTP(S) origin');
    }
  }
  get configured() { return !!this.base && !!this.token; }
  scope(token,principal) {
    const key=principal+':'+createHash('sha256').update(token).digest('hex');
    let scoped=this.scopes.get(key);
    if(!scoped){scoped=Object.create(Plex.prototype);Object.assign(scoped,{rawFetch:this.rawFetch,fetch:resilientFetch(this.rawFetch),token,clientId:principal,base:this.base,av1:this.av1,hlsPool:this.hlsPool,sessions:this.sessions,conversionPolicy:this.conversionPolicy,qualityOptions:this.qualityOptions,principal:key,partQueues:this.partQueues,cacheBudget:this.cacheBudget,scopes:new Map(),fileCache:new Map(),catalogCache:new Map(),artSources:new Map(),imageCache:new Map(),randomCache:new Map(),allowedItems:new Map()});this.scopes.set(key,scoped);if(this.scopes.size>64)this.scopes.delete(this.scopes.keys().next().value);}
    return scoped;
  }
  async allows(id) {
    const baseId = mediaIdentity(this.id(id)).ratingKey;
    return this.checkItem('play:' + baseId, '/library/metadata/' + baseId,
      item => String(item.ratingKey) === baseId && ['movie', 'episode'].includes(item.type));
  }
  async visible(id,type) {
    const baseId = String(id).split(':')[0];
    const key=(type==='collection'?'collection:':'item:')+this.id(baseId);
    return this.checkItem(key, (type==='collection'?'/library/collections/':'/library/metadata/')+this.id(baseId),
      item => String(item.ratingKey) === String(baseId));
  }
  invalidateAccess() {
    this.accessGeneration = (this.accessGeneration || 0) + 1;
    this.allowedItems.clear();
    for (const task of this.itemChecks?.values() || []) task.abort();
    this.itemChecks?.clear();
  }
  async checkItem(key, resource, accepts) {
    if (this.allowedItems.get(key) > Date.now()) return true;
    this.itemChecks ||= new Map();
    let task = this.itemChecks.get(key);
    if (!task || task.signal.aborted) {
      if (this.itemChecks.size >= 200) throw Object.assign(new Error('Media access checks are busy'), { status: 503 });
      const generation = this.accessGeneration;
      task = new SharedTask(async signal => {
        const data = await this.json(resource, { signal });
        signal.throwIfAborted();
        if (generation !== this.accessGeneration) return false;
        const allowed = !!data.Metadata?.some(accepts);
        if (allowed) { this.allowedItems.set(key, Date.now() + 3000); if (this.allowedItems.size > 200) this.allowedItems.delete(this.allowedItems.keys().next().value); }
        return allowed;
      }, { timeoutMs: 12000 });
      this.itemChecks.set(key, task);
      task.promise.finally(() => { if (this.itemChecks.get(key) === task) this.itemChecks.delete(key); }).catch(() => {});
    }
    return task.join();
  }
  url(resource) {
    if (!this.configured) throw new Error('Configure plex.url and plex.token in private config.yaml; never share this file');
    const url = new URL(resource, this.base);
    if (url.origin !== this.base.origin || url.username || url.password) throw new Error('Invalid Plex resource');
    url.searchParams.delete('X-Plex-Token'); return url;
  }
  async request(resource, options = {}) {
    const url = this.url(resource);
    const response = await this.fetch(url, { ...options, redirect: 'manual',
      signal: options.signal || (options.streaming ? undefined : AbortSignal.timeout(12000)), headers: {
        Accept: 'application/json', 'X-Plex-Token': this.token, 'X-Plex-Product': 'uburoom',
        'X-Plex-Client-Identifier': url.searchParams.get('X-Plex-Client-Identifier') || url.searchParams.get('session') || this.clientId || 'uburoom-watch',
        'X-Plex-Platform': 'Firefox', ...options.headers
      } });
    if (!response.ok && response.status !== 206) {void response.body?.cancel().catch(()=>{});const error=new Error(`Plex server request failed (HTTP ${response.status}); check server access and playback support`);error.status=response.status;throw error;}
    return response;
  }
  async json(resource, options) { return (await (await this.request(resource, options)).json()).MediaContainer || {}; }
  // Small, short-lived in-process caches. Playback decisions never use these.
  cached(cache, key, limit, create, ttl = 60000) {
    const old = cache.get(key);
    if (old && old.until > Date.now() && (!old.task || old.task.settled || !old.task.signal.aborted)) { this.cacheBudget?.touch(old); return old.task ? old.task.join() : old.value; }
    cache.delete(key);
    while (cache.size >= limit) cache.delete(cache.keys().next().value);
    const task = new SharedTask(create), value = task.promise;
    const entry = { until: Date.now() + ttl, value, task };
    cache.set(key, entry);
    value.then(result => this.cacheBudget?.retain(cache,key,entry,result), () => {});
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    return task.join();
  }
  catalog(resource) { return this.cached(this.catalogCache, resource, 96, () => this.json(resource)); }
  async availability(ids, budget, fresh = false) {
    const rawIds = ids.filter(id => id !== 'demo').map(id => this.id(id));
    const baseToRaw = new Map();
    for (const raw of rawIds) {
      const base = raw.split(':')[0];
      if (!baseToRaw.has(base)) baseToRaw.set(base, []);
      baseToRaw.get(base).push(raw);
    }
    const unique = [...baseToRaw.keys()].sort(), result = new Map();
    for(let start=0;start<unique.length;start+=80) {
      const batch=unique.slice(start,start+80), records=new Map(), missing=[];
      for (const id of batch) {
        const cached=this.fileCache.get(id);
        if (!fresh && cached?.until>Date.now()) records.set(id,cached);
        else missing.push(id);
      }
      if (missing.length) {
        const task=new SharedTask(async()=>{
          if(budget && --budget.requests<0)throw new Error('Plex selection exceeds the supported 200-request expansion limit');
          const data=await this.json('/library/metadata/'+missing.join(',')+'?checkFiles=1');
          return new Map((data.Metadata || []).map(item=>[String(item.ratingKey),item]));
        });
        for (const id of missing) {
          /** @type {{until:number,value?:Promise<boolean>,available?:boolean}} */
          const record={until:Infinity,task};
          record.value=task.promise.then(rows=>{
            record.available=rows.has(id) && Sources.available(rows.get(id));
            record.versions=new Set((rows.get(id)?.Media || []).filter(media=>Sources.available({Media:[media]})).map(media=>String(media.id)));
            record.until=Date.now()+15000; return record.available;
          }).catch(error=>{if(this.fileCache.get(id)===record)this.fileCache.delete(id);throw error;});
          // Callers reach this through task.join(), which skips it when the task
          // fails. Left unobserved, that rejection would end the server process.
          record.value.catch(()=>{});
          records.set(id,record); this.fileCache.delete(id); this.fileCache.set(id,record);
          while(this.fileCache.size>2000)this.fileCache.delete(this.fileCache.keys().next().value);
        }
      }
      const values=await Promise.all(batch.map(async id=>[id,await (records.get(id).task?.join().then(()=>records.get(id).value) || records.get(id).value)]));
      for(const [baseId,value] of values) {
        for (const raw of (baseToRaw.get(baseId) || [])) result.set(raw, value && (!mediaIdentity(raw).mediaId || records.get(baseId).versions?.has(mediaIdentity(raw).mediaId) === true));
      }
    }
    return result;
  }
  cachedAvailability(items) {
    return items.map(item=>{
      const record=this.fileCache.get(item.id) || this.fileCache.get(String(item.id).split(':')[0]);
      return record?.until>Date.now() && typeof record.available==='boolean' ? {...item,available:record.available && (!mediaIdentity(item.id)?.mediaId || record.versions?.has(mediaIdentity(item.id).mediaId)===true)} : item;
    });
  }
  async checkedItems(items,budget,fresh = false) {
    const playable=items.filter(item=>['movie','episode'].includes(item.type));
    const statuses=await this.availability(playable.map(item=>item.id),budget,fresh);
    return items.map(item=>statuses.has(item.id)?{...item,available:statuses.get(item.id)}:item);
  }
  async playableItem(id) {
    const identity = mediaIdentity(this.id(id)), baseId = identity.ratingKey;
    const data=await this.json('/library/metadata/'+this.id(baseId)+'?checkFiles=1'), source=data.Metadata?.[0];
    if(!source || !['movie','episode'].includes(source.type))throw new Error('Select a movie or episode');
    if(!Sources.available(source))throw Sources.unavailableError(source);
    if (identity.mediaId) Sources.select(source, { mediaId: identity.mediaId });
    const items = this.items([source]);
    return { ...(identity.mediaId ? items.find(item => item.id === id) || items[0] : items[0]), id };
  }
  id(value) { const identity = mediaIdentity(String(value || '')); if (!identity) throw new Error('Invalid Plex item'); return identity.id; }
  async allItems(resource, pageSize = 120, maxItems = 20000, budget) {
    const rows = [], seen = new Set(); let start = 0;
    for (;;) {
      if (budget && --budget.requests < 0) throw new Error('Plex selection exceeds the supported 200-request expansion limit');
      const url = new URL(resource,this.base); url.searchParams.set('X-Plex-Container-Start',String(start)); url.searchParams.set('X-Plex-Container-Size',String(pageSize));
      const data = await this.json(url.href), page = data.Metadata || [];
      const total = data.totalSize == null ? null : Number(data.totalSize);
      if (!Array.isArray(page) || total !== null && (!Number.isSafeInteger(total) || total < 0)) throw new Error('Plex returned an invalid catalog page');
      if (rows.length + page.length > maxItems || total > maxItems) throw new Error('Plex selection exceeds the supported 20000-item catalog limit');
      if (budget && (budget.remaining -= page.length) < 0) throw new Error('Plex selection exceeds the supported 20000-item expansion limit');
      let fresh = 0;
      for (const item of page) {
        const key = String(item.ratingKey) + ':' + String(item.type);
        if (!seen.has(key)) { seen.add(key); fresh++; }
      }
      if (page.length && !fresh) throw new Error('Plex catalog pagination did not advance');
      if (!page.length && total !== null && start < total) throw new Error('Plex catalog ended before all items were received');
      rows.push(...page); start += page.length;
      if (!page.length || total !== null && start >= total || total === null && page.length < pageSize) break;
    }
    return this.items(rows);
  }
  async queueItems({ type, id, includeSpecials = false } = {}, budget) {
    id = this.id(id);
    if (typeof includeSpecials !== 'boolean' || !['show','season','library','collection'].includes(type)) throw new Error('Invalid queue scope');
    const load = async (activeBudget = { remaining: 20000, requests: 200 }) => {
      if (type === 'library') {
        const sections = (await this.catalog('/library/sections')).Directory || [];
        if (!sections.some(section => String(section.key) === id && section.type === 'movie')) throw new Error('Choose a movie library');
        return (await this.allItems('/library/sections/' + id + '/all?type=1', 2500, 20000, activeBudget)).filter(item => item.type === 'movie');
      }
      if (type === 'collection') {
        const items = [];
        const children = await this.allItems('/library/collections/' + id + '/children', 2500, 20000, activeBudget);
        const expanded = new Set();
        for (const child of children) {
          if (['movie','episode'].includes(child.type)) items.push(child);
          else if (['show','season'].includes(child.type) && !expanded.has(child.id)) {
            expanded.add(child.id);
            items.push(...await this.queueItems({ type: child.type, id: child.id, includeSpecials }, activeBudget));
          }
          if (items.length > 20000) throw new Error('Plex selection exceeds the supported 20000-item catalog limit');
        }
        return items;
      }
      return (await this.allItems('/library/metadata/' + id + (type === 'show' ? '/allLeaves' : '/children'), 2500, 20000, activeBudget))
        .filter(item => item.type === 'episode')
        .sort((a,b) => Number(a.seasonIndex || 0) - Number(b.seasonIndex || 0) || Number(a.index || 0) - Number(b.index || 0) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    };
    const key = 'queue:' + type + ':' + id + (type === 'collection' ? ':' + includeSpecials : '');
    const items = this.cachedAvailability(budget ? await load(budget) : await this.cached(this.catalogCache, key, 96, () => load()));
    const seen = new Set();
    return items.filter(item => {
      if(item.available===false)return false;
      if (item.type === 'episode' && !includeSpecials && Number(item.seasonIndex) === 0 || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    });
  }
  shuffle(items, seed) {
    return items.map(item => ({item,key:createHash('sha256').update(seed + ':' + item.id).digest('hex')}))
      .sort((a,b) => a.key.localeCompare(b.key) || a.item.id.localeCompare(b.item.id)).map(x => x.item);
  }
  async browse(options = {}) {
    const { section, parent, collection, tab = 'library', q = '', genre = '', year = '', sort, order = 'asc', seed } = options;
    const offset = Number(options.offset || 0), limit = 48;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000000 || !['library','collections'].includes(tab) ||
      typeof q !== 'string' || q.length > 200 || !['asc','desc'].includes(order) || genre && !/^\d{1,20}$/.test(genre) || year && !/^\d{4}$/.test(year)) throw new Error('Invalid library query');
    const sorts = { title:'titleSort', added:'addedAt', year:'year', runtime:'duration' };
    if (sort && !['default','random'].includes(sort) && !Object.hasOwn(sorts, sort)) throw new Error('Invalid library sort');
    if (sort === 'random' && !/^[a-f0-9]{32}$/.test(seed || '')) throw new Error('Invalid shuffle seed');
    if (parent && collection) throw new Error('Choose one library location');
    if (!section && !parent && !collection) {
      const data = await this.catalog('/library/sections');
      const items = (data.Directory || []).filter(x => ['movie','show'].includes(x.type) && /^\d{1,20}$/.test(String(x.key)))
        .map(x => ({ id:String(x.key), title:String(x.title).slice(0,200), type:'library', mediaType:x.type }));
      return { items, total:items.length, offset:0, nextOffset:null };
    }
    if (section) this.id(section);
    const childPath = collection ? `/library/collections/${this.id(collection)}/children` : parent ? `/library/metadata/${this.id(parent)}/children` : undefined;
    // Child/collection endpoints vary in filter support. Filter the complete
    // paged child set ourselves rather than silently search only a first page.
    if (childPath && (q || genre || year || sort && sort !== 'default')) {
      const all = await this.cached(this.catalogCache, 'all:' + childPath, 96, () => this.allItems(childPath));
      const genreName = genre && section ? (await this.filters(section)).genres.find(x => x.id === genre)?.title : undefined;
      // Plex child/list rows can contain only the first two genre tags. Read
      // complete tags in small batches only when a child genre filter needs them.
      const complete = genre ? await this.cached(this.catalogCache,'genres:' + childPath,96,async () => {
        const tags = new Map();
        for (let start = 0; start < all.length; start += 80) {
          const ids = all.slice(start,start + 80).map(x => x.id).join(',');
          const data = await this.json('/library/metadata/' + ids);
          for (const item of this.items(data.Metadata)) tags.set(item.id,item);
        }
        return tags;
      }) : undefined;
      let items = all.filter(x => {
        const tags = complete?.get(x.id) || x;
        return (!q || (x.title + ' ' + (x.edition || '')).toLowerCase().includes(q.toLowerCase())) &&
          (!genre || tags.genreIds.includes(genre) || genreName && tags.genres.includes(genreName)) && (!year || String(x.year) === year);
      });
      if (sort === 'random') {
        const key = childPath + ':' + new URLSearchParams({q,genre,year,seed});
        const matching = items;
        items = await this.cached(this.randomCache,key,8,() => this.shuffle(matching,seed),15 * 60000);
      }
      else if (sort && sort !== 'default') items.sort((a,b) => {
        const comparison = sort === 'title' ? (a.sortTitle || a.title).localeCompare(b.sortTitle || b.title, undefined, {numeric:true,sensitivity:'base'}) :
          (a[{added:'addedAt',year:'year',runtime:'duration'}[sort]] || 0) - (b[{added:'addedAt',year:'year',runtime:'duration'}[sort]] || 0);
        return (order === 'desc' ? -comparison : comparison);
      });
      return { items:this.cachedAvailability(items.slice(offset,offset + limit)), total:items.length, offset, nextOffset:offset + limit < items.length ? offset + limit : null };
    }
    const query = new URLSearchParams({ 'X-Plex-Container-Start':String(offset), 'X-Plex-Container-Size':String(limit) });
    if (q) query.set('title',q);
    if (genre) query.set('genre',genre);
    if (year) query.set('year',year);
    const resource = childPath || `/library/sections/${this.id(section)}/${tab === 'collections' ? 'collections' : 'all'}`;
    if (sort === 'random') {
      // Fetch matching catalog rows once per shuffle. Plex's native random sort
      // changes on each request, which is unsuitable for offset pagination.
      query.delete('X-Plex-Container-Start'); query.delete('X-Plex-Container-Size'); query.set('sort','titleSort:asc');
      const key = resource + '?' + query + ':' + seed;
      const items = await this.cached(this.randomCache,key,8,async () => this.shuffle(await this.allItems(resource + '?' + query,500),seed),15 * 60000);
      return {items:this.cachedAvailability(items.slice(offset,offset + limit)),total:items.length,offset,nextOffset:offset + limit < items.length ? offset + limit : null};
    }
    if (sort && sort !== 'default') query.set('sort',sorts[sort] + ':' + order);
    else if (!childPath) query.set('sort','titleSort:asc');
    const data = await this.catalog(resource + '?' + query), rows = data.Metadata || [];
    const total = data.totalSize == null ? null : Number(data.totalSize), end = offset + rows.length;
    return { items:this.cachedAvailability(this.items(rows)), total:Number.isFinite(total) ? total : null, offset,
      nextOffset:rows.length && (total == null ? rows.length >= limit : end < total) ? end : null };
  }
  async filters(section) {
    this.id(section);
    const values = async field => {
      const data = await this.catalog(`/library/sections/${section}/${field}`);
      return (data.Directory || []).filter(x => /^\d{1,20}$/.test(String(x.key))).map(x => ({ id:String(x.key), title:String(x.title).slice(0,100) }));
    };
    const [genres, years] = await Promise.all([values('genre'),values('year')]);
    return { genres, years:years.sort((a,b) => Number(b.id) - Number(a.id)) };
  }
  async details(id, type) {
    if (type && !['movie','show','season','episode','collection'].includes(type)) throw new Error('Invalid item type');
    const { ratingKey, mediaId: targetMediaId } = mediaIdentity(this.id(id));
    const data = await this.catalog(`/library/${type === 'collection' ? 'collections' : 'metadata'}/${this.id(ratingKey)}`);
    const source = data.Metadata?.[0];
    if (!source) throw new Error('Title unavailable');
    const items = this.cachedAvailability(this.items([source]));
    if (targetMediaId && !source.Media?.some(media => String(media.id) === targetMediaId)) throw new Error('Selected version unavailable');
    const item = targetMediaId ? { ...(items.find(x => x.id === id) || items[0]), id } : items[0];
    if (!item) throw new Error('Title unavailable');
    const tags = name => (source[name] || []).map(x => String(x.tag || '').slice(0,120)).filter(Boolean).slice(0, name === 'Role' ? 8 : 12);
    const ratings = [];
    for (const [field,image,label] of [['rating','ratingImage','Critics'],['audienceRating','audienceRatingImage','Audience']]) {
      const provider = String(source[image] || '').toLowerCase();
      const name = provider.includes('imdb') ? 'IMDb' : provider.includes('rottentomatoes') ? 'Rotten Tomatoes ' + label : provider.includes('themoviedb') ? 'TMDB' : undefined;
      const value = Number(source[field]); if (name && Number.isFinite(value) && value >= 0 && value <= 10) ratings.push({source:name,value});
    }
    const pinnedMedia = targetMediaId ? source.Media?.find(m => String(m.id) === targetMediaId) : undefined;
    const media = pinnedMedia || Sources.inventory(source).find(entry => entry.eligible && Sources.partAvailable(entry.part))?.media || source.Media?.find(m => m.Part?.some(p => Sources.partAvailable(p))) || source.Media?.[0];
    const mediaInfo = media ? [media.videoResolution ? String(media.videoResolution).toUpperCase() + (String(media.videoResolution).match(/^\d+$/) ? 'p' : '') : '',
      media.videoCodec, media.bitrate ? (Number(media.bitrate) / 1000).toFixed(1) + ' Mbps' : '', media.audioCodec,
      media.audioChannels ? media.audioChannels + ' channels' : '', media.container].filter(Boolean).map(x => String(x).slice(0,60)) : [];
    const otherEditions = [];
    if (source.Media && source.Media.length > 1) {
      for (let idx = 0; idx < source.Media.length; idx++) {
        const m = source.Media[idx];
        const mId = String(m.id || idx);
        const compoundId = ratingKey + ':' + mId;
        if (compoundId === item.id) continue;
        const res = m.videoResolution ? (String(m.videoResolution).toUpperCase() + (String(m.videoResolution).match(/^\d+$/) ? 'p' : '')) : '';
        const codec = m.videoCodec ? m.videoCodec.toUpperCase() : '';
        const mediaLabel = [res, codec].filter(Boolean).join(' ') || ('Version ' + (idx + 1));
        const editionLabel = String(source.editionTitle || '').trim() ? (String(source.editionTitle || '').trim() + (idx > 0 ? ' · ' + mediaLabel : '')) : mediaLabel;
        const year = source.year || source.originallyAvailableAt?.slice(0, 4);
        const subtitle = [year, editionLabel].filter(Boolean).join(' · ').slice(0, 200);
        const mInfo = [res, m.videoCodec, m.bitrate ? (Number(m.bitrate) / 1000).toFixed(1) + ' Mbps' : '', m.audioCodec, m.audioChannels ? m.audioChannels + ' channels' : '', m.container].filter(Boolean).map(x => String(x).slice(0, 60));
        otherEditions.push({
          id: compoundId,
          type: source.type || 'movie',
          title: String(source.title).slice(0, 200),
          edition: editionLabel,
          subtitle,
          duration: Number(m.duration || source.duration || 0) / 1000,
          mediaInfo: mInfo
        });
      }
    }
    if (source.librarySectionID && source.type === 'movie') {
      try {
        const query = new URLSearchParams({ title: source.title });
        const sectionCatalog = await this.catalog(`/library/sections/${source.librarySectionID}/all?${query}`);
        const siblings = (sectionCatalog.Metadata || []).filter(s =>
          String(s.ratingKey) !== String(ratingKey) &&
          String(s.title || '').trim().toLowerCase() === String(source.title || '').trim().toLowerCase()
        );
        for (const s of siblings) {
          const sItems = this.items([s]);
          for (const si of sItems) {
            if (otherEditions.some(e => e.id === si.id)) continue;
            const sMedia = s.Media?.[0];
            const sInfo = sMedia ? [sMedia.videoResolution ? String(sMedia.videoResolution).toUpperCase() + (String(sMedia.videoResolution).match(/^\d+$/) ? 'p' : '') : '',
              sMedia.videoCodec, sMedia.bitrate ? (Number(sMedia.bitrate) / 1000).toFixed(1) + ' Mbps' : '', sMedia.audioCodec,
              sMedia.audioChannels ? sMedia.audioChannels + ' channels' : '', sMedia.container].filter(Boolean).map(x => String(x).slice(0, 60)) : [];
            otherEditions.push({
              id: si.id,
              type: s.type || 'movie',
              title: si.title,
              edition: si.edition || 'Standard Edition',
              subtitle: si.subtitle,
              duration: si.duration,
              mediaInfo: sInfo
            });
          }
        }
      } catch {}
    }
    return { ...item, summary:String(source.summary || '').slice(0,5000), directors:tags('Director'), cast:tags('Role'), ratings, mediaInfo, otherEditions };
  }
  async artwork(id, kind = 'poster', type) {
    const baseId = String(id).split(':')[0];
    this.id(baseId); if (!['poster','landscape'].includes(kind)) throw new Error('Invalid artwork');
    if (!this.artSources.has(id) && !this.artSources.has(baseId)) await this.details(id,type);
    const source = this.artSources.get(id) || this.artSources.get(baseId), resource = kind === 'landscape' ? source?.landscape : source?.poster;
    if (!resource) throw new Error('Artwork unavailable');
    return this.cached(this.imageCache, resource + ':' + kind, 96, async () => {
      const query = new URLSearchParams({ width:kind === 'landscape' ? '400' : '300', height:kind === 'landscape' ? '225' : '450', minSize:'1', upscale:'0', url:resource });
      const response = await this.request('/photo/:/transcode?' + query, {headers:{Accept:'image/jpeg,image/png,image/webp'}});
      const type = response.headers.get('content-type')?.split(';')[0];
      if (!['image/jpeg','image/png','image/webp','image/gif'].includes(type) || Number(response.headers.get('content-length')) > 2000000) throw new Error('Artwork unavailable');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 2000000) throw new Error('Artwork unavailable');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks,size);
      return { type, bytes };
    });
  }
  items(items = []) {
    const text = value => String(value || '').slice(0,200);
    const thumb = value => typeof value === 'string' && /^\/library\/(metadata|collections)\/\d{1,20}\/(thumb|art)(\/\d+)?$/.test(value) ? value : undefined;
    return items.filter(x => ['movie', 'show', 'season', 'episode', 'collection'].includes(x.type) && /^\d{1,20}$/.test(String(x.ratingKey))).flatMap(x => {
      const poster = thumb(x.type === 'episode' ? x.grandparentThumb || x.thumb : x.thumb), landscape = thumb(x.thumb || x.art);
      const id = String(x.ratingKey); this.artSources.delete(id);
      this.artSources.set(id, {poster,landscape}); while (this.artSources.size > 1200) this.artSources.delete(this.artSources.keys().next().value);
      const viewOffsetSec = Number(x.viewOffset || 0) > 0 ? Math.round(Number(x.viewOffset) / 1000) : undefined;
      const durSec = Number(x.duration || 0) / 1000;
      const hasValidProgress = viewOffsetSec && viewOffsetSec >= 10 && (!durSec || viewOffsetSec <= durSec * 0.92);
      const baseItem = {
        id: String(x.ratingKey), type: x.type, title: String(x.title).slice(0, 200),
        ...(['movie','episode'].includes(x.type)?{available:Sources.available(x)}:{}),
        subtitle: this.subtitle(x), duration: durSec, year:x.year || Number(x.originallyAvailableAt?.slice(0,4)) || undefined, endYear:Number(x.endYear) || undefined,
        edition:text(x.editionTitle), sortTitle:text(x.titleSort), contentRating:text(x.contentRating), addedAt:Number(x.addedAt || 0),
        genres:(x.Genre || []).map(g => text(g.tag)).filter(Boolean).slice(0,12), genreIds:(x.Genre || []).map(g => String(g.id || '')).filter(Boolean),
        count:Number(x.childCount || 0), episodeCount:Number(x.leafCount || 0), index:x.index, seasonIndex:x.parentIndex,
        showTitle:text(x.grandparentTitle), parentTitle:text(x.parentTitle), parentId:x.parentRatingKey && String(x.parentRatingKey), showId:x.grandparentRatingKey && String(x.grandparentRatingKey),
        hasPoster:!!poster, hasLandscape:!!landscape,
        ...(['movie', 'episode'].includes(x.type) ? {summary:String(x.summary || '').slice(0,500)} : {}),
        ...(hasValidProgress ? { viewOffset: viewOffsetSec } : {})
      };
      if (x.type === 'movie' && Array.isArray(x.Media) && x.Media.length > 1) {
        return x.Media.map((m, idx) => {
          const mId = String(m.id || idx);
          const compoundId = id + ':' + mId;
          this.artSources.set(compoundId, {poster,landscape});
          const res = m.videoResolution ? (String(m.videoResolution).toUpperCase() + (String(m.videoResolution).match(/^\d+$/) ? 'p' : '')) : '';
          const codec = m.videoCodec ? m.videoCodec.toUpperCase() : '';
          const mediaLabel = [res, codec].filter(Boolean).join(' ') || ('Version ' + (idx + 1));
          const editionLabel = text(x.editionTitle) ? (text(x.editionTitle) + (idx > 0 ? ' · ' + mediaLabel : '')) : mediaLabel;
          const year = x.year || x.originallyAvailableAt?.slice(0, 4);
          const sub = [year, editionLabel].filter(Boolean).join(' · ').slice(0, 200);
          return {
            ...baseItem,
            id: compoundId,
            edition: editionLabel,
            subtitle: sub,
            duration: Number(m.duration || x.duration || 0) / 1000,
            available: m.Part ? m.Part.some(p => Sources.partAvailable(p)) : baseItem.available
          };
        });
      }
      return [baseItem];
    });
  }
  subtitle(item) {
    const year = item.year || item.originallyAvailableAt?.slice(0, 4);
    return (item.type === 'episode' ? [item.grandparentTitle, Number.isInteger(item.parentIndex) ? 'Season ' + item.parentIndex : item.parentTitle,
      Number.isInteger(item.index) ? 'Episode ' + item.index : undefined, year] : [year, item.editionTitle])
      .filter(value => value !== undefined && value !== null && value !== '').join(' · ').slice(0, 200);
  }
  async neighbors(item) {
    if (item.type !== 'episode' || !/^\d+$/.test(String(item.grandparentRatingKey || ''))) return {};
    const data = await this.catalog(`/library/metadata/${item.grandparentRatingKey}/allLeaves`);
    const episodes = (data.Metadata || []).filter(x => x.type === 'episode' && /^\d+$/.test(String(x.ratingKey)) && (x.parentIndex == null || Number(x.parentIndex) !== 0))
      .sort((a, b) => (a.parentIndex || 0) - (b.parentIndex || 0) || (a.index || 0) - (b.index || 0));
    const index = episodes.findIndex(x => String(x.ratingKey) === String(item.ratingKey));
    if (index < 0) return {};
    return { previousId: episodes[index - 1] && String(episodes[index - 1].ratingKey), nextId: episodes[index + 1] && String(episodes[index + 1].ratingKey) };
  }
  async nextEpisodeOffer(episodeMediaId) {
    try {
      const data = await this.catalog('/library/metadata/' + mediaIdentity(this.id(episodeMediaId)).ratingKey);
      const source = data.Metadata?.[0];
      if (source?.type !== 'episode' || !source.grandparentRatingKey) return null;
      const leavesData = await this.catalog(`/library/metadata/${source.grandparentRatingKey}/allLeaves`);
      const episodes = (leavesData.Metadata || [])
        .filter(x => x.type === 'episode' && /^\d+$/.test(String(x.ratingKey)) && (x.parentIndex == null || Number(x.parentIndex) !== 0))
        .sort((a, b) => (Number(a.parentIndex) || 0) - (Number(b.parentIndex) || 0) || (Number(a.index) || 0) - (Number(b.index) || 0));
      const index = episodes.findIndex(x => String(x.ratingKey) === String(source.ratingKey));
      if (index < 0 || index + 1 >= episodes.length) return null;
      const candidates = episodes.slice(index + 1, index + 6);
      if (this.availability) await this.availability(candidates.map(c => String(c.ratingKey)));
      let nextRaw;
      for (const candidate of candidates) {
        const id = String(candidate.ratingKey);
        if (await this.allows(id) && Sources.available(candidate)) { nextRaw = candidate; break; }
      }
      if (!nextRaw) return null;
      const item = this.items([nextRaw])[0];
      if (!item) return null;
      return {
        mediaId: item.id,
        showId: String(source.grandparentRatingKey),
        showTitle: item.showTitle || String(source.grandparentTitle || ''),
        title: item.title,
        subtitle: item.subtitle,
        parentTitle: item.parentTitle,
        grandparentTitle: item.showTitle,
        duration: item.duration,
        summary: item.summary || '',
        hasLandscape: item.hasLandscape,
        hasPoster: item.hasPoster
      };
    } catch {
      return null;
    }
  }
  qualities(media) {
    const original = !media?.unavailable && media?.source && Sources.select(media.source,media.sourceSelection).media;
    return this.qualityOptions.filter(q => !q.bitrate || (!original?.bitrate || q.bitrate <= original.bitrate) &&
      (!original?.height || q.height <= Math.max(original.height, (original.width || 0) * 9 / 16)))
      .map(q => q.id === 'direct' && original?.bitrate > 0 ? {...q,label:'Original · '+Math.round(original.bitrate / 1000)+' Mbps'} : q);
  }
  // The one recipe for a Plex HLS session, used to start playback and to ask Plex
  // beforehand whether it would.
  transcodeParams({ ratingKey, selected, original, quality, session, audio, burn, directStream }) {
    const params = new URLSearchParams({ path: `/library/metadata/${ratingKey}`, mediaIndex:String(selected.mediaIndex),partIndex:String(selected.partIndex),
      protocol: 'hls', directPlay: '0', directStream: directStream ? '1' : '0', fastSeek: '1', hasMDE: '1',
      offset: '0', session, subtitles: burn ? 'burn' : 'none', audioBoost: '100',
      'X-Plex-Client-Identifier': session, 'X-Plex-Session-Identifier': session,
      maxVideoBitrate: quality === 'direct' ? String(Math.max(20000, original.bitrate || 0)) : String(this.qualityOptions.find(q => q.id === qualityId(quality))?.bitrate || 4000), videoQuality: '100',
      'X-Plex-Client-Profile-Name': 'Generic',
      'X-Plex-Client-Profile-Extra': 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)' });
    if (audio) params.set('audioStreamID',audio.id);
    params.set('audioChannelCount','2');
    if (burn) { params.set('advancedSubtitles','burn'); params.set('subtitleSize','100'); }
    if (quality !== 'direct') {
      const q = this.qualityOptions.find(q => q.id === qualityId(quality)); params.set('videoResolution', `${q.width}x${q.height}`);
    }
    return params;
  }
  /**
   * Ask Plex whether it would play this item at a quality, without starting a session.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async startDecision(media, quality) {
    const { ratingKey } = mediaIdentity(this.id(media.id)), selected = Sources.select(media.source, media.sourceSelection);
    const params = this.transcodeParams({ ratingKey, selected, original: selected.media, quality, session: randomUUID(), directStream: quality === 'direct' });
    const decision = await (media.plexContext || this).json('/video/:/transcode/universal/decision?' + params);
    const code = Number(decision.generalDecisionCode), playable = !!decision.Metadata?.[0]?.Media?.[0]?.Part?.length;
    if (playable && !(code >= 2000)) return { ok: true };
    return { ok: false, reason: String(decision.transcodeDecisionText || decision.generalDecisionText || 'Plex gave no reason.').slice(0, 300) };
  }
  async prepare(id, quality, compatible = false, source, fallback, choices = {}) {
    quality=qualityId(quality);
    if (!choices.sourceOnly && !this.qualityOptions.some(q=>q.id===quality)) throw new PlaybackError('This quality is not offered by the server.');
    const sameSource=source && (source.principal||'discord-shared')===this.principal;
    const { ratingKey, mediaId: targetMediaId } = mediaIdentity(this.id(id));
    const item = (await this.json(`/library/metadata/${ratingKey}?checkFiles=1`)).Metadata?.[0];
    if (!item || !['movie', 'episode'].includes(item.type)) throw new Error('Select a movie or episode');
    const pinned = targetMediaId ? { mediaId: targetMediaId } : source?.sourceSelection;
    const selected=Sources.select(item,pinned),{media:original,part}=selected;
    const videoStream = part.Stream?.find(x => Number(x.streamType) === 1);
    const hdrInfo = classifyHdr(videoStream || original);
    const sourceBitDepth = Number(videoStream?.bitDepth || original?.bitDepth) || (hdrInfo.hdr ? 10 : 8);
    const media = { title: String(item.title).slice(0, 200), subtitle: this.subtitle(item), duration: item.duration / 1000, quality, kind: 'plex', resources: new Map(), id,
      source:item,sourceSelection:selected.identity,principal:this.principal, plexContext:this, videoCodec: original.videoCodec || videoStream?.codec,
      audioCodec:original.audioCodec || part.Stream?.find(x => x.streamType === 2 && x.selected)?.codec || part.Stream?.find(x => x.streamType === 2)?.codec,
      hdr:hdrInfo.hdr, hdrKind:hdrInfo.kind, hdrLabel:hdrInfo.label, doviProfile:hdrInfo.doviProfile, bitDepth:sourceBitDepth,
      sourceHdr:hdrInfo.hdr, sourceHdrKind:hdrInfo.kind, sourceHdrLabel:hdrInfo.label,
      ...(sameSource ? { previousId: source.previousId, nextId: source.nextId } : await this.neighbors(item)) };
    media.chapters = parseChapters(item);
    media.markers = parseMarkers(item);
    media.tracks = Tracks.catalog(part,{browserSubtitles:choices.browserSubtitles,extractSubtitles:!!this.av1.ffmpeg});
    media.selection = Tracks.select(media.tracks,choices);
    media.sourceStart = this.url(part.key).href; media.partId = String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key)[1]);
    media.sourceKey=JSON.stringify([this.base.origin,id,media.partId,this.url(part.key).pathname,part.size,item.duration,original.id]);
    media.captionVersion = randomUUID(); media.subtitleAbort = new AbortController();
    const audio = media.selection.audio;
    if (audio) media.audioCodec = audio.codec;
    const burn = media.selection.subtitle?.available && media.selection.subtitle.delivery==='burn';
    const effectiveAudioTracks = hdrInfo.hdr && (!audio || audio.ordinal === 0) ? 1 : media.tracks.audio.length;
    const conversion = !choices.sourceOnly && (!fallback || fallback === 'audio') && (burn || compatible || quality !== 'direct' || effectiveAudioTracks > 1);
    const plan = planDelivery({quality,compatible,fallback,burn,audioTracks:effectiveAudioTracks,sourceOnly:choices.sourceOnly,outputs:conversion?await this.usableOutputs(choices.localCodecs):undefined});
    media.deliveryReason = plan.reason;
    if (plan.route !== 'file') { media.hdr = false; media.hdrKind = 'sdr'; media.hdrLabel = 'SDR'; media.doviProfile = null; media.bitDepth = 8; }
    this.av1.logger?.info('Delivery',`"${media.title}" ${quality}: ${plan.route}${plan.codec ? ' '+plan.codec : ''} (${plan.reason}), source ${media.videoCodec}/${media.audioCodec}${fallback ? ', requested '+fallback : ''}`);
    const directPlan = plan.route==='plex-hls' ? await choices.directPlan?.() : undefined;
    const directHls = !!(directPlan || choices.directHls);
    if(directPlan)media.directHls=directPlan;
    if(choices.shareKey&&plan.route==='plex-hls') {
      if(choices.authorized&&!await choices.authorized())throw new PlaybackError('Viewing access or stream selection expired.');
      const key=JSON.stringify([choices.shareKey,media.sourceKey,qualityId(quality),audio?.id,burn?media.selection.subtitle.id:null,directHls,!!compatible]);
      let shared;
      try {shared=await this.hlsPool.acquire(key,authorized=>this.prepare(id,quality,compatible,source,fallback,{...choices,directPlan:undefined,directHls,shareKey:undefined,excludeLease:undefined,authorized}),choices.authorized,choices.excludeLease,choices.shareWaitMs,choices.sharedOnly,directHls);}
      catch(error){media.subtitleAbort.abort();if(error instanceof PlaybackError){const failure=Object.assign(new PlaybackError(error.message),{conversionCapacity:!!error.conversionCapacity,media});throw failure;}throw error;}
      for(const field of['format','transcodeId','start','initialManifest','videoCodec','audioCodec','bitrate','bitrateCeiling','output'])media[field]=shared.media[field];
      media.compatible=compatible;
      media.hlsContext=shared.media.plexContext;
      if(shared.lease)media.hlsLease=shared.lease;
      else media.releaseConversion=shared.media.releaseConversion;
      return media;
    }
    if (plan.route==='file') { media.format='file'; media.start=media.sourceStart; }
    else if (plan.route==='local') {
      const codec=plan.codec;
      try{await this.conversionPolicy.video('uburoom',codec);}catch(error){const failure=new PlaybackError(error.message);failure.media=media;throw failure;}
      const original = { ...media, start:media.sourceStart,audioIndex:audio?.index,audioOrdinal:audio?.ordinal,audioTrack:audio,shareKey:choices.shareKey,burn:burn?media.selection.subtitle:undefined };
      media.format = codec; media.videoCodec = codec; media.audioCodec = 'opus'; media.compatible = true;
      if(!choices.sharedOnly && this.conversionPolicy.settings && this.conversionPolicy.jobs.size>=this.conversionPolicy.settings.maxJobs) {
        try {media.av1Lease=this.av1.acquire(original,quality,true,codec);}
        catch(error) {
          if(!error.conversionCapacity)throw error;
          const release=await this.conversionPolicy.wait({authorized:choices.authorized});release();
        }
      }
      media.av1Lease ||= this.av1.acquire(original, quality, choices.sharedOnly, codec);
    }
    else {
      const prepare = async () => {
      let copyOnly=false;
      try{
        try{await this.conversionPolicy.video('plex');}catch(error){if(error.videoDisabled)copyOnly=true;else throw error;}
        if(choices.sharedOnly)throw Object.assign(new PlaybackError('No matching shared output is available.'),{conversionCapacity:true});
        media.releaseConversion=await this.conversionPolicy.wait({authorized:choices.authorized});
      }
      catch(error){throw error instanceof PlaybackError?error:new PlaybackError(error.message);}
      if (choices.authorized && !await choices.authorized()) throw new PlaybackError('Viewing access or track selection expired.');
      const restoreAudio = await this.selectAudioForTranscode(media,choices);
      let restoreSubtitle;
      try {
      if (burn) restoreSubtitle = await this.selectSubtitleForBurn(media,choices);
      media.format = 'hls'; media.transcodeId = randomUUID();
      this.sessions.set(media.transcodeId,{context:this,at:Date.now()});
      const params = this.transcodeParams({ ratingKey, selected, original, quality, session: media.transcodeId, audio, burn,
        directStream: copyOnly || (!burn && !compatible) });
      const decision = await this.json('/video/:/transcode/universal/decision?' + params);
      if(copyOnly && (burn || !decision.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.Stream?.some(stream=>Number(stream.streamType)===1 && stream.decision==='copy') ||
        decision.Metadata.some(item=>item.Media?.some(output=>output.Part?.some(part=>part.Stream?.some(stream=>Number(stream.streamType)===1&&stream.decision!=='copy')))))) {
        throw new PlaybackError('This media needs video transcoding, which Plex has disabled. Try Original playback or another compatible player.');
      }
      const preset=quality!=='direct' ? this.qualityOptions.find(q=>q.id===qualityId(quality)) : undefined;
      const ceiling={bitrate:Number(params.get('maxVideoBitrate')),width:preset?.width,height:preset?.height};
      const confirmed=Output.confirm(decision,{audio,burn,subtitle:media.selection.subtitle,ceiling});
      Object.assign(media,confirmed,{compatible,bitrateCeiling:ceiling.bitrate,output:confirmed});
      media.start = this.url('/video/:/transcode/universal/start.m3u8?' + params).href;
      if (burn || audio || directHls) {
        if (choices.authorized && !await choices.authorized()) throw new PlaybackError('Viewing access or track selection expired.');
        const response=await this.request(media.start,{headers:{Accept:'application/vnd.apple.mpegurl'}});
        const text=await response.text();
        if (!text.startsWith('#EXTM3U') || text.length>2e6) throw new PlaybackError('Plex could not start the requested audio and subtitle transcode.');
        media.initialManifest=text;
        await this.confirmStarted(media,text);
      }
      } finally { await runOperation(undefined, async () => { try { await restoreSubtitle?.(); } finally { await restoreAudio?.(); } }); }
      };
      try { await this.withPartLock((this.principal || 'global') + ':' + media.partId,prepare); }
      catch(error) {
        await this.stop(media);
        const failure=error instanceof PlaybackError ? error : new PlaybackError('Plex playback could not be prepared. Check server access and transcoding support.');
        failure.media=media; throw failure;
      }
    }
    return media;
  }
  // Plex can accept a session and then refuse to run it, for example when its transcode
  // drive is nearly full. Without this the viewer gets a black screen and no error.
  async confirmStarted(media,manifest) {
    const first=manifest.split(/\r?\n/).map(line=>line.trim()).find(line=>line&&!line.startsWith('#'));
    if(!first?.split('?')[0].endsWith('.m3u8'))return;
    const target=this.url(new URL(first,media.start).href).href,id=media.transcodeId;
    for(let attempt=0;;attempt++) {
      try {
        const response=await this.request(target,{headers:{Accept:'application/vnd.apple.mpegurl','X-Plex-Client-Identifier':id,'X-Plex-Session-Identifier':id}});
        await response.body?.cancel().catch(()=>{});return;
      } catch(error) {
        if(![404,500].includes(error.status))return;
        if(attempt) {
          this.av1.logger?.warn('Plex',`Plex accepted a session for "${media.title}" and then refused it (HTTP ${error.status}). Check Plex's log and its transcode drive's free space.`);
          throw new PlaybackError("Plex couldn't start this video. Try a lower quality.");
        }
        await new Promise(resolve=>setTimeout(resolve,750));
      }
    }
  }
  async withPartLock(id,action) {
    const key = String(id);
    const previous=this.partQueues.get(key) || Promise.resolve();
    const signal = currentSignal();
    const job=previous.catch(()=>{}).then(() => { signal?.throwIfAborted(); return action(); }); this.partQueues.set(key,job);
    job.finally(() => { if(this.partQueues.get(key)===job)this.partQueues.delete(key); }).catch(() => {});
    return job;
  }
  async selectAudioForTranscode(media,choices) {
    const requested=media.selection.audio?.id;
    if(!requested)return;
    // PMS chooses audio from the scoped user's part selection, ignoring the
    // universal audioStreamID hint on some versions. Capture a private session
    // under the part lock, then restore the preference before releasing it.
    const read=async()=>Sources.select((await this.json('/library/metadata/'+mediaIdentity(media.id).ratingKey)).Metadata?.[0] || {},media.sourceSelection).part;
    const selected=(part,confirming=false)=>{
      const message=confirming?'Plex could not confirm its saved audio preference.':'Plex did not identify its current audio selection.';
      if(!part || String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1])!==media.partId || !Array.isArray(part.Stream))throw new PlaybackError(message);
      const audioRows=part.Stream.filter(s=>Number(s.streamType)===2);
      const rows=audioRows.filter(s=>[true,1,'1'].includes(s.selected));
      if(rows.length>1 || rows.length===1 && rows[0].id==null)throw new PlaybackError(message);
      if(rows.length===1)return {id:String(rows[0].id),explicit:true};
      const fallback=audioRows.find(s=>[true,1,'1'].includes(s.default) && s.id!=null) || audioRows.find(s=>s.id!=null);
      if(!fallback)throw new PlaybackError(message);
      return {id:String(fallback.id),explicit:false};
    };
    const part=await read();
    if(!part || String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1])!==media.partId || !part.Stream?.some(s=>Number(s.streamType)===2 && String(s.id)===requested)) throw new PlaybackError('The requested audio no longer belongs to this source.');
    const previous=selected(part);
    const original=previous.id;
    if(original===requested)return;
    const set=id=>this.request('/library/parts/'+media.partId+'?'+new URLSearchParams({audioStreamID:id}),{method:'PUT'});
    const restore=async()=>{
      const current=selected(await read(),true);
      // Respect a selection changed by another Plex app in the meantime.
      if(current.explicit && current.id===requested){
        await set(original);
        const restored=selected(await read(),true);
        if(!restored.explicit || restored.id!==original)throw new PlaybackError('Plex could not restore its saved audio preference.');
      }
    };
    if(choices.authorized && !await choices.authorized())throw new PlaybackError('Viewing access or track selection expired.');
    try {
      await set(requested);
      const confirmed=selected(await read());
      if(!confirmed.explicit || confirmed.id!==requested)throw new PlaybackError('Plex did not select the requested audio.');
    } catch(error) { await restore();throw error; }
    return restore;
  }
  // Configured outputs this viewer can use, in priority order. Without a working
  // hardware encoder, a local codec waits behind Plex rather than loading the CPU.
  async usableOutputs(localCodecs=[]) {
    const configured=this.conversionPolicy.settings?.outputs || ['plex'],usable=[];
    for(const [index,output] of configured.entries()){
      if(output==='plex'){usable.push(output);continue;}
      if(!this.av1.ffmpeg || !localCodecs.includes(output))continue;
      try{
        const encoder=await this.av1.selectEncoder(output);
        if(encoder!=='software' || this.av1.encoder==='software' || !configured.slice(index+1).includes('plex'))usable.push(output);
      }catch{/* An output with no working encoder is skipped. */}
    }
    return usable;
  }
  async selectSubtitleForBurn(media,choices) {
    // PMS uses this user's stored part selection for burn-in. Hold the part
    // lock through decision AND session start so another viewer cannot replace
    // it before this conversion has captured its intended source stream.
    const read=async()=>Sources.select((await this.json('/library/metadata/'+mediaIdentity(media.id).ratingKey)).Metadata?.[0] || {},media.sourceSelection).part;
    const part=await read(), requested=media.selection.subtitle.id;
    if (!part || String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1])!==media.partId || !part.Stream?.some(s=>Number(s.streamType)===3 && String(s.id)===requested)) throw new PlaybackError('The requested subtitle no longer belongs to this source.');
    const selected=part=>{
      if (!part || String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1])!==media.partId || !Array.isArray(part.Stream)) throw new PlaybackError('Plex could not confirm its saved subtitle preference.');
      const rows=part.Stream.filter(s=>Number(s.streamType)===3 && [true,1,'1'].includes(s.selected));
      if (rows.length>1 || rows.length===1 && rows[0].id==null) throw new PlaybackError('Plex could not identify one saved subtitle preference.');
      return rows.length ? String(rows[0].id) : '0';
    };
    const original=selected(part);
    if (original===requested) return;
    const set=id=>this.request('/library/parts/'+media.partId+'?'+new URLSearchParams({subtitleStreamID:id}),{method:'PUT'});
    const restore=async()=>{
      // Respect a newer preference from another Plex app. Selection checks
      // and writes are separate requests; re-read just before restoring.
      if (selected(await read())!==requested) return;
      await set(original);
      if (selected(await read())!==original) throw new PlaybackError('Plex could not restore its saved subtitle preference.');
    };
    if (choices.authorized && !await choices.authorized()) throw new PlaybackError('Viewing access or track selection expired.');
    try {
      await set(requested);
      if (selected(await read())!==requested) throw new PlaybackError('Plex did not select the requested subtitle.');
    } catch(error) { await runOperation(undefined, restore); throw error; }
    return restore;
  }
  stop(media) { return runOperation(undefined, () => this.stopOwned(media)); }
  async stopOwned(media) {
    media?.subtitleAbort?.abort(); media?.subtitleCache?.clear(); if(media)SubtitleResources.clear(media);
    if(media?.hlsLease){await media.hlsLease.release();return;}
    if (media?.av1Lease) this.av1.release(media.av1Lease);
    if (media?.transcodeId) {
      const id = media.transcodeId, headers = { 'X-Plex-Client-Identifier': id, 'X-Plex-Session-Identifier': id };
      const entry = this.sessions.get(id); if (entry) entry.stoppedAt = Date.now();
      await (media.hlsContext||media.plexContext||this).request('/video/:/transcode/universal/stop?' + new URLSearchParams({ session: id, ...headers }), { headers }).catch(() => {});
    }
    media?.releaseConversion?.();if(media)media.releaseConversion=undefined;
  }
  /**
   * Desired state for Plex sessions: every transcode uburoom started and no longer uses
   * is ended, whichever path dropped it. Plex keeps a session's files on its transcode
   * drive until the session ends, so a leak fills the disk.
   * @param {Set<string>} inUse transcode IDs that rooms, viewers or shared streams hold
   */
  async reconcileSessions(inUse, now = Date.now()) {
    const data = await this.json('/transcode/sessions');
    const listed = (data?.TranscodeSession || []).map(session => String(session.key || '').split('/').pop()).filter(Boolean);
    const present = new Set(listed), ended = [];
    for (const id of listed) {
      const entry = this.sessions.get(id);
      // Never touch other apps' sessions or one still being prepared.
      if (!entry || inUse.has(id) || now - entry.at < 120000) continue;
      const headers = { 'X-Plex-Client-Identifier': id, 'X-Plex-Session-Identifier': id };
      await entry.context.request('/video/:/transcode/universal/stop?' + new URLSearchParams({ session: id, ...headers }), { headers }).catch(() => {});
      ended.push({ id, stopped: !!entry.stoppedAt });
      entry.stoppedAt = now;
    }
    for (const [id, entry] of this.sessions) {
      if (!present.has(id) && !inUse.has(id) && (entry.stoppedAt || now - entry.at > 86400000)) this.sessions.delete(id);
    }
    if (ended.length) this.av1.logger?.warn('Plex', `Ended ${ended.length} Plex transcode ${ended.length === 1 ? 'session' : 'sessions'} that uburoom no longer used (${ended.filter(item => item.stopped).length} had already been asked to stop).`);
    return { plexSessions: listed.length, uburoomSessions: listed.filter(id => this.sessions.has(id)).length, ended: ended.length };
  }
  async ping(media) {
    if (!media?.transcodeId) return false;
    const id = media.transcodeId, headers = { 'X-Plex-Client-Identifier': id, 'X-Plex-Session-Identifier': id };
    try { await (media.hlsContext||media.plexContext||this).request('/video/:/transcode/universal/ping?' + new URLSearchParams({ session: id, ...headers }), { headers }); return true; }
    catch { return false; }
  }
  close() {
    for (const scope of [this,...this.scopes.values()]) {
      for (const task of scope.itemChecks?.values() || []) task.abort();
      for (const cache of [scope.fileCache,scope.catalogCache,scope.imageCache,scope.randomCache]) {
        for (const entry of cache.values()) entry.task?.abort();
        cache.clear();
      }
    }
    this.cacheBudget.clear(); this.fileCache.clear(); this.catalogCache.clear(); this.artSources.clear(); this.imageCache.clear(); this.randomCache.clear(); return Promise.all([this.hlsPool.close(),this.av1.close()]); }
}
module.exports = { Plex };
