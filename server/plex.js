'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { QUALITIES, qualityId } = require('../extension/engine');
const { AV1 } = require('./av1');

// No arbitrary upstream URLs: callers select Plex IDs, and only Plex-produced
// media paths on the configured server are eligible for proxying.
class Plex {
  constructor(config, fetcher = fetch) {
    this.fetch = fetcher; this.token = config.plexToken; this.av1 = new AV1(this, config);
    this.catalogCache = new Map(); this.artSources = new Map(); this.imageCache = new Map(); this.randomCache = new Map();
    this.scopes = new Map(); this.principal = 'discord-shared'; this.allowedItems = new Map();
    if (config.plexUrl) {
      this.base = new URL(config.plexUrl);
      if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/') throw new Error('PLEX_URL must be an HTTP(S) origin');
    }
  }
  get configured() { return !!this.base && !!this.token; }
  scope(token,principal) {
    const key=principal+':'+createHash('sha256').update(token).digest('hex');
    let scoped=this.scopes.get(key);
    if(!scoped){scoped=Object.create(Plex.prototype);Object.assign(scoped,{fetch:this.fetch,token,clientId:principal,base:this.base,av1:this.av1,principal:key,scopes:new Map(),catalogCache:new Map(),artSources:new Map(),imageCache:new Map(),randomCache:new Map(),allowedItems:new Map()});this.scopes.set(key,scoped);if(this.scopes.size>64)this.scopes.delete(this.scopes.keys().next().value);}
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
    if (!this.configured) throw new Error('Configure PLEX_URL and PLEX_TOKEN in the server .env');
    const url = new URL(resource, this.base);
    if (url.origin !== this.base.origin || url.username || url.password) throw new Error('Invalid Plex resource');
    url.searchParams.delete('X-Plex-Token'); return url;
  }
  async request(resource, options = {}) {
    const url = this.url(resource);
    const response = await this.fetch(url, { ...options, redirect: 'manual',
      signal: options.signal || AbortSignal.timeout(12000), headers: {
        Accept: 'application/json', 'X-Plex-Token': this.token, 'X-Plex-Product': 'uburoom',
        'X-Plex-Client-Identifier': url.searchParams.get('X-Plex-Client-Identifier') || url.searchParams.get('session') || this.clientId || 'radtv-watch',
        'X-Plex-Platform': 'Firefox', ...options.headers
      } });
    if (!response.ok && response.status !== 206) {const error=new Error(`Plex server request failed (HTTP ${response.status}); check server access and playback support`);error.status=response.status;throw error;}
    return response;
  }
  async json(resource) { return (await (await this.request(resource)).json()).MediaContainer || {}; }
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
  id(value) { if (!/^\d{1,20}$/.test(String(value || ''))) throw new Error('Invalid Plex item'); return String(value); }
  async allItems(resource, pageSize = 120) {
    const rows = []; let start = 0;
    for (;;) {
      const url = new URL(resource,this.base); url.searchParams.set('X-Plex-Container-Start',String(start)); url.searchParams.set('X-Plex-Container-Size',String(pageSize));
      const data = await this.json(url.href), page = data.Metadata || [];
      rows.push(...page); start += page.length;
      if (!page.length || data.totalSize != null && start >= Number(data.totalSize) || data.totalSize == null && page.length < pageSize) break;
    }
    return this.items(rows);
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
      return { items:items.slice(offset,offset + limit), total:items.length, offset, nextOffset:offset + limit < items.length ? offset + limit : null };
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
      return {items:items.slice(offset,offset + limit),total:items.length,offset,nextOffset:offset + limit < items.length ? offset + limit : null};
    }
    if (sort && sort !== 'default') query.set('sort',sorts[sort] + ':' + order);
    else if (!childPath) query.set('sort','titleSort:asc');
    const data = await this.catalog(resource + '?' + query), rows = data.Metadata || [];
    const total = data.totalSize == null ? null : Number(data.totalSize), end = offset + rows.length;
    return { items:this.items(rows), total:Number.isFinite(total) ? total : null, offset,
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
    const data = await this.catalog(`/library/${type === 'collection' ? 'collections' : 'metadata'}/${this.id(id)}`), item = this.items(data.Metadata)[0];
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
      subtitle: this.subtitle(x), duration: Number(x.duration || 0) / 1000, year:x.year || Number(x.originallyAvailableAt?.slice(0,4)) || undefined, endYear:Number(x.endYear) || undefined,
      edition:text(x.editionTitle), sortTitle:text(x.titleSort), contentRating:text(x.contentRating), addedAt:Number(x.addedAt || 0),
      genres:(x.Genre || []).map(g => text(g.tag)).filter(Boolean).slice(0,12), genreIds:(x.Genre || []).map(g => String(g.id || '')).filter(Boolean),
      count:Number(x.childCount || 0), episodeCount:Number(x.leafCount || 0), index:x.index, seasonIndex:x.parentIndex,
      showTitle:text(x.grandparentTitle), parentId:x.parentRatingKey && String(x.parentRatingKey), showId:x.grandparentRatingKey && String(x.grandparentRatingKey),
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
    const original = media?.source?.Media?.[0];
    return QUALITIES.filter(q => !q.bitrate || (!original?.bitrate || q.bitrate <= original.bitrate) &&
      (!original?.height || q.height <= Math.max(original.height, (original.width || 0) * 9 / 16)));
  }
  async prepare(id, quality, compatible = false, source, fallback) {
    const sameSource=source && (source.principal||'discord-shared')===this.principal;
    const item = sameSource && source.source || (await this.json(`/library/metadata/${id}`)).Metadata?.[0];
    if (!item || !['movie', 'episode'].includes(item.type)) throw new Error('Select a movie or episode');
    const part = item.Media?.[0]?.Part?.[0];
    if (!part?.key || !/^\/library\/parts\/\d+\//.test(part.key) || !Number.isFinite(item.duration) || item.duration <= 0) throw new Error('Media is not playable');
    const media = { title: String(item.title).slice(0, 200), subtitle: this.subtitle(item), duration: item.duration / 1000, quality, kind: 'plex', resources: new Map(), id,
      source: item, principal:this.principal, plexContext:this, videoCodec: item.Media[0].videoCodec || part.Stream?.find(x => x.streamType === 1)?.codec,
      ...(sameSource ? { previousId: source.previousId, nextId: source.nextId } : await this.neighbors(item)) };
    if (fallback === 'av1') {
      const original = { ...media, start:this.url(part.key).href };
      media.format = 'av1'; media.videoCodec = 'av1'; media.compatible = true;
      media.av1Lease = this.av1.acquire(original, quality);
    }
    else if (quality === 'direct' && !compatible) { media.format = 'file'; media.start = this.url(part.key).href; }
    else {
      media.format = 'hls'; media.transcodeId = randomUUID();
      const params = new URLSearchParams({ path: `/library/metadata/${id}`, mediaIndex: '0', partIndex: '0',
        protocol: 'hls', directPlay: '0', directStream: '0', fastSeek: '1', hasMDE: '1',
        offset: '0', session: media.transcodeId, subtitles: 'none', audioBoost: '100',
        'X-Plex-Client-Identifier': media.transcodeId, 'X-Plex-Session-Identifier': media.transcodeId,
        maxVideoBitrate: quality === 'direct' ? String(Math.max(20000, item.Media[0].bitrate || 0)) : String(QUALITIES.find(q => q.id === qualityId(quality))?.bitrate || 4000), videoQuality: '100',
        'X-Plex-Client-Profile-Name': 'Generic',
        'X-Plex-Client-Profile-Extra': 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)' });
      if (quality !== 'direct') {
        const q = QUALITIES.find(q => q.id === qualityId(quality)); params.set('videoResolution', `${q.width}x${q.height}`);
      }
      const decision = await this.json('/video/:/transcode/universal/decision?' + params);
      const output = decision.Metadata?.[0]?.Media?.[0];
      const stream = output?.Part?.[0]?.Stream?.find(x => x.streamType === 1);
      if (Number(decision.generalDecisionCode) >= 2000 || output && output.videoCodec && output.videoCodec !== 'h264' || stream?.codec && stream.codec !== 'h264') {
        await this.stop(media); throw new Error('Plex could not provide H.264 video; check transcoding settings');
      }
      media.videoCodec = 'h264'; media.compatible = compatible;
      media.start = this.url('/video/:/transcode/universal/start.m3u8?' + params).href;
    }
    return media;
  }
  async stop(media) {
    if (media?.av1Lease) this.av1.release(media.av1Lease);
    if (media?.transcodeId) await (media.plexContext||this).request('/video/:/transcode/universal/stop?' + new URLSearchParams({ session: media.transcodeId })).catch(() => {});
  }
  async ping(media) {
    if (media?.transcodeId) await (media.plexContext||this).request('/video/:/transcode/universal/ping?' + new URLSearchParams({ session: media.transcodeId })).catch(() => {});
  }
  close() { this.catalogCache.clear(); this.artSources.clear(); this.imageCache.clear(); this.randomCache.clear(); return this.av1.close(); }
}
module.exports = { Plex };
