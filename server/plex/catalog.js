'use strict';
const { createHash } = require('node:crypto');
const Sources = require('../plex-source');
const { mediaIdentity } = require('../../shared/room-protocol.mjs');
const { SharedTask } = require('../operation');

// Catalog browsing: library, search, details, artwork, queue expansion and file
// availability, with small short-lived caches. Playback decisions never use these caches.
class PlexCatalog {
  constructor(plex, cacheBudget) {
    this.plex = plex;
    this.cacheBudget = cacheBudget;
    this.fileCache = new Map();
    this.catalogCache = new Map();
    this.artSources = new Map();
    this.imageCache = new Map();
    this.randomCache = new Map();
  }
  // Small, short-lived in-process caches. Playback decisions never use these.
  cached(cache, key, limit, create, ttl = 60000) {
    const old = cache.get(key);
    if (old && old.until > Date.now() && (!old.task || old.task.settled || !old.task.signal.aborted)) {
      this.cacheBudget?.touch(old);
      return old.task ? old.task.join() : old.value;
    }
    cache.delete(key);
    while (cache.size >= limit) cache.delete(cache.keys().next().value);
    const task = new SharedTask(create),
      value = task.promise;
    const entry = { until: Date.now() + ttl, value, task };
    cache.set(key, entry);
    value.then(
      result => this.cacheBudget?.retain(cache, key, entry, result),
      () => {},
    );
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return task.join();
  }
  catalog(resource) {
    return this.plex.cached(this.catalogCache, resource, 96, () => this.plex.json(resource));
  }
  async availability(ids, budget, fresh = false) {
    const rawIds = ids.filter(id => id !== 'demo').map(id => this.plex.id(id));
    const baseToRaw = new Map();
    for (const raw of rawIds) {
      const base = raw.split(':')[0];
      if (!baseToRaw.has(base)) baseToRaw.set(base, []);
      baseToRaw.get(base).push(raw);
    }
    const unique = [...baseToRaw.keys()].sort(),
      result = new Map();
    for (let start = 0; start < unique.length; start += 80) {
      const batch = unique.slice(start, start + 80),
        records = new Map(),
        missing = [];
      for (const id of batch) {
        const cached = this.fileCache.get(id);
        if (!fresh && cached?.until > Date.now()) records.set(id, cached);
        else missing.push(id);
      }
      if (missing.length) {
        const task = new SharedTask(async () => {
          if (budget && --budget.requests < 0)
            throw new Error('Plex selection exceeds the supported 200-request expansion limit');
          const data = await this.plex.json('/library/metadata/' + missing.join(',') + '?checkFiles=1');
          return new Map((data.Metadata || []).map(item => [String(item.ratingKey), item]));
        });
        for (const id of missing) {
          /** @type {{until:number,value?:Promise<boolean>,available?:boolean}} */
          const record = { until: Infinity, task };
          record.value = task.promise
            .then(rows => {
              record.available = rows.has(id) && Sources.available(rows.get(id));
              record.versions = new Set(
                (rows.get(id)?.Media || [])
                  .filter(media => Sources.available({ Media: [media] }))
                  .map(media => String(media.id)),
              );
              record.until = Date.now() + 15000;
              return record.available;
            })
            .catch(error => {
              if (this.fileCache.get(id) === record) this.fileCache.delete(id);
              throw error;
            });
          // Callers reach this through task.join(), which skips it when the task
          // fails. Left unobserved, that rejection would end the server process.
          record.value.catch(() => {});
          records.set(id, record);
          this.fileCache.delete(id);
          this.fileCache.set(id, record);
          while (this.fileCache.size > 2000) this.fileCache.delete(this.fileCache.keys().next().value);
        }
      }
      const values = await Promise.all(
        batch.map(async id => [
          id,
          await (records
            .get(id)
            .task?.join()
            .then(() => records.get(id).value) || records.get(id).value),
        ]),
      );
      for (const [baseId, value] of values) {
        for (const raw of baseToRaw.get(baseId) || [])
          result.set(
            raw,
            value &&
              (!mediaIdentity(raw).mediaId || records.get(baseId).versions?.has(mediaIdentity(raw).mediaId) === true),
          );
      }
    }
    return result;
  }
  cachedAvailability(items) {
    return items.map(item => {
      const record = this.fileCache.get(item.id) || this.fileCache.get(String(item.id).split(':')[0]);
      return record?.until > Date.now() && typeof record.available === 'boolean'
        ? {
            ...item,
            available:
              record.available &&
              (!mediaIdentity(item.id)?.mediaId || record.versions?.has(mediaIdentity(item.id).mediaId) === true),
          }
        : item;
    });
  }
  async checkedItems(items, budget, fresh = false) {
    const playable = items.filter(item => ['movie', 'episode'].includes(item.type));
    const statuses = await this.plex.availability(
      playable.map(item => item.id),
      budget,
      fresh,
    );
    return items.map(item => (statuses.has(item.id) ? { ...item, available: statuses.get(item.id) } : item));
  }
  async playableItem(id) {
    const identity = mediaIdentity(this.plex.id(id)),
      baseId = identity.ratingKey;
    const data = await this.plex.json('/library/metadata/' + this.plex.id(baseId) + '?checkFiles=1'),
      source = data.Metadata?.[0];
    if (!source || !['movie', 'episode'].includes(source.type)) throw new Error('Select a movie or episode');
    if (!Sources.available(source)) throw Sources.unavailableError(source);
    if (identity.mediaId) Sources.select(source, { mediaId: identity.mediaId });
    const items = this.plex.items([source]);
    return { ...(identity.mediaId ? items.find(item => item.id === id) || items[0] : items[0]), id };
  }
  async allItems(resource, pageSize = 120, maxItems = 20000, budget) {
    const rows = [],
      seen = new Set();
    let start = 0;
    for (;;) {
      if (budget && --budget.requests < 0)
        throw new Error('Plex selection exceeds the supported 200-request expansion limit');
      const url = new URL(resource, this.plex.base);
      url.searchParams.set('X-Plex-Container-Start', String(start));
      url.searchParams.set('X-Plex-Container-Size', String(pageSize));
      const data = await this.plex.json(url.href),
        page = data.Metadata || [];
      const total = data.totalSize == null ? null : Number(data.totalSize);
      if (!Array.isArray(page) || (total !== null && (!Number.isSafeInteger(total) || total < 0)))
        throw new Error('Plex returned an invalid catalog page');
      if (rows.length + page.length > maxItems || total > maxItems)
        throw new Error('Plex selection exceeds the supported 20000-item catalog limit');
      if (budget && (budget.remaining -= page.length) < 0)
        throw new Error('Plex selection exceeds the supported 20000-item expansion limit');
      let fresh = 0;
      for (const item of page) {
        const key = String(item.ratingKey) + ':' + String(item.type);
        if (!seen.has(key)) {
          seen.add(key);
          fresh++;
        }
      }
      if (page.length && !fresh) throw new Error('Plex catalog pagination did not advance');
      if (!page.length && total !== null && start < total)
        throw new Error('Plex catalog ended before all items were received');
      rows.push(...page);
      start += page.length;
      if (!page.length || (total !== null && start >= total) || (total === null && page.length < pageSize)) break;
    }
    return this.plex.items(rows);
  }
  async queueItems({ type, id, includeSpecials = false } = {}, budget) {
    id = this.plex.id(id);
    if (typeof includeSpecials !== 'boolean' || !['show', 'season', 'library', 'collection'].includes(type))
      throw new Error('Invalid queue scope');
    const load = async (activeBudget = { remaining: 20000, requests: 200 }) => {
      if (type === 'library') {
        const sections = (await this.plex.catalog('/library/sections')).Directory || [];
        if (!sections.some(section => String(section.key) === id && section.type === 'movie'))
          throw new Error('Choose a movie library');
        return (await this.plex.allItems('/library/sections/' + id + '/all?type=1', 2500, 20000, activeBudget)).filter(
          item => item.type === 'movie',
        );
      }
      if (type === 'collection') {
        const items = [];
        const children = await this.plex.allItems(
          '/library/collections/' + id + '/children',
          2500,
          20000,
          activeBudget,
        );
        const expanded = new Set();
        for (const child of children) {
          if (['movie', 'episode'].includes(child.type)) items.push(child);
          else if (['show', 'season'].includes(child.type) && !expanded.has(child.id)) {
            expanded.add(child.id);
            items.push(
              ...(await this.plex.queueItems({ type: child.type, id: child.id, includeSpecials }, activeBudget)),
            );
          }
          if (items.length > 20000) throw new Error('Plex selection exceeds the supported 20000-item catalog limit');
        }
        return items;
      }
      return (
        await this.plex.allItems(
          '/library/metadata/' + id + (type === 'show' ? '/allLeaves' : '/children'),
          2500,
          20000,
          activeBudget,
        )
      )
        .filter(item => item.type === 'episode')
        .sort(
          (a, b) =>
            Number(a.seasonIndex || 0) - Number(b.seasonIndex || 0) ||
            Number(a.index || 0) - Number(b.index || 0) ||
            a.id.localeCompare(b.id, undefined, { numeric: true }),
        );
    };
    const key = 'queue:' + type + ':' + id + (type === 'collection' ? ':' + includeSpecials : '');
    const items = this.plex.cachedAvailability(
      budget ? await load(budget) : await this.plex.cached(this.catalogCache, key, 96, () => load()),
    );
    const seen = new Set();
    return items.filter(item => {
      if (item.available === false) return false;
      if ((item.type === 'episode' && !includeSpecials && Number(item.seasonIndex) === 0) || seen.has(item.id))
        return false;
      seen.add(item.id);
      return true;
    });
  }
  shuffle(items, seed) {
    return items
      .map(item => ({
        item,
        key: createHash('sha256')
          .update(seed + ':' + item.id)
          .digest('hex'),
      }))
      .sort((a, b) => a.key.localeCompare(b.key) || a.item.id.localeCompare(b.item.id))
      .map(x => x.item);
  }
  async browse(options = {}) {
    const {
      section,
      parent,
      collection,
      tab = 'library',
      q = '',
      genre = '',
      year = '',
      sort,
      order = 'asc',
      seed,
    } = options;
    const offset = Number(options.offset || 0),
      limit = 48;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000000 ||
      !['library', 'collections'].includes(tab) ||
      typeof q !== 'string' ||
      q.length > 200 ||
      !['asc', 'desc'].includes(order) ||
      (genre && !/^\d{1,20}$/.test(genre)) ||
      (year && !/^\d{4}$/.test(year))
    )
      throw new Error('Invalid library query');
    const sorts = { title: 'titleSort', added: 'addedAt', year: 'year', runtime: 'duration' };
    if (sort && !['default', 'random'].includes(sort) && !Object.hasOwn(sorts, sort))
      throw new Error('Invalid library sort');
    if (sort === 'random' && !/^[a-f0-9]{32}$/.test(seed || '')) throw new Error('Invalid shuffle seed');
    if (parent && collection) throw new Error('Choose one library location');
    if (!section && !parent && !collection) {
      const data = await this.plex.catalog('/library/sections');
      const items = (data.Directory || [])
        .filter(x => ['movie', 'show'].includes(x.type) && /^\d{1,20}$/.test(String(x.key)))
        .map(x => ({ id: String(x.key), title: String(x.title).slice(0, 200), type: 'library', mediaType: x.type }));
      return { items, total: items.length, offset: 0, nextOffset: null };
    }
    if (section) this.plex.id(section);
    const childPath = collection
      ? `/library/collections/${this.plex.id(collection)}/children`
      : parent
        ? `/library/metadata/${this.plex.id(parent)}/children`
        : undefined;
    // Child/collection endpoints vary in filter support. Filter the complete
    // paged child set ourselves rather than silently search only a first page.
    if (childPath && (q || genre || year || (sort && sort !== 'default'))) {
      const all = await this.plex.cached(this.catalogCache, 'all:' + childPath, 96, () =>
        this.plex.allItems(childPath),
      );
      const genreName =
        genre && section ? (await this.plex.filters(section)).genres.find(x => x.id === genre)?.title : undefined;
      // Plex child/list rows can contain only the first two genre tags. Read
      // complete tags in small batches only when a child genre filter needs them.
      const complete = genre
        ? await this.plex.cached(this.catalogCache, 'genres:' + childPath, 96, async () => {
            const tags = new Map();
            for (let start = 0; start < all.length; start += 80) {
              const ids = all
                .slice(start, start + 80)
                .map(x => x.id)
                .join(',');
              const data = await this.plex.json('/library/metadata/' + ids);
              for (const item of this.plex.items(data.Metadata)) tags.set(item.id, item);
            }
            return tags;
          })
        : undefined;
      let items = all.filter(x => {
        const tags = complete?.get(x.id) || x;
        return (
          (!q || (x.title + ' ' + (x.edition || '')).toLowerCase().includes(q.toLowerCase())) &&
          (!genre || tags.genreIds.includes(genre) || (genreName && tags.genres.includes(genreName))) &&
          (!year || String(x.year) === year)
        );
      });
      if (sort === 'random') {
        const key = childPath + ':' + new URLSearchParams({ q, genre, year, seed });
        const matching = items;
        items = await this.plex.cached(this.randomCache, key, 8, () => this.plex.shuffle(matching, seed), 15 * 60000);
      } else if (sort && sort !== 'default')
        items.sort((a, b) => {
          const comparison =
            sort === 'title'
              ? (a.sortTitle || a.title).localeCompare(b.sortTitle || b.title, undefined, {
                  numeric: true,
                  sensitivity: 'base',
                })
              : (a[{ added: 'addedAt', year: 'year', runtime: 'duration' }[sort]] || 0) -
                (b[{ added: 'addedAt', year: 'year', runtime: 'duration' }[sort]] || 0);
          return order === 'desc' ? -comparison : comparison;
        });
      return {
        items: this.plex.cachedAvailability(items.slice(offset, offset + limit)),
        total: items.length,
        offset,
        nextOffset: offset + limit < items.length ? offset + limit : null,
      };
    }
    const query = new URLSearchParams({
      'X-Plex-Container-Start': String(offset),
      'X-Plex-Container-Size': String(limit),
    });
    if (q) query.set('title', q);
    if (genre) query.set('genre', genre);
    if (year) query.set('year', year);
    const resource =
      childPath || `/library/sections/${this.plex.id(section)}/${tab === 'collections' ? 'collections' : 'all'}`;
    if (sort === 'random') {
      // Fetch matching catalog rows once per shuffle. Plex's native random sort
      // changes on each request, which is unsuitable for offset pagination.
      query.delete('X-Plex-Container-Start');
      query.delete('X-Plex-Container-Size');
      query.set('sort', 'titleSort:asc');
      const key = resource + '?' + query + ':' + seed;
      const items = await this.plex.cached(
        this.randomCache,
        key,
        8,
        async () => this.plex.shuffle(await this.plex.allItems(resource + '?' + query, 500), seed),
        15 * 60000,
      );
      return {
        items: this.plex.cachedAvailability(items.slice(offset, offset + limit)),
        total: items.length,
        offset,
        nextOffset: offset + limit < items.length ? offset + limit : null,
      };
    }
    if (sort && sort !== 'default') query.set('sort', sorts[sort] + ':' + order);
    else if (!childPath) query.set('sort', 'titleSort:asc');
    const data = await this.plex.catalog(resource + '?' + query),
      rows = data.Metadata || [];
    const total = data.totalSize == null ? null : Number(data.totalSize),
      end = offset + rows.length;
    return {
      items: this.plex.cachedAvailability(this.plex.items(rows)),
      total: Number.isFinite(total) ? total : null,
      offset,
      nextOffset: rows.length && (total == null ? rows.length >= limit : end < total) ? end : null,
    };
  }
  async filters(section) {
    this.plex.id(section);
    const values = async field => {
      const data = await this.plex.catalog(`/library/sections/${section}/${field}`);
      return (data.Directory || [])
        .filter(x => /^\d{1,20}$/.test(String(x.key)))
        .map(x => ({ id: String(x.key), title: String(x.title).slice(0, 100) }));
    };
    const [genres, years] = await Promise.all([values('genre'), values('year')]);
    return { genres, years: years.sort((a, b) => Number(b.id) - Number(a.id)) };
  }
  async details(id, type) {
    if (type && !['movie', 'show', 'season', 'episode', 'collection'].includes(type))
      throw new Error('Invalid item type');
    const { ratingKey, mediaId: targetMediaId } = mediaIdentity(this.plex.id(id));
    const data = await this.plex.catalog(
      `/library/${type === 'collection' ? 'collections' : 'metadata'}/${this.plex.id(ratingKey)}`,
    );
    const source = data.Metadata?.[0];
    if (!source) throw new Error('Title unavailable');
    const items = this.plex.cachedAvailability(this.plex.items([source]));
    if (targetMediaId && !source.Media?.some(media => String(media.id) === targetMediaId))
      throw new Error('Selected version unavailable');
    const item = targetMediaId ? { ...(items.find(x => x.id === id) || items[0]), id } : items[0];
    if (!item) throw new Error('Title unavailable');
    const tags = name =>
      (source[name] || [])
        .map(x => String(x.tag || '').slice(0, 120))
        .filter(Boolean)
        .slice(0, name === 'Role' ? 8 : 12);
    const ratings = [];
    for (const [field, image, label] of [
      ['rating', 'ratingImage', 'Critics'],
      ['audienceRating', 'audienceRatingImage', 'Audience'],
    ]) {
      const provider = String(source[image] || '').toLowerCase();
      const name = provider.includes('imdb')
        ? 'IMDb'
        : provider.includes('rottentomatoes')
          ? 'Rotten Tomatoes ' + label
          : provider.includes('themoviedb')
            ? 'TMDB'
            : undefined;
      const value = Number(source[field]);
      if (name && Number.isFinite(value) && value >= 0 && value <= 10) ratings.push({ source: name, value });
    }
    const pinnedMedia = targetMediaId ? source.Media?.find(m => String(m.id) === targetMediaId) : undefined;
    const media =
      pinnedMedia ||
      Sources.inventory(source).find(entry => entry.eligible && Sources.partAvailable(entry.part))?.media ||
      source.Media?.find(m => m.Part?.some(p => Sources.partAvailable(p))) ||
      source.Media?.[0];
    const mediaInfo = media
      ? [
          media.videoResolution
            ? String(media.videoResolution).toUpperCase() + (String(media.videoResolution).match(/^\d+$/) ? 'p' : '')
            : '',
          media.videoCodec,
          media.bitrate ? (Number(media.bitrate) / 1000).toFixed(1) + ' Mbps' : '',
          media.audioCodec,
          media.audioChannels ? media.audioChannels + ' channels' : '',
          media.container,
        ]
          .filter(Boolean)
          .map(x => String(x).slice(0, 60))
      : [];
    const otherEditions = [];
    if (source.Media && source.Media.length > 1) {
      for (let idx = 0; idx < source.Media.length; idx++) {
        const m = source.Media[idx];
        const mId = String(m.id || idx);
        const compoundId = ratingKey + ':' + mId;
        if (compoundId === item.id) continue;
        const res = m.videoResolution
          ? String(m.videoResolution).toUpperCase() + (String(m.videoResolution).match(/^\d+$/) ? 'p' : '')
          : '';
        const codec = m.videoCodec ? m.videoCodec.toUpperCase() : '';
        const mediaLabel = [res, codec].filter(Boolean).join(' ') || 'Version ' + (idx + 1);
        const editionLabel = String(source.editionTitle || '').trim()
          ? String(source.editionTitle || '').trim() + (idx > 0 ? ' · ' + mediaLabel : '')
          : mediaLabel;
        const year = source.year || source.originallyAvailableAt?.slice(0, 4);
        const subtitle = [year, editionLabel].filter(Boolean).join(' · ').slice(0, 200);
        const mInfo = [
          res,
          m.videoCodec,
          m.bitrate ? (Number(m.bitrate) / 1000).toFixed(1) + ' Mbps' : '',
          m.audioCodec,
          m.audioChannels ? m.audioChannels + ' channels' : '',
          m.container,
        ]
          .filter(Boolean)
          .map(x => String(x).slice(0, 60));
        otherEditions.push({
          id: compoundId,
          type: source.type || 'movie',
          title: String(source.title).slice(0, 200),
          edition: editionLabel,
          subtitle,
          duration: Number(m.duration || source.duration || 0) / 1000,
          mediaInfo: mInfo,
        });
      }
    }
    if (source.librarySectionID && source.type === 'movie') {
      try {
        const query = new URLSearchParams({ title: source.title });
        const sectionCatalog = await this.plex.catalog(`/library/sections/${source.librarySectionID}/all?${query}`);
        const siblings = (sectionCatalog.Metadata || []).filter(
          s =>
            String(s.ratingKey) !== String(ratingKey) &&
            String(s.title || '')
              .trim()
              .toLowerCase() ===
              String(source.title || '')
                .trim()
                .toLowerCase(),
        );
        for (const s of siblings) {
          const sItems = this.plex.items([s]);
          for (const si of sItems) {
            if (otherEditions.some(e => e.id === si.id)) continue;
            const sMedia = s.Media?.[0];
            const sInfo = sMedia
              ? [
                  sMedia.videoResolution
                    ? String(sMedia.videoResolution).toUpperCase() +
                      (String(sMedia.videoResolution).match(/^\d+$/) ? 'p' : '')
                    : '',
                  sMedia.videoCodec,
                  sMedia.bitrate ? (Number(sMedia.bitrate) / 1000).toFixed(1) + ' Mbps' : '',
                  sMedia.audioCodec,
                  sMedia.audioChannels ? sMedia.audioChannels + ' channels' : '',
                  sMedia.container,
                ]
                  .filter(Boolean)
                  .map(x => String(x).slice(0, 60))
              : [];
            otherEditions.push({
              id: si.id,
              type: s.type || 'movie',
              title: si.title,
              edition: si.edition || 'Standard Edition',
              subtitle: si.subtitle,
              duration: si.duration,
              mediaInfo: sInfo,
            });
          }
        }
      } catch {}
    }
    return {
      ...item,
      summary: String(source.summary || '').slice(0, 5000),
      directors: tags('Director'),
      cast: tags('Role'),
      ratings,
      mediaInfo,
      otherEditions,
    };
  }
  async artwork(id, kind = 'poster', type) {
    const baseId = String(id).split(':')[0];
    this.plex.id(baseId);
    if (!['poster', 'landscape'].includes(kind)) throw new Error('Invalid artwork');
    if (!this.artSources.has(id) && !this.artSources.has(baseId)) await this.plex.details(id, type);
    const source = this.artSources.get(id) || this.artSources.get(baseId),
      resource = kind === 'landscape' ? source?.landscape : source?.poster;
    if (!resource) throw new Error('Artwork unavailable');
    return this.plex.cached(this.imageCache, resource + ':' + kind, 96, async () => {
      const query = new URLSearchParams({
        width: kind === 'landscape' ? '400' : '300',
        height: kind === 'landscape' ? '225' : '450',
        minSize: '1',
        upscale: '0',
        url: resource,
      });
      const response = await this.plex.request('/photo/:/transcode?' + query, {
        headers: { Accept: 'image/jpeg,image/png,image/webp' },
      });
      const type = response.headers.get('content-type')?.split(';')[0];
      if (
        !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type) ||
        Number(response.headers.get('content-length')) > 2000000
      )
        throw new Error('Artwork unavailable');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 2000000) throw new Error('Artwork unavailable');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks, size);
      return { type, bytes };
    });
  }
  items(items = []) {
    const text = value => String(value || '').slice(0, 200);
    const thumb = value =>
      typeof value === 'string' && /^\/library\/(metadata|collections)\/\d{1,20}\/(thumb|art)(\/\d+)?$/.test(value)
        ? value
        : undefined;
    return items
      .filter(
        x =>
          ['movie', 'show', 'season', 'episode', 'collection'].includes(x.type) &&
          /^\d{1,20}$/.test(String(x.ratingKey)),
      )
      .flatMap(x => {
        const poster = thumb(x.type === 'episode' ? x.grandparentThumb || x.thumb : x.thumb),
          landscape = thumb(x.thumb || x.art);
        const id = String(x.ratingKey);
        this.artSources.delete(id);
        this.artSources.set(id, { poster, landscape });
        while (this.artSources.size > 1200) this.artSources.delete(this.artSources.keys().next().value);
        const viewOffsetSec = Number(x.viewOffset || 0) > 0 ? Math.round(Number(x.viewOffset) / 1000) : undefined;
        const durSec = Number(x.duration || 0) / 1000;
        const hasValidProgress = viewOffsetSec && viewOffsetSec >= 10 && (!durSec || viewOffsetSec <= durSec * 0.92);
        const baseItem = {
          id: String(x.ratingKey),
          type: x.type,
          title: String(x.title).slice(0, 200),
          ...(['movie', 'episode'].includes(x.type) ? { available: Sources.available(x) } : {}),
          subtitle: this.plex.subtitle(x),
          duration: durSec,
          year: x.year || Number(x.originallyAvailableAt?.slice(0, 4)) || undefined,
          endYear: Number(x.endYear) || undefined,
          edition: text(x.editionTitle),
          sortTitle: text(x.titleSort),
          contentRating: text(x.contentRating),
          addedAt: Number(x.addedAt || 0),
          genres: (x.Genre || [])
            .map(g => text(g.tag))
            .filter(Boolean)
            .slice(0, 12),
          genreIds: (x.Genre || []).map(g => String(g.id || '')).filter(Boolean),
          count: Number(x.childCount || 0),
          episodeCount: Number(x.leafCount || 0),
          index: x.index,
          seasonIndex: x.parentIndex,
          showTitle: text(x.grandparentTitle),
          parentTitle: text(x.parentTitle),
          parentId: x.parentRatingKey && String(x.parentRatingKey),
          showId: x.grandparentRatingKey && String(x.grandparentRatingKey),
          hasPoster: !!poster,
          hasLandscape: !!landscape,
          ...(['movie', 'episode'].includes(x.type) ? { summary: String(x.summary || '').slice(0, 500) } : {}),
          ...(hasValidProgress ? { viewOffset: viewOffsetSec } : {}),
        };
        if (x.type === 'movie' && Array.isArray(x.Media) && x.Media.length > 1) {
          return x.Media.map((m, idx) => {
            const mId = String(m.id || idx);
            const compoundId = id + ':' + mId;
            this.artSources.set(compoundId, { poster, landscape });
            const res = m.videoResolution
              ? String(m.videoResolution).toUpperCase() + (String(m.videoResolution).match(/^\d+$/) ? 'p' : '')
              : '';
            const codec = m.videoCodec ? m.videoCodec.toUpperCase() : '';
            const mediaLabel = [res, codec].filter(Boolean).join(' ') || 'Version ' + (idx + 1);
            const editionLabel = text(x.editionTitle)
              ? text(x.editionTitle) + (idx > 0 ? ' · ' + mediaLabel : '')
              : mediaLabel;
            const year = x.year || x.originallyAvailableAt?.slice(0, 4);
            const sub = [year, editionLabel].filter(Boolean).join(' · ').slice(0, 200);
            return {
              ...baseItem,
              id: compoundId,
              edition: editionLabel,
              subtitle: sub,
              duration: Number(m.duration || x.duration || 0) / 1000,
              available: m.Part ? m.Part.some(p => Sources.partAvailable(p)) : baseItem.available,
            };
          });
        }
        return [baseItem];
      });
  }
  subtitle(item) {
    const year = item.year || item.originallyAvailableAt?.slice(0, 4);
    return (
      item.type === 'episode'
        ? [
            item.grandparentTitle,
            Number.isInteger(item.parentIndex) ? 'Season ' + item.parentIndex : item.parentTitle,
            Number.isInteger(item.index) ? 'Episode ' + item.index : undefined,
            year,
          ]
        : [year, item.editionTitle]
    )
      .filter(value => value !== undefined && value !== null && value !== '')
      .join(' · ')
      .slice(0, 200);
  }
  async neighbors(item) {
    if (item.type !== 'episode' || !/^\d+$/.test(String(item.grandparentRatingKey || ''))) return {};
    const data = await this.plex.catalog(`/library/metadata/${item.grandparentRatingKey}/allLeaves`);
    const episodes = (data.Metadata || [])
      .filter(
        x =>
          x.type === 'episode' &&
          /^\d+$/.test(String(x.ratingKey)) &&
          (x.parentIndex == null || Number(x.parentIndex) !== 0),
      )
      .sort((a, b) => (a.parentIndex || 0) - (b.parentIndex || 0) || (a.index || 0) - (b.index || 0));
    const index = episodes.findIndex(x => String(x.ratingKey) === String(item.ratingKey));
    if (index < 0) return {};
    return {
      previousId: episodes[index - 1] && String(episodes[index - 1].ratingKey),
      nextId: episodes[index + 1] && String(episodes[index + 1].ratingKey),
    };
  }
  async nextEpisodeOffer(episodeMediaId) {
    try {
      const data = await this.plex.catalog(
        '/library/metadata/' + mediaIdentity(this.plex.id(episodeMediaId)).ratingKey,
      );
      const source = data.Metadata?.[0];
      if (source?.type !== 'episode' || !source.grandparentRatingKey) return null;
      const leavesData = await this.plex.catalog(`/library/metadata/${source.grandparentRatingKey}/allLeaves`);
      const episodes = (leavesData.Metadata || [])
        .filter(
          x =>
            x.type === 'episode' &&
            /^\d+$/.test(String(x.ratingKey)) &&
            (x.parentIndex == null || Number(x.parentIndex) !== 0),
        )
        .sort(
          (a, b) =>
            (Number(a.parentIndex) || 0) - (Number(b.parentIndex) || 0) ||
            (Number(a.index) || 0) - (Number(b.index) || 0),
        );
      const index = episodes.findIndex(x => String(x.ratingKey) === String(source.ratingKey));
      if (index < 0 || index + 1 >= episodes.length) return null;
      const candidates = episodes.slice(index + 1, index + 6);
      if (this.plex.availability) await this.plex.availability(candidates.map(c => String(c.ratingKey)));
      let nextRaw;
      for (const candidate of candidates) {
        const id = String(candidate.ratingKey);
        if ((await this.plex.allows(id)) && Sources.available(candidate)) {
          nextRaw = candidate;
          break;
        }
      }
      if (!nextRaw) return null;
      const item = this.plex.items([nextRaw])[0];
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
        hasPoster: item.hasPoster,
      };
    } catch {
      return null;
    }
  }
}

module.exports = { PlexCatalog };
