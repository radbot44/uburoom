// @ts-check
'use strict';

/**
 * The contract between uburoom and a place media comes from. Nothing outside a
 * provider's own files may assume its item IDs, URLs, credentials or wire format.
 *
 * A configured provider is one entry of the registry (server/media-providers.js),
 * recorded under one stable server id. It is seen through a scope: the provider as
 * one person may use it. Every prepared media object carries the scope that prepared
 * it as `media.provider`, and the pipeline (server/media-pipeline.js) reads bytes only
 * through that scope, so a viewer's authorization travels with their stream.
 *
 * A scope has three parts. Rooms call the catalog; the pipeline calls delivery; a
 * provider with no transcode of its own leaves the optional delivery members out.
 *
 * @typedef {Object} ProviderScope
 *
 * Identity
 * @property {string} kind - The provider's kind, recorded on what it prepares.
 * @property {boolean} configured - Whether this provider can be asked for anything yet.
 * @property {string} principal - Stable identity of the credential behind this scope.
 *   Room code compares it before and after slow work to notice access that changed meanwhile.
 * @property {any} pipeline - The pipeline this provider's media plays through.
 *
 * Catalog
 * @property {(query: Record<string,string>) => Promise<{items: CatalogItem[], total: number|null, offset: number, nextOffset: number|null}>} browse
 *   One page of a library location. With no location, the provider's libraries as items of type 'library'.
 * @property {(section: string) => Promise<{genres: {id: string, title: string}[], years: {id: string, title: string}[]}>} filters
 *   The values a library can be narrowed by; empty lists when it has none.
 * @property {(id: string, type?: string) => Promise<CatalogItem & Record<string, any>>} details
 *   One item with what its page shows: summary, people, ratings, `mediaInfo`, `otherEditions`,
 *   and for an episode the `showId` it belongs to.
 * @property {(id: string) => Promise<CatalogItem>} playableItem
 *   The movie or episode a selector names, refusing anything else. A missing file fails
 *   with `code: 'MEDIA_UNAVAILABLE'`.
 * @property {(ids: string[]) => Promise<Map<string, boolean>>} availability
 *   Whether each item's file can be read now. An item the provider cannot answer for is left out.
 * @property {(scope: {type: string, id: string, includeSpecials?: boolean}) => Promise<CatalogItem[]>} queueItems
 *   Every playable item of a show, season, library or collection, in playing order.
 * @property {(id: string, kind?: 'poster'|'landscape', type?: string) => Promise<{type: string, bytes: Buffer}>} artwork
 *   An item's picture, already bounded in size.
 * @property {(id: string) => Promise<boolean>} allows - Whether this scope may watch an item.
 * @property {(id: string, type?: string) => Promise<boolean>} visible - Whether this scope may see an item at all.
 * @property {(mediaId: string) => Promise<any>} [nextEpisodeOffer]
 *   The episode that follows one that just ended, for providers that know series order.
 *
 * Delivery
 * @property {(resource: string) => URL} url - Resolve a provider resource, refusing anything outside the provider.
 * @property {(resource: string, options?: {signal?: AbortSignal, method?: string, headers?: Record<string,string>, streaming?: boolean}) => Promise<Response>} request
 *   Read a provider resource with this scope's credential, honouring a `Range` header.
 *   The pipeline never sees the credential.
 * @property {(id: string, quality: string, compatible?: boolean, previous?: any, fallback?: string, choices?: any) => Promise<PreparedMedia>} prepare
 *   One viewer's stream of one item; providers delegate to `prepareStream` (server/media-delivery.js).
 * @property {(id: string, previous?: any, choices?: any) => Promise<{media: PreparedMedia, detail: any}>} source
 *   What an item is and where its bytes are; see server/media-delivery.js.
 * @property {(media: any) => Promise<any>} stop
 *   Release a prepared media object: `pipeline.release(media, own)`, where `own` ends
 *   whatever the provider itself started.
 * @property {(media: any, detail: any, request: any) => Promise<void>} [startTranscode]
 *   Start the provider's own transcode of a prepared source; absent when it has none.
 * @property {(media: any, options?: {session?: boolean}) => Record<string,string>} [sessionHeaders]
 *   Headers that identify one of the provider's own transcode sessions on requests for its output.
 * @property {(media: any) => Promise<boolean>} [ping] - Keep the provider's own transcode alive.
 * @property {() => Promise<boolean>} [videoConversionDisabled]
 *   Whether the provider's own setting forbids video conversion; absent when it has no such setting.
 * @property {(inUse: Set<string>) => Promise<any>} [reconcileSessions]
 *   End provider transcodes uburoom started and no longer holds. Called on the configured scope only.
 * @property {() => Promise<any>} [close] - Called on the configured scope at shutdown.
 */

/**
 * An item as the library shows it. `id` is an opaque media selector
 * (shared/room-protocol.mjs `mediaIdentity`) that only its own provider interprets.
 * @typedef {Object} CatalogItem
 * @property {string} id
 * @property {'movie'|'episode'|'show'|'season'|'collection'|'library'} type
 * @property {string} title
 * @property {string} [subtitle] - The line under the title: year, edition, or show, season and episode.
 * @property {number} [duration] - Seconds.
 * @property {boolean} [available] - For a movie or episode, whether its file can be read.
 * @property {boolean} [hasPoster]
 * @property {boolean} [hasLandscape]
 * @property {string} [parentId] - The season an episode belongs to.
 * @property {string} [showId] - The show an episode or season belongs to.
 * @property {number} [index] - Episode or season number.
 */

/**
 * What `source()` returns and delivery completes. The fields below are the ones
 * shared code reads; a provider may keep more for its own use.
 * @typedef {Object} PreparedMedia
 * @property {string} id - The selector it was prepared from.
 * @property {string} kind
 * @property {'movie'|'episode'} type
 * @property {string} title
 * @property {string} [subtitle]
 * @property {number} duration - Seconds.
 * @property {ProviderScope} provider - The scope that prepared it.
 * @property {string} principal - That scope's principal.
 * @property {Map<string,string>} resources - Provider resources handed to a viewer under opaque keys.
 * @property {string} sourceStart - The provider resource of the whole original file.
 * @property {string} sourceKey - Identifies these exact bytes, so identical outputs can be shared.
 * @property {number} [sourceBitrate] - kbit/s.
 * @property {number} [sourceWidth]
 * @property {number} [sourceHeight]
 * @property {string} [videoCodec]
 * @property {string} [audioCodec]
 * @property {{audio: any[], subtitles: any[]}} tracks - `Tracks.catalog` of its `TrackSource`s (server/media-tracks.js).
 * @property {any} selection - `Tracks.select` of those tracks for this viewer.
 * @property {any[]} chapters
 * @property {any[]} markers
 * @property {string} captionVersion
 * @property {AbortController} subtitleAbort
 * @property {string} [previousId] - The item before this one, for providers that know an order.
 * @property {string} [nextId]
 */

/** Media a provider prepared or recorded, as opposed to the built-in demo. */
const fromProvider = media => !!media && media.kind !== 'demo';

module.exports = { fromProvider };
