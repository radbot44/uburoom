// @ts-check
'use strict';

/**
 * The contract between uburoom and a place media comes from. Plex is the only
 * implementation today (server/plex.js); nothing outside a provider's own files
 * may assume its item IDs, URLs, credentials or wire format.
 *
 * A provider is seen through a scope: the provider as one credential may use it.
 * Every prepared media object carries the scope that prepared it as
 * `media.provider`, and the pipeline (server/media-pipeline.js) reads bytes only
 * through that scope, so a viewer's authorization travels with their stream.
 *
 * @typedef {Object} ProviderScope
 * @property {string} principal - Stable identity of the credential behind this scope.
 * @property {(resource: string) => URL} url - Resolve a provider resource, refusing anything outside the provider.
 * @property {(resource: string, options?: {signal?: AbortSignal, method?: string, headers?: Record<string,string>, streaming?: boolean}) => Promise<Response>} request
 *   Read a provider resource with this scope's credential. The pipeline never sees the credential.
 * @property {(media: any) => Promise<any>} stop - Release whatever the provider holds for a prepared media object.
 * @property {(media: any, options?: {session?: boolean}) => Record<string,string>} [sessionHeaders]
 *   Headers that identify one of the provider's own transcode sessions on requests for its output.
 * @property {(id: string, previous?: any, choices?: any) => Promise<{media: any, detail: any}>} [source]
 *   What an item is and where its bytes are; see server/media-delivery.js.
 * @property {(media: any, detail: any, request: any) => Promise<void>} [startTranscode]
 *   Start the provider's own transcode of a prepared source; absent when it has none.
 * @property {() => Promise<boolean>} [videoConversionDisabled]
 *   Whether the provider's own setting forbids video conversion; absent when it has no such setting.
 */

/** Media a provider prepared or recorded, as opposed to the built-in demo. */
const fromProvider = media => !!media && media.kind !== 'demo';

module.exports = { fromProvider };
