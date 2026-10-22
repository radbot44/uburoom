'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { QUALITIES, qualityId } = require('../shared/engine');
const { AV1, PlaybackError } = require('./av1');
const Tracks = require('./media-tracks');
const Output = require('./plex-output');
const Sources = require('./plex-source');
const {HLSPool}=require('./hls-pool');
const SubtitleResources=require('./subtitle-resources');
const { resilientFetch } = require('./resilience');
const { ConversionPolicy } = require('./transcoding-policy');
const {localFormat} = require('../web/playback-policy');

// No arbitrary upstream URLs: callers select Plex IDs, and only Plex-produced
// media paths on the configured server are eligible for proxying.
class Plex {
  constructor(config, fetcher = fetch) {
    this.rawFetch = fetcher; this.fetch = resilientFetch(fetcher); this.token = config.plexToken; this.av1 = new AV1(this, config);
    this.fileCache = new Map(); this.catalogCache = new Map(); this.artSources = new Map(); this.imageCache = new Map(); this.randomCache = new Map();
    this.scopes = new Map(); this.principal = 'discord-shared'; this.allowedItems = new Map();
    this.partQueues = new Map();
    this.hlsPool=new HLSPool(media=>(media.plexContext||this).stop(media));
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
    if(!scoped){scoped=Object.create(Plex.prototype);Object.assign(scoped,{rawFetch:this.rawFetch,fetch:resilientFetch(this.rawFetch),token,clientId:principal,base:this.base,av1:this.av1,hlsPool:this.hlsPool,conversionPolicy:this.conversionPolicy,qualityOptions:this.qualityOptions,principal:key,partQueues:this.partQueues,scopes:new Map(),fileCache:new Map(),catalogCache:new Map(),artSources:new Map(),imageCache:new Map(),randomCache:new Map(),allowedItems:new Map()});this.scopes.set(key,scoped);if(this.scopes.size>64)this.scopes.delete(this.scopes.keys().next().value);}
    return scoped;
  }
  async allows(id) {
    if(this.allowedItems.get(id)>Date.now())return true;
    const data=await this.json('/library/metadata/'+this.id(id));
    if(!data.Metadata?.some(item=>String(item.ratingKey)===String(id)&&['movie','episode'].includes(item.type)))return false;
    this.allowedItems.set(id,Date.now()+3000);if(this.allowedItems.size>200)this.allowedItems.delete(this.allowedItems.keys().next().value);return true;
  }
  async visible(id,type) {
    const key=(type==='collection'?'collection:':'item:')+this.id(id);
    if(this.allowedItems.get(key)>Date.now())return true;
    const data=await this.json((type==='collection'?'/library/collections/':'/library/metadata/')+this.id(id));
    if(!data.Metadata?.some(item=>String(item.ratingKey)===String(id)))return false;
    this.allowedItems.set(key,Date.now()+3000);if(this.allowedItems.size>200)this.allowedItems.delete(this.allowedItems.keys().next().value);return true;
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
      signal: options.signal || AbortSignal.timeout(12000), headers: {
        Accept: 'application/json', 'X-Plex-Token': this.token, 'X-Plex-Product': 'uburoom',
        'X-Plex-Client-Identifier': url.searchParams.get('X-Plex-Client-Identifier') || url.searchParams.get('session') || this.clientId || 'uburoom-watch',
        'X-Plex-Platform': 'Firefox', ...options.headers
      } });
    if (!response.ok && response.status !== 206) {const error=new Error(`Plex server request failed (HTTP ${response.status}); check server access and playback support`);error.status=response.status;throw error;}
    return response;
  }
  async json(resource, options) { return (await (await this.request(resource, options)).json()).MediaContainer || {}; }
  // Small, short-lived in-process caches. Playback decisions never use these.
  cached(cache, key, limit, create, ttl = 60000) {
    const old = cache.get(key);
    if (old && old.until > Date.now()) return old.value;
    cache.delete(key);
    while (cache.size >= limit) cache.delete(cache.keys().next().value);
    const value = Promise.resolve().then(create);
    cache.set(key, { until: Date.now() + ttl, value });
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    return value;
  }
  catalog(resource) { return this.cached(this.catalogCache, resource, 96, () => this.json(resource)); }
  async availability(ids, budget, fresh = false) {
    const unique=[...new Set(ids.filter(id=>id!=='demo').map(id=>this.id(id)))].sort(), result=new Map();
    for(let start=0;start<unique.length;start+=80) {
      const batch=unique.slice(start,start+80), records=new Map(), missing=[];
      for (const id of batch) {
        const cached=this.fileCache.get(id);
        if (!fresh && cached?.until>Date.now()) records.set(id,cached);
        else missing.push(id);
      }
      if (missing.length) {
        const request=Promise.resolve().then(async()=>{
          if(budget && --budget.requests<0)throw new Error('Plex selection exceeds the supported 200-request expansion limit');
          const data=await this.json('/library/metadata/'+missing.join(',')+'?checkFiles=1');
          return new Map((data.Metadata || []).map(item=>[String(item.ratingKey),item]));
        });
        for (const id of missing) {
          /** @type {{until:number,value?:Promise<boolean>,available?:boolean}} */
          const record={until:Infinity};
          record.value=request.then(rows=>{
            record.available=rows.has(id) && Sources.available(rows.get(id));
            record.until=Date.now()+15000; return record.available;
          }).catch(error=>{if(this.fileCache.get(id)===record)this.fileCache.delete(id);throw error;});
          records.set(id,record); this.fileCache.delete(id); this.fileCache.set(id,record);
          while(this.fileCache.size>2000)this.fileCache.delete(this.fileCache.keys().next().value);
        }
      }
      const values=await Promise.all(batch.map(async id=>[id,await records.get(id).value]));
      for(const [id,value] of values)result.set(id,value);
    }
    return result;
  }
  cachedAvailability(items) {
    return items.map(item=>{
      const record=this.fileCache.get(item.id);
      return record?.until>Date.now() && typeof record.available==='boolean' ? {...item,available:record.available} : item;
    });
  }
  async checkedItems(items,budget,fresh = false) {
    const playable=items.filter(item=>['movie','episode'].includes(item.type));
    const statuses=await this.availability(playable.map(item=>item.id),budget,fresh);
    return items.map(item=>statuses.has(item.id)?{...item,available:statuses.get(item.id)}:item);
  }
  async playableItem(id) {
    const data=await this.json('/library/metadata/'+this.id(id)+'?checkFiles=1'), source=data.Metadata?.[0];
    if(!source || !['movie','episode'].includes(source.type))throw new Error('Select a movie or episode');
    if(!Sources.available(source))throw Sources.unavailableError(source);
    return this.items([source])[0];
  }
  id(value) { if (!/^\d{1,20}$/.test(String(value || ''))) throw new Error('Invalid Plex item'); return String(value); }
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
  async queueItems({ type, id, includeSpecials = false } = {}, budget = { remaining: 20000, requests: 200 }) {
    id = this.id(id);
    if (typeof includeSpecials !== 'boolean' || !['show','season','library','collection'].includes(type)) throw new Error('Invalid queue scope');
    let items;
    if (type === 'library') {
      const sections = (await this.json('/library/sections')).Directory || [];
      if (!sections.some(section => String(section.key) === id && section.type === 'movie')) throw new Error('Choose a movie library');
      items = (await this.allItems('/library/sections/' + id + '/all?type=1', 120, 20000, budget)).filter(item => item.type === 'movie');
    } else if (type === 'collection') {
      items = [];
      const children = await this.allItems('/library/collections/' + id + '/children', 120, 20000, budget);
      const expanded = new Set();
      for (const child of children) {
        if (['movie','episode'].includes(child.type)) items.push(child);
        else if (['show','season'].includes(child.type) && !expanded.has(child.id)) {
          expanded.add(child.id);
          items.push(...await this.queueItems({ type: child.type, id: child.id, includeSpecials }, budget));
        }
        if (items.length > 20000) throw new Error('Plex selection exceeds the supported 20000-item catalog limit');
      }
    } else {
      items = (await this.allItems('/library/metadata/' + id + (type === 'show' ? '/allLeaves' : '/children'), 120, 20000, budget))
        .filter(item => item.type === 'episode')
        .sort((a,b) => Number(a.seasonIndex || 0) - Number(b.seasonIndex || 0) || Number(a.index || 0) - Number(b.index || 0) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    }
    const seen = new Set();
    items=await this.checkedItems(items,budget,true);
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
    const data = await this.catalog(`/library/${type === 'collection' ? 'collections' : 'metadata'}/${this.id(id)}`), item = this.cachedAvailability(this.items(data.Metadata))[0];
    if (!item) throw new Error('Title unavailable');
    const source = data.Metadata[0], tags = name => (source[name] || []).map(x => String(x.tag || '').slice(0,120)).filter(Boolean).slice(0, name === 'Role' ? 8 : 12);
    const ratings = [];
    for (const [field,image,label] of [['rating','ratingImage','Critics'],['audienceRating','audienceRatingImage','Audience']]) {
      const provider = String(source[image] || '').toLowerCase();
      const name = provider.includes('imdb') ? 'IMDb' : provider.includes('rottentomatoes') ? 'Rotten Tomatoes ' + label : provider.includes('themoviedb') ? 'TMDB' : undefined;
      const value = Number(source[field]); if (name && Number.isFinite(value) && value >= 0 && value <= 10) ratings.push({source:name,value});
    }
    const media = source.Media?.[0];
    const mediaInfo = media ? [media.videoResolution ? String(media.videoResolution).toUpperCase() + (String(media.videoResolution).match(/^\d+$/) ? 'p' : '') : '',
      media.videoCodec, media.bitrate ? (Number(media.bitrate) / 1000).toFixed(1) + ' Mbps' : '', media.audioCodec,
      media.audioChannels ? media.audioChannels + ' channels' : '', media.container].filter(Boolean).map(x => String(x).slice(0,60)) : [];
    return { ...item, summary:String(source.summary || '').slice(0,5000), directors:tags('Director'), cast:tags('Role'), ratings, mediaInfo };
  }
  async artwork(id, kind = 'poster', type) {
    this.id(id); if (!['poster','landscape'].includes(kind)) throw new Error('Invalid artwork');
    if (!this.artSources.has(id)) await this.details(id,type);
    const source = this.artSources.get(id), resource = kind === 'landscape' ? source?.landscape : source?.poster;
    if (!resource) throw new Error('Artwork unavailable');
    return this.cached(this.imageCache, resource + ':' + kind, 96, async () => {
      const query = new URLSearchParams({ width:kind === 'landscape' ? '400' : '300', height:kind === 'landscape' ? '225' : '450', minSize:'1', upscale:'0', url:resource });
      const response = await this.request('/photo/:/transcode?' + query, {headers:{Accept:'image/jpeg,image/png,image/webp'}});
      const type = response.headers.get('content-type')?.split(';')[0];
      if (!['image/jpeg','image/png','image/webp','image/gif'].includes(type) || Number(response.headers.get('content-length')) > 2000000) throw new Error('Artwork unavailable');
      const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 2000000) throw new Error('Artwork unavailable');
      return { type, bytes };
    });
  }
  items(items = []) {
    const text = value => String(value || '').slice(0,200);
    const thumb = value => typeof value === 'string' && /^\/library\/(metadata|collections)\/\d{1,20}\/(thumb|art)(\/\d+)?$/.test(value) ? value : undefined;
    return items.filter(x => ['movie', 'show', 'season', 'episode', 'collection'].includes(x.type) && /^\d{1,20}$/.test(String(x.ratingKey))).map(x => {
      const poster = thumb(x.type === 'episode' ? x.grandparentThumb || x.thumb : x.thumb), landscape = thumb(x.thumb || x.art);
      const id = String(x.ratingKey); this.artSources.delete(id);
      this.artSources.set(id, {poster,landscape}); while (this.artSources.size > 1200) this.artSources.delete(this.artSources.keys().next().value);
      return {
      id: String(x.ratingKey), type: x.type, title: String(x.title).slice(0, 200),
      ...(['movie','episode'].includes(x.type)?{available:Sources.available(x)}:{}),
      subtitle: this.subtitle(x), duration: Number(x.duration || 0) / 1000, year:x.year || Number(x.originallyAvailableAt?.slice(0,4)) || undefined, endYear:Number(x.endYear) || undefined,
      edition:text(x.editionTitle), sortTitle:text(x.titleSort), contentRating:text(x.contentRating), addedAt:Number(x.addedAt || 0),
      genres:(x.Genre || []).map(g => text(g.tag)).filter(Boolean).slice(0,12), genreIds:(x.Genre || []).map(g => String(g.id || '')).filter(Boolean),
      count:Number(x.childCount || 0), episodeCount:Number(x.leafCount || 0), index:x.index, seasonIndex:x.parentIndex,
      showTitle:text(x.grandparentTitle), parentTitle:text(x.parentTitle), parentId:x.parentRatingKey && String(x.parentRatingKey), showId:x.grandparentRatingKey && String(x.grandparentRatingKey),
      hasPoster:!!poster, hasLandscape:!!landscape,
      ...(x.type === 'episode' ? {summary:String(x.summary || '').slice(0,500)} : {})
    }; });
  }
  subtitle(item) {
    const year = item.year || item.originallyAvailableAt?.slice(0, 4);
    return (item.type === 'episode' ? [item.grandparentTitle, Number.isInteger(item.parentIndex) ? 'Season ' + item.parentIndex : item.parentTitle,
      Number.isInteger(item.index) ? 'Episode ' + item.index : undefined, year] : [year, item.editionTitle])
      .filter(value => value !== undefined && value !== null && value !== '').join(' · ').slice(0, 200);
  }
  async neighbors(item) {
    if (item.type !== 'episode' || !/^\d+$/.test(String(item.grandparentRatingKey || ''))) return {};
    const data = await this.json(`/library/metadata/${item.grandparentRatingKey}/allLeaves`);
    const episodes = (data.Metadata || []).filter(x => x.type === 'episode' && /^\d+$/.test(String(x.ratingKey)))
      .sort((a, b) => (a.parentIndex || 0) - (b.parentIndex || 0) || (a.index || 0) - (b.index || 0));
    const index = episodes.findIndex(x => String(x.ratingKey) === String(item.ratingKey));
    if (index < 0) return {};
    return { previousId: episodes[index - 1] && String(episodes[index - 1].ratingKey), nextId: episodes[index + 1] && String(episodes[index + 1].ratingKey) };
  }
  qualities(media) {
    const original = !media?.unavailable && media?.source && Sources.select(media.source,media.sourceSelection).media;
    return this.qualityOptions.filter(q => !q.bitrate || (!original?.bitrate || q.bitrate <= original.bitrate) &&
      (!original?.height || q.height <= Math.max(original.height, (original.width || 0) * 9 / 16)));
  }
  async prepare(id, quality, compatible = false, source, fallback, choices = {}) {
    quality=qualityId(quality);
    if (!choices.sourceOnly && !this.qualityOptions.some(q=>q.id===quality)) throw new PlaybackError('This quality is not offered by the server.');
    const sameSource=source && (source.principal||'discord-shared')===this.principal;
    const item = (await this.json(`/library/metadata/${id}?checkFiles=1`)).Metadata?.[0];
    if (!item || !['movie', 'episode'].includes(item.type)) throw new Error('Select a movie or episode');
    const selected=Sources.select(item,source?.sourceSelection),{media:original,part}=selected;
    const media = { title: String(item.title).slice(0, 200), subtitle: this.subtitle(item), duration: item.duration / 1000, quality, kind: 'plex', resources: new Map(), id,
      source:item,sourceSelection:selected.identity,principal:this.principal, plexContext:this, videoCodec: original.videoCodec || part.Stream?.find(x => x.streamType === 1)?.codec,
      audioCodec:original.audioCodec || part.Stream?.find(x => x.streamType === 2 && x.selected)?.codec || part.Stream?.find(x => x.streamType === 2)?.codec,
      ...(sameSource ? { previousId: source.previousId, nextId: source.nextId } : await this.neighbors(item)) };
    media.tracks = Tracks.catalog(part,{browserSubtitles:choices.browserSubtitles,extractSubtitles:!!this.av1.ffmpeg});
    media.selection = Tracks.select(media.tracks,choices);
    media.sourceStart = this.url(part.key).href; media.partId = String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key)[1]);
    media.sourceKey=JSON.stringify([this.base.origin,id,media.partId,this.url(part.key).pathname,part.size,item.duration,original.id]);
    media.captionVersion = randomUUID(); media.subtitleAbort = new AbortController();
    const audio = media.selection.audio;
    if (audio) media.audioCodec = audio.codec;
    const burn = media.selection.subtitle?.available && media.selection.subtitle.delivery==='burn';
    const directPlan = !choices.sourceOnly && !localFormat(fallback) && !(quality==='direct'&&!compatible&&!burn&&media.tracks.audio.length<=1)
      ? await choices.directPlan?.() : undefined;
    const directHls = !!(directPlan || choices.directHls);
    if(directPlan)media.directHls=directPlan;
    if(choices.shareKey&&!choices.sourceOnly&&!localFormat(fallback)&&!(quality==='direct'&&!compatible&&!burn&&media.tracks.audio.length<=1)) {
      if(choices.authorized&&!await choices.authorized())throw new PlaybackError('Viewing access or stream selection expired.');
      const key=JSON.stringify([choices.shareKey,media.sourceKey,qualityId(quality),audio?.id,burn?media.selection.subtitle.id:null,directHls]);
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
    if (choices.sourceOnly) { media.format='file'; media.start=media.sourceStart; }
    else if (localFormat(fallback)) {
      try{await this.conversionPolicy.video('uburoom',fallback);}catch(error){const failure=new PlaybackError(error.message);failure.media=media;throw failure;}
      if (burn) throw new PlaybackError('These subtitles require Plex video transcoding. This local WebM conversion cannot preserve them; try a browser that can play the Plex stream.');
      const original = { ...media, start:media.sourceStart,audioIndex:audio?.index,audioOrdinal:audio?.ordinal,shareKey:choices.shareKey };
      media.format = fallback; media.videoCodec = fallback; media.audioCodec = 'opus'; media.compatible = true;
      if(!choices.sharedOnly && this.conversionPolicy.settings && this.conversionPolicy.jobs.size>=this.conversionPolicy.settings.maxJobs) {
        try {media.av1Lease=this.av1.acquire(original,quality,true,fallback);}
        catch(error) {
          if(!error.conversionCapacity)throw error;
          const release=await this.conversionPolicy.wait({authorized:choices.authorized});release();
        }
      }
      media.av1Lease ||= this.av1.acquire(original, quality, choices.sharedOnly, fallback);
    }
    else if (quality === 'direct' && !compatible && !burn && media.tracks.audio.length<=1) { media.format = 'file'; media.start = media.sourceStart; }
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
      const params = new URLSearchParams({ path: `/library/metadata/${id}`, mediaIndex:String(selected.mediaIndex),partIndex:String(selected.partIndex),
        protocol: 'hls', directPlay: '0', directStream: copyOnly?'1':'0', fastSeek: '1', hasMDE: '1',
        offset: '0', session: media.transcodeId, subtitles: burn ? 'burn' : 'none', audioBoost: '100',
        'X-Plex-Client-Identifier': media.transcodeId, 'X-Plex-Session-Identifier': media.transcodeId,
        maxVideoBitrate: quality === 'direct' ? String(Math.max(20000, original.bitrate || 0)) : String(this.qualityOptions.find(q => q.id === qualityId(quality))?.bitrate || 4000), videoQuality: '100',
        'X-Plex-Client-Profile-Name': 'Generic',
        'X-Plex-Client-Profile-Extra': 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)' });
      if (audio) params.set('audioStreamID',audio.id);
      params.set('audioChannelCount','2');
      if (burn) { params.set('advancedSubtitles','burn'); params.set('subtitleSize','100'); }
      if (quality !== 'direct') {
        const q = this.qualityOptions.find(q => q.id === qualityId(quality)); params.set('videoResolution', `${q.width}x${q.height}`);
      }
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
      }
      } finally { try { await restoreSubtitle?.(); } finally { await restoreAudio?.(); } }
      };
      try { await this.withPartLock(media.partId,prepare); }
      catch(error) {
        await this.stop(media);
        const failure=error instanceof PlaybackError ? error : new PlaybackError('Plex playback could not be prepared. Check server access and transcoding support.');
        failure.media=media; throw failure;
      }
    }
    return media;
  }
  async withPartLock(id,action) {
    const previous=this.partQueues.get(id) || Promise.resolve();
    const job=previous.catch(()=>{}).then(action); this.partQueues.set(id,job);
    try { return await job; } finally { if(this.partQueues.get(id)===job)this.partQueues.delete(id); }
  }
  async selectAudioForTranscode(media,choices) {
    const requested=media.selection.audio?.id;
    if(!requested)return;
    // PMS chooses audio from the scoped user's part selection, ignoring the
    // universal audioStreamID hint on some versions. Capture a private session
    // under the part lock, then restore the preference before releasing it.
    const read=async()=>Sources.select((await this.json('/library/metadata/'+media.id)).Metadata?.[0] || {},media.sourceSelection).part;
    const selected=part=>part?.Stream?.filter(s=>Number(s.streamType)===2 && [true,1,'1'].includes(s.selected)) || [];
    const part=await read();
    if(!part || String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1])!==media.partId || !part.Stream?.some(s=>Number(s.streamType)===2 && String(s.id)===requested)) throw new PlaybackError('The requested audio no longer belongs to this source.');
    const previous=selected(part);
    if(previous.length!==1)throw new PlaybackError('Plex did not identify its current audio selection.');
    const original=String(previous[0].id);
    if(original===requested)return;
    const set=id=>this.request('/library/parts/'+media.partId+'?'+new URLSearchParams({audioStreamID:id}),{method:'PUT'});
    const restore=async()=>{
      const current=selected(await read());
      if(current.length!==1)throw new PlaybackError('Plex could not confirm its saved audio preference.');
      // Respect a selection changed by another Plex app in the meantime.
      if(current.length===1 && String(current[0].id)===requested){
        await set(original);
        const restored=selected(await read());
        if(restored.length!==1 || String(restored[0].id)!==original)throw new PlaybackError('Plex could not restore its saved audio preference.');
      }
    };
    if(choices.authorized && !await choices.authorized())throw new PlaybackError('Viewing access or track selection expired.');
    try {
      await set(requested);
      const confirmed=selected(await read());
      if(confirmed.length!==1 || String(confirmed[0].id)!==requested)throw new PlaybackError('Plex did not select the requested audio.');
    } catch(error) { await restore();throw error; }
    return restore;
  }
  async selectSubtitleForBurn(media,choices) {
    // PMS uses this user's stored part selection for burn-in. Hold the part
    // lock through decision AND session start so another viewer cannot replace
    // it before this conversion has captured its intended source stream.
    const read=async()=>Sources.select((await this.json('/library/metadata/'+media.id)).Metadata?.[0] || {},media.sourceSelection).part;
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
    } catch(error) { await restore(); throw error; }
    return restore;
  }
  async stop(media) {
    media?.subtitleAbort?.abort(); media?.subtitleCache?.clear(); if(media)SubtitleResources.clear(media);
    if(media?.hlsLease){await media.hlsLease.release();return;}
    if (media?.av1Lease) this.av1.release(media.av1Lease);
    if (media?.transcodeId) await (media.hlsContext||media.plexContext||this).request('/video/:/transcode/universal/stop?' + new URLSearchParams({ session: media.transcodeId })).catch(() => {});
    media?.releaseConversion?.();if(media)media.releaseConversion=undefined;
  }
  async ping(media) {
    if (media?.transcodeId) await (media.hlsContext||media.plexContext||this).request('/video/:/transcode/universal/ping?' + new URLSearchParams({ session: media.transcodeId })).catch(() => {});
  }
  close() { this.fileCache.clear(); this.catalogCache.clear(); this.artSources.clear(); this.imageCache.clear(); this.randomCache.clear(); return Promise.all([this.hlsPool.close(),this.av1.close()]); }
}
module.exports = { Plex };
