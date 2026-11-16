'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { PlaybackError, classifyHdr } = require('./av1');
const Tracks = require('./media-tracks');
const { prepareStream } = require('./media-delivery');
const { resilientFetch } = require('./resilience');
const { runOperation } = require('./operation');
const { version } = require('../package.json');

const GUID = /^[a-f0-9]{32}$/i;
const TICKS = 10000000;
const PAGE = 48,
  QUEUE_LIMIT = 2000,
  SHUFFLE_LIMIT = 5000,
  ART_LIMIT = 3 * 1024 * 1024;
const TYPES = { Movie: 'movie', Series: 'show', Season: 'season', Episode: 'episode', BoxSet: 'collection' };
const LIST_FIELDS = 'Genres,GenreItems,Overview,DateCreated,SortName,ChildCount,RecursiveItemCount,Path';
const SOURCE_FIELDS = LIST_FIELDS + ',MediaSources,Chapters,People';
const SORTS = { title: 'SortName', added: 'DateCreated,SortName', year: 'ProductionYear,SortName', runtime: 'Runtime' };
// Jellyfin's names for subtitle formats the track catalog knows under FFmpeg's.
const CODECS = { pgssub: 'hdmv_pgs_subtitle', dvdsub: 'dvd_subtitle', dvbsub: 'dvb_subtitle', srt: 'subrip' };
// External subtitles Jellyfin can hand over as they are, by the extension it serves them under.
const SIDECARS = { subrip: 'srt', webvtt: 'vtt', ass: 'ass', ssa: 'ssa' };

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, limit = 200) => (typeof value === 'string' ? value.slice(0, limit) : '');
const lower = value => (typeof value === 'string' && GUID.test(value) ? value.toLowerCase() : undefined);
const seconds = ticks => (Number(ticks) > 0 ? Number(ticks) / TICKS : 0);
const guid = value => {
  if (typeof value !== 'string' || !GUID.test(value)) throw failure('Invalid Jellyfin item');
  return value.toLowerCase();
};
/** A Jellyfin media selector: an item id, optionally with the id of one of its media sources. */
function jellyfinIdentity(value) {
  const match = typeof value === 'string' && /^([a-f0-9]{32})(?::([A-Za-z0-9_-]{1,64}))?$/i.exec(value);
  if (!match) throw failure('Invalid Jellyfin item');
  return { id: value, itemId: match[1].toLowerCase(), sourceId: match[2] };
}
function unavailable(item) {
  return Object.assign(new PlaybackError(text(item?.Name) + ' is unavailable.'), {
    code: 'MEDIA_UNAVAILABLE',
    status: 409,
    mediaId: item?.Id,
    title: text(item?.Name),
  });
}

/**
 * A Jellyfin server seen through one configured user. Jellyfin accounts are not
 * linked to uburoom accounts, so everyone uburoom admits watches through that
 * user and sees what it may see; who is admitted stays the access policy's
 * decision. It supplies sources only: every conversion is uburoom's own, reading
 * the original file through `request()`. See server/media-provider.js for the contract.
 */
class Jellyfin {
  /**
   * @param {{url: string, apiKey: string, user: string}} settings
   * @param {{pipeline: any, registry?: any, logger?: any, fetcher?: typeof fetch}} services
   */
  constructor(settings, { pipeline, registry, logger, fetcher = fetch }) {
    this.settings = settings;
    this.pipeline = pipeline;
    this.registry = registry;
    this.logger = logger;
    this.fetch = resilientFetch(fetcher);
    // A server may live under a path, so resources resolve inside it, never beside it.
    this.base = settings.url ? new URL(settings.url.replace(/\/+$/, '') + '/') : undefined;
    this.device = 'uburoom-' + createHash('sha256').update(String(settings.url)).digest('hex').slice(0, 16);
    /** @type {Map<string,{poster?: {id: string, type: string}, landscape?: {id: string, type: string}, backdrop?: {id: string, type: string}, logo?: {id: string, type: string}}>} */
    this.art = new Map();
    /** @type {Map<string,{at: number, ok: boolean}>} */
    this.seen = new Map();
    /** @type {Map<string,string>} Library id to the kind of item it holds. */
    this.views = new Map();
  }
  /** For the host's video check: who listed a file's tracks and how to refresh that list. */
  get checks() {
    return {
      label: {
        name: 'Jellyfin',
        owner: "Jellyfin's",
        refresh: " In Jellyfin, open the item's menu and choose Refresh metadata.",
      },
    };
  }
  get kind() {
    return 'jellyfin';
  }
  get configured() {
    return !!this.base && !!this.settings.apiKey && !!this.settings.user;
  }
  get principal() {
    return 'jellyfin-shared';
  }
  get root() {
    return this;
  }
  // Client
  url(resource) {
    if (!this.configured)
      throw new Error('Configure jellyfin.url, jellyfin.api_key and jellyfin.user in private config.yaml');
    const url = new URL(resource, this.base);
    if (
      url.origin !== this.base.origin ||
      !url.pathname.startsWith(this.base.pathname) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Invalid Jellyfin resource');
    for (const name of [...url.searchParams.keys()])
      if (['api_key', 'apikey'].includes(name.toLowerCase())) url.searchParams.delete(name);
    return url;
  }
  /** A resource on this server from a path inside it and its query. */
  path(name, query = {}) {
    const url = new URL(name, this.base);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    return url.href;
  }
  async request(resource, options = {}) {
    const url = this.url(resource);
    const response = await this.fetch(url, {
      method: options.method,
      redirect: 'manual',
      signal: options.signal || (options.streaming ? undefined : AbortSignal.timeout(12000)),
      headers: {
        Accept: 'application/json',
        ...options.headers,
        Authorization: `MediaBrowser Client="uburoom", Device="uburoom", DeviceId="${this.device}", Version="${version}", Token="${this.settings.apiKey}"`,
      },
    });
    if (!response.ok && response.status !== 206) {
      void response.body?.cancel().catch(() => {});
      throw Object.assign(
        new Error(`Jellyfin server request failed (HTTP ${response.status}); check jellyfin.url, its API key and user`),
        { status: response.status },
      );
    }
    return response;
  }
  async json(name, query, options) {
    return (await this.request(this.path(name, query), options)).json();
  }
  /** The configured user's id; what the server shows is what that user may see. */
  userId() {
    if (!this.user) {
      this.user = (async () => {
        const users = await this.json('Users');
        const wanted = this.settings.user.toLowerCase();
        const found = (Array.isArray(users) ? users : []).find(
          user => typeof user?.Name === 'string' && user.Name.toLowerCase() === wanted && GUID.test(user.Id || ''),
        );
        if (!found) throw failure('jellyfin.user was not found on the Jellyfin server', 503);
        return found.Id.toLowerCase();
      })();
      this.user.catch(() => {
        this.user = undefined;
      });
    }
    return this.user;
  }
  // The server's own id, pinned the first time it is seen so a different server
  // behind the same address is refused rather than mistaken for this one.
  identity() {
    if (!this.identifying) {
      this.identifying = (async () => {
        const id = (await this.json('System/Info/Public')).Id,
          pinned = this.registry?.meta('jellyfinServerId');
        if (typeof id !== 'string' || !GUID.test(id) || (pinned && id !== pinned))
          throw failure('The configured Jellyfin server identity changed', 503);
        if (!pinned && this.registry) {
          this.registry.meta('jellyfinServerId', id);
          await this.registry.flush();
        }
        return id;
      })();
      this.identifying.catch(() => {
        this.identifying = undefined;
      });
    }
    return this.identifying;
  }
  async query(name, query = {}) {
    const data = await this.json(name, { userId: await this.userId(), ...query });
    return { items: Array.isArray(data?.Items) ? data.Items : [], total: Number(data?.TotalRecordCount) };
  }
  /** One item as the configured user may see it; an id the user cannot see is not found. */
  async one(id, fields = SOURCE_FIELDS) {
    const { items } = await this.query('Items', { ids: guid(id), fields });
    const item = items.find(x => String(x?.Id).toLowerCase() === id.toLowerCase());
    this.remember(id, !!item);
    if (!item) throw failure('Select a video from the library', 404);
    return item;
  }
  remember(id, ok) {
    const key = String(id).toLowerCase();
    this.seen.delete(key);
    this.seen.set(key, { at: Date.now(), ok });
    while (this.seen.size > 4000) this.seen.delete(this.seen.keys().next().value);
  }
  // Catalog
  subtitle(x) {
    return (
      x.Type === 'Episode'
        ? [
            x.SeriesName,
            Number.isInteger(x.ParentIndexNumber) ? 'Season ' + x.ParentIndexNumber : x.SeasonName,
            Number.isInteger(x.IndexNumber) ? 'Episode ' + x.IndexNumber : undefined,
            x.ProductionYear,
          ]
        : [x.ProductionYear]
    )
      .filter(value => value !== undefined && value !== null && value !== '')
      .join(' · ')
      .slice(0, 200);
  }
  playable(x) {
    return x.LocationType !== 'Virtual' && x.IsMissing !== true;
  }
  items(list = []) {
    return list
      .filter(x => TYPES[x?.Type] && GUID.test(x.Id || ''))
      .map(x => {
        const id = x.Id.toLowerCase(),
          type = TYPES[x.Type];
        const own = x.ImageTags?.Primary ? { id, type: 'Primary' } : undefined;
        const series =
          x.SeriesPrimaryImageTag && GUID.test(x.SeriesId || '') ? { id: x.SeriesId, type: 'Primary' } : undefined;
        const backdrop = x.BackdropImageTags?.length
          ? { id, type: 'Backdrop' }
          : x.ParentBackdropImageTags?.length && GUID.test(x.ParentBackdropItemId || '')
            ? { id: x.ParentBackdropItemId, type: 'Backdrop' }
            : undefined;
        const poster = type === 'episode' ? series || own : own,
          landscape = type === 'episode' ? own || backdrop : backdrop || own,
          // A title logo of the item itself; only movies and shows are titled by one.
          logo = ['movie', 'show'].includes(type) && x.ImageTags?.Logo ? { id, type: 'Logo' } : undefined;
        this.art.delete(id);
        this.art.set(id, { poster, landscape, backdrop, logo });
        while (this.art.size > 1200) this.art.delete(this.art.keys().next().value);
        this.remember(id, true);
        const playable = ['movie', 'episode'].includes(type);
        return {
          id,
          type,
          title: text(x.Name) || 'Untitled',
          ...(playable ? { available: this.playable(x) } : {}),
          subtitle: this.subtitle(x),
          duration: seconds(x.RunTimeTicks),
          year: Number(x.ProductionYear) || undefined,
          endYear: Number(String(x.EndDate || '').slice(0, 4)) || undefined,
          edition: '',
          sortTitle: text(x.SortName),
          contentRating: text(x.OfficialRating),
          addedAt: Math.floor(Date.parse(x.DateCreated) / 1000) || 0,
          genres: (x.Genres || [])
            .map(name => text(name))
            .filter(Boolean)
            .slice(0, 12),
          genreIds: (x.GenreItems || []).map(genre => String(genre?.Id || '')).filter(Boolean),
          count: Number(x.ChildCount || 0),
          episodeCount: type === 'show' || type === 'season' ? Number(x.RecursiveItemCount || x.ChildCount || 0) : 0,
          index: x.IndexNumber,
          seasonIndex: x.ParentIndexNumber,
          showTitle: type === 'episode' ? text(x.SeriesName) : '',
          parentTitle: type === 'episode' ? text(x.SeasonName) : type === 'season' ? text(x.SeriesName) : '',
          parentId: lower(type === 'episode' ? x.SeasonId : type === 'season' ? x.SeriesId : undefined),
          showId: lower(type === 'episode' ? x.SeriesId : undefined),
          hasPoster: !!poster,
          hasLandscape: !!landscape,
          hasBackdrop: !!backdrop,
          hasLogo: !!logo,
          ...(playable ? { summary: text(x.Overview, 500) } : {}),
        };
      });
  }
  async libraries() {
    const userId = await this.userId();
    let data;
    try {
      data = await this.json('UserViews', { userId });
    } catch (error) {
      // Servers before 10.9 list a user's libraries under the user.
      if (![400, 404, 405].includes(error.status)) throw error;
      data = await this.json(`Users/${userId}/Views`);
    }
    const items = (Array.isArray(data?.Items) ? data.Items : [])
      .filter(view => GUID.test(view?.Id || '') && ['movies', 'tvshows'].includes(view.CollectionType))
      .map(view => ({
        id: view.Id.toLowerCase(),
        title: text(view.Name) || 'Library',
        type: 'library',
        mediaType: view.CollectionType === 'tvshows' ? 'show' : 'movie',
        collections: false,
      }));
    this.views = new Map(items.map(item => [item.id, item.mediaType]));
    return items;
  }
  async section(id) {
    const key = guid(id);
    if (!this.views.has(key)) await this.libraries();
    if (!this.views.has(key)) throw failure('Select a library', 404);
    return { parentId: key, recursive: true, includeItemTypes: this.views.get(key) === 'show' ? 'Series' : 'Movie' };
  }
  async browse(options = {}) {
    const { section, parent, collection, tab = 'library', q = '', genre = '', year = '', sort, seed } = options;
    const order = options.order || 'asc',
      offset = Number(options.offset || 0);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000000 ||
      !['library', 'collections'].includes(tab) ||
      typeof q !== 'string' ||
      q.length > 200 ||
      !['asc', 'desc'].includes(order) ||
      (genre && !GUID.test(genre)) ||
      (year && !/^\d{4}$/.test(year))
    )
      throw failure('Invalid library query');
    if (sort && !['default', 'random'].includes(sort) && !Object.hasOwn(SORTS, sort))
      throw failure('Invalid library sort');
    if (sort === 'random' && !/^[a-f0-9]{32}$/.test(seed || '')) throw failure('Invalid shuffle seed');
    if (parent && collection) throw failure('Choose one library location');
    if (!section && !parent && !collection) {
      const items = await this.libraries();
      return { items, total: items.length, offset: 0, nextOffset: null };
    }
    if (tab === 'collections' && !parent && !collection) return { items: [], total: 0, offset: 0, nextOffset: null };
    const inside = parent || collection;
    // Inside a show or season the server's own order is the playing order.
    const where = inside
      ? { parentId: guid(inside), sortBy: 'ParentIndexNumber,IndexNumber,SortName' }
      : {
          ...(await this.section(section)),
          sortBy: SORTS[sort] || 'SortName',
          sortOrder: order === 'desc' ? 'Descending' : 'Ascending',
          searchTerm: q.trim(),
          genreIds: genre,
          years: year,
        };
    if (sort === 'random' && !inside) {
      // The server's own shuffle cannot be repeated page after page, so the order comes from the seed.
      const all = await this.query('Items', {
        ...where,
        sortBy: 'SortName',
        limit: SHUFFLE_LIMIT,
        enableImages: false,
      });
      const rank = id =>
        createHash('sha256')
          .update(seed + id)
          .digest('hex');
      const ids = all.items
        .filter(x => GUID.test(x?.Id || ''))
        .map(x => ({ id: x.Id, rank: rank(x.Id) }))
        .sort((a, b) => (a.rank < b.rank ? -1 : 1))
        .map(row => row.id);
      const page = ids.slice(offset, offset + PAGE);
      const found = page.length ? (await this.query('Items', { ids: page.join(','), fields: LIST_FIELDS })).items : [];
      const byId = new Map(found.map(x => [x.Id, x]));
      return {
        items: this.items(page.map(id => byId.get(id)).filter(Boolean)),
        total: ids.length,
        offset,
        nextOffset: offset + PAGE < ids.length ? offset + PAGE : null,
      };
    }
    const data = await this.query('Items', {
      ...where,
      fields: LIST_FIELDS,
      startIndex: offset,
      limit: PAGE,
      enableTotalRecordCount: true,
    });
    const total = Number.isFinite(data.total) ? data.total : null;
    return {
      items: this.items(data.items),
      total,
      offset,
      nextOffset: data.items.length === PAGE && (total === null || offset + PAGE < total) ? offset + PAGE : null,
    };
  }
  async filters(section) {
    const where = await this.section(section);
    const genres = (await this.query('Genres', { parentId: where.parentId, sortBy: 'SortName' })).items
      .filter(genre => GUID.test(genre?.Id || '') && genre.Name)
      .map(genre => ({ id: genre.Id.toLowerCase(), title: text(genre.Name, 100) }));
    // Older and newer servers disagree on how years are listed; a library without them still browses.
    const years = await this.json('Items/Filters', {
      userId: await this.userId(),
      parentId: where.parentId,
      includeItemTypes: where.includeItemTypes,
    })
      .then(data => (Array.isArray(data?.Years) ? data.Years : []))
      .catch(() => []);
    return {
      genres,
      years: years
        .filter(value => /^\d{4}$/.test(String(value)))
        .map(value => ({ id: String(value), title: String(value) }))
        .sort((a, b) => Number(b.id) - Number(a.id)),
    };
  }
  mediaInfo(source) {
    const streams = source?.MediaStreams || [],
      video = streams.find(stream => stream.Type === 'Video'),
      audio =
        streams.find(stream => stream.Type === 'Audio' && stream.IsDefault) ||
        streams.find(stream => stream.Type === 'Audio');
    return [
      video?.Height ? video.Height + 'p' : '',
      video?.Codec,
      source?.Bitrate ? (source.Bitrate / 1000000).toFixed(1) + ' Mbps' : '',
      audio?.Codec,
      audio?.Channels ? audio.Channels + ' channels' : '',
      source?.Container,
    ]
      .filter(Boolean)
      .map(value => String(value).slice(0, 60));
  }
  async details(id) {
    const x = await this.one(jellyfinIdentity(id).itemId);
    const [item] = this.items([x]);
    if (!item) throw failure('Select a video from the library', 404);
    const people = type =>
      (x.People || [])
        .filter(person => person?.Type === type && person.Name)
        .map(person => text(person.Name, 100))
        .slice(0, 12);
    const ratings = [];
    if (Number(x.CommunityRating) >= 0 && Number(x.CommunityRating) <= 10 && x.CommunityRating != null)
      ratings.push({ source: 'Community', value: Number(x.CommunityRating) });
    if (Number(x.CriticRating) >= 0 && Number(x.CriticRating) <= 100 && x.CriticRating != null)
      ratings.push({ source: 'Critics', value: Number(x.CriticRating) / 10 });
    return {
      ...item,
      summary: text(x.Overview, 2000),
      directors: people('Director'),
      cast: people('Actor'),
      ratings,
      mediaInfo: this.mediaInfo(x.MediaSources?.[0]),
      otherEditions: [],
    };
  }
  async playableItem(id) {
    const x = await this.one(jellyfinIdentity(id).itemId);
    if (!['Movie', 'Episode'].includes(x.Type)) throw failure('Select a movie or episode');
    if (!this.playable(x) || !x.MediaSources?.length) throw unavailable(x);
    return { ...this.items([x])[0], id };
  }
  async availability(ids = []) {
    const status = new Map();
    const wanted = ids.filter(id => {
      try {
        jellyfinIdentity(id);
        return true;
      } catch {
        return false;
      }
    });
    for (let at = 0; at < wanted.length; at += 40) {
      const chunk = wanted.slice(at, at + 40);
      const { items } = await this.query('Items', {
        ids: [...new Set(chunk.map(id => jellyfinIdentity(id).itemId))].join(','),
        fields: 'Path',
        enableImages: false,
      });
      const found = new Map(items.map(x => [String(x.Id).toLowerCase(), x]));
      for (const id of chunk) {
        const x = found.get(jellyfinIdentity(id).itemId);
        status.set(id, !!x && this.playable(x));
      }
    }
    return status;
  }
  async episodes(seriesId, query = {}) {
    return (await this.query(`Shows/${guid(seriesId)}/Episodes`, { fields: LIST_FIELDS, isMissing: false, ...query }))
      .items;
  }
  async queueItems({ type, id, includeSpecials = false } = {}) {
    let list;
    if (type === 'show') list = await this.episodes(id);
    else if (type === 'season' || type === 'collection')
      list = (
        await this.query('Items', {
          parentId: guid(id),
          fields: LIST_FIELDS,
          sortBy: 'ParentIndexNumber,IndexNumber,SortName',
          limit: QUEUE_LIMIT,
        })
      ).items;
    else if (type === 'library') {
      const where = await this.section(id);
      const shows = where.includeItemTypes === 'Series';
      list = (
        await this.query('Items', {
          ...where,
          includeItemTypes: shows ? 'Episode' : 'Movie',
          fields: LIST_FIELDS,
          sortBy: shows ? 'SeriesSortName,ParentIndexNumber,IndexNumber' : 'SortName',
          limit: QUEUE_LIMIT,
        })
      ).items;
    } else throw failure('Select a show, season or library');
    return this.items(
      list.filter(
        x =>
          ['Movie', 'Episode'].includes(x?.Type) &&
          this.playable(x) &&
          (includeSpecials || x.Type !== 'Episode' || Number(x.ParentIndexNumber) !== 0),
      ),
    );
  }
  async neighbors(x) {
    if (x.Type !== 'Episode' || !GUID.test(x.SeriesId || '')) return {};
    const episodes = (await this.episodes(x.SeriesId, { fields: '', enableImages: false })).filter(
      episode => GUID.test(episode?.Id || '') && Number(episode.ParentIndexNumber) !== 0,
    );
    const index = episodes.findIndex(episode => episode.Id === x.Id);
    if (index < 0) return {};
    return {
      previousId: episodes[index - 1]?.Id.toLowerCase(),
      nextId: episodes[index + 1]?.Id.toLowerCase(),
    };
  }
  async artwork(id, kind = 'poster') {
    const widths = { poster: 300, landscape: 400, backdrop: 1280, logo: 720 };
    if (!Object.hasOwn(widths, kind)) throw failure('Invalid artwork', 400);
    const key = jellyfinIdentity(id).itemId;
    if (!this.art.has(key)) this.items([await this.one(key, 'Path')]);
    const width = widths[kind],
      source = this.art.get(key)?.[kind];
    if (!source) throw failure('Artwork unavailable', 404);
    const response = await this.request(
      this.path(`Items/${guid(source.id)}/Images/${source.type}`, {
        maxWidth: width,
        quality: 85,
      }),
      { headers: { Accept: 'image/*' } },
    );
    const type = response.headers.get('content-type') || '';
    if (!/^image\/(jpeg|png|webp)\b/.test(type)) throw failure('Artwork unavailable', 404);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > ART_LIMIT) throw failure('Artwork unavailable', 404);
    return { type: type.split(';')[0], bytes };
  }
  // Whether the configured user may see an item, remembered briefly so a page of
  // posters does not ask the server once for each.
  async allows(id) {
    let key;
    try {
      key = jellyfinIdentity(id).itemId;
    } catch {
      return false;
    }
    const known = this.seen.get(key);
    if (known && Date.now() - known.at < 60000) return known.ok;
    try {
      await this.one(key, 'Path');
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }
  visible(id) {
    return this.allows(id);
  }
  // Delivery
  prepare(id, quality, compatible = false, source, fallback, choices = {}) {
    return prepareStream(this, id, quality, compatible, source, fallback, choices);
  }
  tracks(itemId, source) {
    const sources = [];
    for (const stream of source.MediaStreams || []) {
      const kind = stream.Type === 'Audio' ? 'audio' : stream.Type === 'Subtitle' ? 'subtitles' : undefined;
      if (!kind || !Number.isSafeInteger(stream.Index)) continue;
      const raw = String(stream.Codec || '').toLowerCase(),
        codec = CODECS[raw] || raw;
      const described = {
        kind,
        id: (kind === 'audio' ? 'a' : 's') + stream.Index,
        codec,
        language: stream.Language,
        title: stream.Title,
        label: stream.DisplayTitle || stream.Title || stream.Language,
        default: stream.IsDefault === true,
        forced: stream.IsForced === true,
        sdh: stream.IsHearingImpaired === true,
        channels: stream.Channels,
      };
      if (stream.IsExternal === true) {
        // A sidecar is offered only in a form the server hands over unchanged.
        const extension = kind === 'subtitles' && SIDECARS[codec];
        if (!extension) continue;
        const base = `Videos/${itemId}/${encodeURIComponent(source.Id)}/Subtitles/${stream.Index}/Stream.`;
        sources.push({
          ...described,
          resources: {
            data: this.path(base + extension),
            ...(['subrip', 'webvtt'].includes(codec) ? { text: this.path(base + 'vtt') } : {}),
          },
        });
      } else sources.push({ ...described, index: stream.Index });
    }
    return sources;
  }
  async source(id, previous, choices = {}) {
    const { itemId, sourceId } = jellyfinIdentity(id);
    const x = await this.one(itemId);
    if (!['Movie', 'Episode'].includes(x.Type)) throw failure('Select a movie or episode');
    const versions = Array.isArray(x.MediaSources) ? x.MediaSources : [];
    const source = sourceId ? versions.find(candidate => candidate?.Id === sourceId) : versions[0];
    if (!this.playable(x) || !source || typeof source.Id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(source.Id))
      throw unavailable(x);
    const streams = source.MediaStreams || [],
      video = streams.find(stream => stream.Type === 'Video'),
      audio = streams.filter(stream => stream.Type === 'Audio');
    const duration = seconds(source.RunTimeTicks) || seconds(x.RunTimeTicks);
    if (!video || !(duration > 0)) throw new PlaybackError('This item could not be read as a video.');
    const range = String(video.VideoRangeType || '').toUpperCase();
    const hdr = classifyHdr({
      color_transfer: video.ColorTransfer,
      DOVIPresent: range.startsWith('DOVI') || undefined,
      DOVIProfile: video.DvProfile ?? undefined,
      DOVIBLCompatID: video.DvBlSignalCompatibilityId ?? undefined,
    });
    const chapters = (Array.isArray(x.Chapters) ? x.Chapters : [])
      .map(chapter => seconds(chapter?.StartPositionTicks))
      .map((start, index, starts) => ({
        id: String(index + 1),
        index: index + 1,
        title: text(x.Chapters[index]?.Name, 100) || 'Chapter ' + (index + 1),
        startTime: Math.round(start * 1000) / 1000,
        endTime: Math.round((starts[index + 1] > start ? starts[index + 1] : duration) * 1000) / 1000,
      }))
      .sort((a, b) => a.startTime - b.startTime);
    const same = previous && previous.principal === this.principal && previous.kind === this.kind;
    const media = {
      title: text(x.Name) || 'Untitled',
      subtitle: this.subtitle(x),
      duration,
      kind: this.kind,
      type: TYPES[x.Type],
      resources: new Map(),
      id,
      principal: this.principal,
      provider: this,
      videoCodec: String(video.Codec || '').toLowerCase() || undefined,
      audioCodec: String((audio.find(stream => stream.IsDefault) || audio[0])?.Codec || '').toLowerCase() || undefined,
      hdr: hdr.hdr,
      hdrKind: hdr.kind,
      hdrLabel: hdr.label,
      doviProfile: hdr.doviProfile,
      bitDepth: Number(video.BitDepth) || (hdr.hdr ? 10 : 8),
      sourceHdr: hdr.hdr,
      sourceHdrKind: hdr.kind,
      sourceHdrLabel: hdr.label,
      sourceBitrate: Math.round(Number(source.Bitrate) / 1000) || undefined,
      sourceWidth: Number(video.Width) || undefined,
      sourceHeight: Number(video.Height) || undefined,
      chapters,
      markers: [],
      ...(same ? { previousId: previous.previousId, nextId: previous.nextId } : await this.neighbors(x)),
    };
    media.tracks = Tracks.catalog(this.tracks(itemId, source), {
      browserSubtitles: choices.browserSubtitles,
      extractSubtitles: !!this.pipeline.av1.ffmpeg,
    });
    media.selection = Tracks.select(media.tracks, choices);
    media.sourceStart = this.path(`Videos/${itemId}/stream`, { static: true, mediaSourceId: source.Id });
    media.sourceKey = JSON.stringify([this.base.href, itemId, source.Id, source.Size, source.ETag]);
    media.captionVersion = randomUUID();
    media.subtitleAbort = new AbortController();
    return { media, detail: {} };
  }
  stop(media) {
    return runOperation(undefined, () => this.pipeline.release(media));
  }
  close() {
    this.art.clear();
    this.seen.clear();
  }
}

/**
 * The configured Jellyfin server as a media provider, or nothing when none is configured.
 * @param {{config: any, pipeline: any, registry?: any, logger?: any, fetcher?: typeof fetch}} services
 * @returns {import('./media-providers').MediaProvider | undefined}
 */
function jellyfinProvider({ config, pipeline, registry, logger, fetcher }) {
  if (!config.jellyfin?.url) return;
  const jellyfin = new Jellyfin(config.jellyfin, { pipeline, registry, logger, fetcher });
  return { kind: 'jellyfin', root: jellyfin, identity: () => jellyfin.identity(), scopeFor: async () => jellyfin };
}

module.exports = { Jellyfin, jellyfinProvider, jellyfinIdentity };
