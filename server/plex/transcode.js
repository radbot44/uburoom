'use strict';
const { randomUUID } = require('node:crypto');
const { QUALITIES, qualityId } = require('../../shared/engine.mjs');
const { PlaybackError } = require('../av1');
const Sources = require('../plex-source');
const { mediaIdentity } = require('../../shared/room-protocol.mjs');
const { runOperation } = require('../operation');

// Transcode decision: offered qualities, Plex transcode parameters, audio and subtitle
// selection for conversion, and the local outputs a viewer can use.
class PlexTranscode {
  constructor(plex) {
    this.plex = plex;
  }
  qualities(media) {
    const original = !media?.unavailable && media?.source && Sources.select(media.source, media.sourceSelection).media;
    return this.plex.qualityOptions
      .filter(
        q =>
          !q.bitrate ||
          ((!original?.bitrate || q.bitrate <= original.bitrate) &&
            (!original?.height || q.height <= Math.max(original.height, ((original.width || 0) * 9) / 16))),
      )
      .map(q =>
        q.id === 'direct' && original?.bitrate > 0
          ? { ...q, label: 'Original · ' + Math.round(original.bitrate / 1000) + ' Mbps' }
          : q,
      );
  }
  maxTranscodeQuality() {
    return this.plex.qualityOptions.find(q => q.id !== 'direct') || QUALITIES[1];
  }
  // The one recipe for a Plex HLS session, used to start playback and to ask Plex
  // beforehand whether it would.
  transcodeParams({ ratingKey, selected, original, quality, session, audio, burn, directStream }) {
    const maxTranscode = this.plex.maxTranscodeQuality();
    const maxBitrate =
      quality === 'direct'
        ? directStream
          ? Math.max(20000, original.bitrate || 0)
          : Math.min(maxTranscode?.bitrate || 20000, Math.max(2000, original.bitrate || maxTranscode?.bitrate || 20000))
        : this.plex.qualityOptions.find(q => q.id === qualityId(quality))?.bitrate || 4000;
    const sourceVideo =
      original?.videoCodec || selected?.part?.Stream?.find(x => Number(x.streamType) === 1)?.codec || '';
    const videoCodecs = directStream && /^(hevc|h265|hvc1|hev1)$/i.test(sourceVideo) ? 'h264,hevc' : 'h264';
    const params = new URLSearchParams({
      path: `/library/metadata/${ratingKey}`,
      mediaIndex: String(selected.mediaIndex),
      partIndex: String(selected.partIndex),
      protocol: 'hls',
      directPlay: '0',
      directStream: directStream ? '1' : '0',
      fastSeek: '1',
      hasMDE: '1',
      offset: '0',
      session,
      subtitles: burn ? 'burn' : 'none',
      audioBoost: '100',
      'X-Plex-Client-Identifier': session,
      'X-Plex-Session-Identifier': session,
      maxVideoBitrate: String(maxBitrate),
      videoQuality: '100',
      'X-Plex-Client-Profile-Name': 'Generic',
      'X-Plex-Client-Profile-Extra':
        'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=' +
        videoCodecs +
        '&audioCodec=aac)',
    });
    if (audio) params.set('audioStreamID', audio.id);
    params.set('audioChannelCount', '2');
    if (burn) {
      params.set('advancedSubtitles', 'burn');
      params.set('subtitleSize', '100');
    }
    if (quality !== 'direct') {
      const q = this.plex.qualityOptions.find(q => q.id === qualityId(quality));
      params.set('videoResolution', `${q.width}x${q.height}`);
    } else if (!directStream && maxTranscode?.width && maxTranscode?.height) {
      params.set('videoResolution', `${maxTranscode.width}x${maxTranscode.height}`);
    }
    return params;
  }
  /**
   * Ask Plex whether it would play this item at a quality, without starting a session.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async startDecision(media, quality) {
    const { ratingKey } = mediaIdentity(this.plex.id(media.id)),
      selected = Sources.select(media.source, media.sourceSelection);
    const params = this.plex.transcodeParams({
      ratingKey,
      selected,
      original: selected.media,
      quality,
      session: randomUUID(),
      directStream: quality === 'direct',
    });
    const decision = await (media.plexContext || this.plex).json('/video/:/transcode/universal/decision?' + params);
    const code = Number(decision.generalDecisionCode),
      playable = !!decision.Metadata?.[0]?.Media?.[0]?.Part?.length;
    if (playable && !(code >= 2000)) return { ok: true };
    return {
      ok: false,
      reason: String(decision.transcodeDecisionText || decision.generalDecisionText || 'Plex gave no reason.').slice(
        0,
        300,
      ),
    };
  }
  async selectAudioForTranscode(media, choices) {
    const requested = media.selection.audio?.id;
    if (!requested) return;
    // PMS chooses audio from the scoped user's part selection, ignoring the
    // universal audioStreamID hint on some versions. Capture a private session
    // under the part lock, then restore the preference before releasing it.
    const read = async () =>
      Sources.select(
        (await this.plex.json('/library/metadata/' + mediaIdentity(media.id).ratingKey)).Metadata?.[0] || {},
        media.sourceSelection,
      ).part;
    const selected = (part, confirming = false) => {
      const message = confirming
        ? 'Plex could not confirm its saved audio preference.'
        : 'Plex did not identify its current audio selection.';
      if (
        !part ||
        String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1]) !== media.partId ||
        !Array.isArray(part.Stream)
      )
        throw new PlaybackError(message);
      const audioRows = part.Stream.filter(s => Number(s.streamType) === 2);
      const rows = audioRows.filter(s => [true, 1, '1'].includes(s.selected));
      if (rows.length > 1 || (rows.length === 1 && rows[0].id == null)) throw new PlaybackError(message);
      if (rows.length === 1) return { id: String(rows[0].id), explicit: true };
      const fallback =
        audioRows.find(s => [true, 1, '1'].includes(s.default) && s.id != null) || audioRows.find(s => s.id != null);
      if (!fallback) throw new PlaybackError(message);
      return { id: String(fallback.id), explicit: false };
    };
    const part = await read();
    if (
      !part ||
      String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1]) !== media.partId ||
      !part.Stream?.some(s => Number(s.streamType) === 2 && String(s.id) === requested)
    )
      throw new PlaybackError('The requested audio no longer belongs to this source.');
    const previous = selected(part);
    const original = previous.id;
    if (original === requested) return;
    const set = id =>
      this.plex.request('/library/parts/' + media.partId + '?' + new URLSearchParams({ audioStreamID: id }), {
        method: 'PUT',
      });
    const restore = async () => {
      const current = selected(await read(), true);
      // Respect a selection changed by another Plex app in the meantime.
      if (current.explicit && current.id === requested) {
        await set(original);
        const restored = selected(await read(), true);
        if (!restored.explicit || restored.id !== original)
          throw new PlaybackError('Plex could not restore its saved audio preference.');
      }
    };
    if (choices.authorized && !(await choices.authorized()))
      throw new PlaybackError('Viewing access or track selection expired.');
    try {
      await set(requested);
      const confirmed = selected(await read());
      if (!confirmed.explicit || confirmed.id !== requested)
        throw new PlaybackError('Plex did not select the requested audio.');
    } catch (error) {
      await restore();
      throw error;
    }
    return restore;
  }
  // Configured outputs this viewer can use, in priority order. Without a working
  // hardware encoder, a local codec waits behind Plex rather than loading the CPU.
  async usableOutputs(localCodecs = []) {
    const configured = this.plex.conversionPolicy.settings?.outputs || ['plex'],
      usable = [];
    for (const [index, output] of configured.entries()) {
      if (output === 'plex') {
        usable.push(output);
        continue;
      }
      if (!this.plex.av1.ffmpeg || !localCodecs.includes(output)) continue;
      try {
        const encoder = await this.plex.av1.selectEncoder(output);
        if (
          encoder !== 'software' ||
          this.plex.av1.encoder === 'software' ||
          !configured.slice(index + 1).includes('plex')
        )
          usable.push(output);
      } catch {
        /* An output with no working encoder is skipped. */
      }
    }
    return usable;
  }
  async selectSubtitleForBurn(media, choices) {
    // PMS uses this user's stored part selection for burn-in. Hold the part
    // lock through decision AND session start so another viewer cannot replace
    // it before this conversion has captured its intended source stream.
    const read = async () =>
      Sources.select(
        (await this.plex.json('/library/metadata/' + mediaIdentity(media.id).ratingKey)).Metadata?.[0] || {},
        media.sourceSelection,
      ).part;
    const part = await read(),
      requested = media.selection.subtitle.id;
    if (
      !part ||
      String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1]) !== media.partId ||
      !part.Stream?.some(s => Number(s.streamType) === 3 && String(s.id) === requested)
    )
      throw new PlaybackError('The requested subtitle no longer belongs to this source.');
    const selected = part => {
      if (
        !part ||
        String(part.id || /^\/library\/parts\/(\d+)\//.exec(part.key || '')?.[1]) !== media.partId ||
        !Array.isArray(part.Stream)
      )
        throw new PlaybackError('Plex could not confirm its saved subtitle preference.');
      const rows = part.Stream.filter(s => Number(s.streamType) === 3 && [true, 1, '1'].includes(s.selected));
      if (rows.length > 1 || (rows.length === 1 && rows[0].id == null))
        throw new PlaybackError('Plex could not identify one saved subtitle preference.');
      return rows.length ? String(rows[0].id) : '0';
    };
    const original = selected(part);
    if (original === requested) return;
    const set = id =>
      this.plex.request('/library/parts/' + media.partId + '?' + new URLSearchParams({ subtitleStreamID: id }), {
        method: 'PUT',
      });
    const restore = async () => {
      // Respect a newer preference from another Plex app. Selection checks
      // and writes are separate requests; re-read just before restoring.
      if (selected(await read()) !== requested) return;
      await set(original);
      if (selected(await read()) !== original)
        throw new PlaybackError('Plex could not restore its saved subtitle preference.');
    };
    if (choices.authorized && !(await choices.authorized()))
      throw new PlaybackError('Viewing access or track selection expired.');
    try {
      await set(requested);
      if (selected(await read()) !== requested) throw new PlaybackError('Plex did not select the requested subtitle.');
    } catch (error) {
      await runOperation(undefined, restore);
      throw error;
    }
    return restore;
  }
}

module.exports = { PlexTranscode };
