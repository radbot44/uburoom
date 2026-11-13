// @ts-check
'use strict';
/** @typedef {import('../types').Room} Room */
/** @typedef {import('../types').Viewer} Viewer */
/** @typedef {import('../types').Actor} Actor */
/** @typedef {import('../types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('../types').EngineCommand} EngineCommand */
/** @typedef {{room: Room, kind: 'preload'|'transition'|'cleanup', controller: AbortController, signal: AbortSignal, committing: boolean, promise: Promise<any>}} MediaWork */
/** @typedef {{countdown: any, mediaId: string, startAt: number, viewers: Map<string, any>, work?: MediaWork, dropped?: boolean, media?: any, fallbackStream?: InstanceType<typeof import('../fallback-stream').FallbackStream>, source?: Promise<any>}} Preload */

const { randomUUID } = require('node:crypto');
const Engine = require('../../shared/engine');
const { PlaybackError } = require('../av1');
const Tracks = require('../media-tracks');
const SubtitleResources = require('../subtitle-resources');
const { expired } = require('./common');

/**
 * A viewer's personal commands: quality, audio and subtitles, stream refresh and player settings.
 * Methods of Watch (server/watch.js), which composes these modules onto its prototype.
 */
module.exports = {
  /**
   * A viewer's own stream change (quality, tracks, refresh) runs outside the mailbox;
   * `viewer.change` is the handle on it while it runs, and a second change waits for it.
   * @param {Viewer} viewer
   * @param {() => Promise<any>} run
   */
  changeStream(viewer, run) {
    if (viewer.preparing || viewer.change)
      return { status: 'unavailable', message: 'Wait for your stream to finish loading.' };
    const change = run();
    viewer.change = change;
    const clear = () => {
      if (viewer.change === change) viewer.change = undefined;
    };
    change.then(clear, clear);
    return () => change;
  },
  /** A personal command for the actor's own tab: quality, tracks, stream, player or reporting. */
  personal(room, command, declared, actor, ticket) {
    const { action, args } = command;
    const viewer = room.viewers.get(actor.watchViewerId);
    if (!viewer || viewer.userId !== actor.userId)
      return { status: 'unsupported', message: 'Use your watch player for personal audio and quality.' };
    if (declared.handler === 'tracks') return this.changeTracks(room, viewer, args, actor, ticket);
    if (declared.handler === 'stream') return this.refreshStream(room, viewer, args, actor, ticket);
    if (declared.handler === 'quality') {
      if (!args.compatible && !args.fallback && args.quality) viewer.preferredQuality = Engine.qualityId(args.quality);
      if (!room.media || room.media.kind === 'demo')
        return { status: 'applied', message: 'Preferred quality updated for future videos.' };
      if (viewer.preparing || viewer.change)
        return { status: 'unavailable', message: 'Wait for your stream to finish loading.' };
      if (args.reset) {
        viewer.fallback = undefined;
        viewer.compatible = false;
      }
      const fallback = args.fallback || viewer.fallback;
      if (args.fallback)
        this.hub?.config?.logger?.info(
          'Delivery',
          `Viewer "${viewer.name || actor.userId}" moving to ${args.fallback}: ${args.reason || 'no reason given'}`,
        );
      return this.changeStream(viewer, async () => {
        try {
          const result = await this.replaceViewer(
            room,
            actor,
            actor.watchViewerId,
            async (authorized, source) =>
              this.prepareQuality(
                room,
                viewer,
                await (this.hub.plexFor ? this.hub.plexFor(actor) : this.plex),
                source,
                args.quality,
                args.compatible === true || !!viewer.compatible,
                fallback,
                authorized,
              ),
            { ticket },
          );
          if (result.status !== 'applied') {
            this.hub?.config?.logger?.warn(
              'Delivery',
              `Quality change not applied: ${result.message || result.status}`,
            );
            return result;
          }
          viewer.quality = viewer.media.quality;
          viewer.compatible = args.compatible === true || !!viewer.compatible;
          viewer.fallback = fallback;
          return this.playerUpdated(room, viewer);
        } catch (error) {
          if (error instanceof PlaybackError) {
            this.hub?.config?.logger?.warn('Delivery', `Quality change failed: ${error.message}`);
            return { status: 'failed', message: error.message };
          }
          throw error;
        }
      });
    }
    if (declared.handler === 'player') {
      if (action === 'media.volume.set') {
        viewer.volume = args.percent;
        viewer.muted = false;
      } else viewer.muted = action === 'media.mute';
    } else if (declared.handler === 'reporting') {
      if (typeof args.activity === 'boolean') viewer.plexReporting = args.activity;
      if (typeof args.watchState === 'boolean') viewer.plexWatchState = args.watchState;
      this.reporting?.updateConsent(viewer, { activity: viewer.plexReporting, watchState: viewer.plexWatchState });
      return {
        status: 'applied',
        message: 'Your reporting preferences updated.',
        state: Engine.snapshot({ ...room.state, volume: viewer.volume, muted: viewer.muted }),
        plexReporting: {
          eligible: !!this.reporting?.isEligible(actor.userId),
          activity: viewer.plexReporting !== false,
          watchState: !!(viewer.plexWatchState && this.hub?.config?.plexReporting?.watchState !== false),
          watchStateAllowed: this.hub?.config?.plexReporting?.watchState !== false,
        },
      };
    }
    return this.playerUpdated(room, viewer);
  },
  playerUpdated(room, viewer) {
    return {
      status: 'applied',
      message: 'Your player updated.',
      state: Engine.snapshot({ ...room.state, volume: viewer.volume, muted: viewer.muted }),
    };
  },
  changeTracks(room, viewer, args, actor, ticket) {
    const current = viewer.media,
      version = room.mediaVersion;
    if (!current?.tracks || current.kind !== 'plex')
      return { status: 'unsupported', message: 'Audio and subtitles are unavailable for this video.' };
    if (viewer.preparing || viewer.change)
      return { status: 'unavailable', message: 'Wait for your stream to finish loading.' };
    if (args.mediaVersion !== version || args.streamVersion !== viewer.streamVersion)
      return { status: 'unavailable', message: 'Track selection expired. Choose again for the current video.' };
    return this.changeStream(viewer, () => this.applyTracks(room, viewer, args, actor, ticket, current, version));
  },
  async applyTracks(room, viewer, args, actor, ticket, current, version) {
    const choices = {
      ...viewer.trackChoice,
      audioId: args.audioId ?? viewer.trackChoice?.audioId ?? 'auto',
      subtitleId: args.subtitleId ?? viewer.trackChoice?.subtitleId ?? 'auto',
      subtitleMode: args.subtitleMode ?? viewer.trackChoice?.subtitleMode ?? 'auto',
    };
    if (args.audioId === 'auto') choices.audioIntent = undefined;
    if (['auto', 'off'].includes(args.subtitleId)) choices.subtitleIntent = undefined;
    let selection;
    try {
      selection = Tracks.select(current.tracks, choices);
      if (selection.subtitle?.delivery === 'burn' && args.subtitleOffset !== undefined && args.subtitleOffset !== 0)
        throw new PlaybackError('Burned subtitles cannot be shifted in this player.');
      if (args.audioId && args.audioId !== 'auto') choices.audioIntent = Tracks.intent(selection.audio);
      if (args.subtitleId && !['auto', 'off'].includes(args.subtitleId))
        choices.subtitleIntent = Tracks.intent(selection.subtitle);
      const burnChanged =
        (selection.subtitle?.delivery === 'burn' || current.selection.subtitle?.delivery === 'burn') &&
        (selection.subtitle?.id !== current.selection.subtitle?.id ||
          selection.subtitle?.delivery !== current.selection.subtitle?.delivery);
      if (selection.audio?.id !== current.selection.audio?.id || burnChanged || current.playbackError) {
        const result = await this.replaceViewer(
          room,
          actor,
          actor.watchViewerId,
          async (authorized, source) =>
            this.prepareQuality(
              room,
              viewer,
              await (this.hub.plexFor ? this.hub.plexFor(actor) : this.plex),
              source,
              viewer.quality,
              viewer.compatible,
              viewer.fallback,
              {
                ...choices,
                browserSubtitles: viewer.browserSubtitles,
                localCodecs: viewer.localCodecs,
                shareKey: [room.roomId, version],
                authorized,
              },
            ),
          { ticket },
        );
        if (result.status !== 'applied') return result;
      } else {
        const alive = !viewer.alive || (await viewer.alive()),
          access = await this.canView(room, actor);
        // Back in the mailbox: the new selection applies only to the same stream.
        const applied = await this.inRoom(
          room,
          () => {
            if (
              !alive ||
              !access ||
              !this.hub.current(ticket) ||
              version !== room.mediaVersion ||
              viewer.media !== current ||
              room.viewers.get(actor.watchViewerId) !== viewer
            )
              return false;
            if (selection.subtitle?.id !== current.selection.subtitle?.id) {
              current.subtitleAbort.abort();
              current.subtitleAbort = new AbortController();
              current.subtitleCache?.clear();
              SubtitleResources.clear(current);
              current.captionVersion = randomUUID();
            }
            current.selection = selection;
            return true;
          },
          false,
        );
        if (!applied) return expired();
      }
      viewer.trackChoice = choices;
      if (selection.subtitle?.delivery === 'burn') viewer.subtitleOffset = 0;
      else if (args.subtitleOffset !== undefined) viewer.subtitleOffset = args.subtitleOffset;
      return { status: 'applied', message: 'Your audio and subtitles updated.' };
    } catch (error) {
      return {
        status: 'failed',
        message:
          error instanceof PlaybackError
            ? error.message
            : 'Audio and subtitles could not be updated. Your previous selection is unchanged.',
      };
    }
  },
  refreshStream(room, viewer, args, actor, ticket) {
    const current = viewer.media,
      version = room.mediaVersion;
    if (!current || current.kind !== 'plex' || !room.media || current.format !== 'hls')
      return { status: 'unsupported', message: 'This stream cannot be refreshed.' };
    if (viewer.preparing || viewer.change)
      return { status: 'unavailable', message: 'Wait for your stream to finish loading.' };
    if (args.mediaVersion !== version || args.streamVersion !== viewer.streamVersion)
      return { status: 'unavailable', message: 'Stream refresh expired.' };
    return this.changeStream(viewer, async () => {
      try {
        const result = await this.replaceViewer(
          room,
          actor,
          actor.watchViewerId,
          async (authorized, source) =>
            this.prepareQuality(
              room,
              viewer,
              await (this.hub.plexFor ? this.hub.plexFor(actor) : this.plex),
              source,
              viewer.quality,
              viewer.compatible,
              viewer.fallback,
              {
                ...viewer.trackChoice,
                browserSubtitles: viewer.browserSubtitles,
                shareKey: [room.roomId, version],
                excludeLease: current.hlsLease,
                authorized,
              },
            ),
          { ticket, accept: media => media.format === 'hls' },
        );
        return result.status === 'applied' ? { status: 'applied', message: 'Your stream refreshed.' } : result;
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof PlaybackError ? error.message : 'Plex could not refresh this stream.',
        };
      }
    });
  },
};
