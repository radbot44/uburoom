'use strict';
const { randomBytes } = require('node:crypto');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { discordRequest, retryDelay } = require('./discord-request');
const { waitFor } = require('./operation');
const fail = (message, status = 503) => Object.assign(new Error(message), { status });
const PREFIX = 'discordPublication:';
const clean = (value, length = 256) =>
  String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, length);
const markdown = value => clean(value, 256).replace(/([\\`*_{}\[\]()<>#+.!|~])/g, '\\$1');

// Discord is a projection of room state. It never participates in the playback
// tick or owns entry/media authorization. Persist message identities in the
// existing worker-backed metadata store, including uncertain create receipts.
class DiscordPublications {
  constructor(watch, registry) {
    this.watch = watch;
    this.hub = watch.hub;
    this.config = this.hub.config;
    this.registry = registry;
    this.records = new Map(
      registry.db
        .prepare('SELECT key,value FROM meta WHERE key LIKE ?')
        .all(PREFIX + '%')
        .map(row => [row.key.slice(PREFIX.length), JSON.parse(row.value)]),
    );
    this.lanes = new Map();
    this.sent = new Map();
    this.errors = new Map();
    this.retries = new Map();
    this.lifetime = new AbortController();
    this.posters = new Map();
    this.posterAttempts = new Map();
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 5000);
    this.timer.unref();
  }
  getRecord(id) {
    try {
      return this.watch.roomState.store.get(id);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  async save(id, value) {
    this.watch.roomState.store.healthy();
    if (value) {
      this.records.set(id, value);
      this.registry.meta(PREFIX + id, JSON.stringify(value));
    } else {
      this.records.delete(id);
      this.sent.delete(id);
      this.errors.delete(id);
      this.retries.delete(id);
      this.posters.delete(id);
      this.posterAttempts.delete(id);
      this.registry.db.prepare('DELETE FROM meta WHERE key=?').run(PREFIX + id);
    }
    await this.registry.flush();
  }
  lane(id, action) {
    const previous = this.lanes.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    this.lanes.set(id, task);
    task
      .finally(() => {
        if (this.lanes.get(id) === task) this.lanes.delete(id);
      })
      .catch(() => {});
    return task;
  }
  async channel(channelId = this.config.shareChannelId, guildId = this.config.guildId) {
    const client = this.hub.discordClient;
    if (!client?.isReady()) throw fail('Discord is unavailable. Try again when the bot reconnects.');
    if (!channelId) throw fail('Discord publishing is unavailable. Try again shortly.');
    const channel = await client.channels.fetch(channelId);
    if (channel?.guildId !== guildId || channel.type !== ChannelType.GuildText)
      throw fail('Choose a text channel in the configured Discord server.');
    const permissions = channel.permissionsFor(client.user);
    if (
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ])
    ) {
      throw fail(
        'The bot needs View Channel, Send Messages, Embed Links and Read Message History in the publishing channel.',
      );
    }
    return channel;
  }
  preview(record) {
    const room = this.watch.rooms.get(record.id),
      recovering = this.watch.roomState.recoveries.has(record.id);
    const live = !!room && !room.closed;
    const viewers = new Set(
      [...(room?.viewers.values() || [])]
        .filter(v => !v.watchSocket || v.watchSocket.readyState === 1)
        .map(v => v.userId),
    ).size;
    return {
      name: record.name,
      title: live
        ? room.media?.title || 'Nothing selected'
        : recovering
          ? record.bookmark?.title || 'Nothing selected'
          : 'Nothing selected',
      subtitle: live ? room.media?.subtitle || '' : '',
      status:
        !live && !recovering
          ? 'Closed'
          : !live ||
              room.frozen ||
              room.mediaTransition ||
              !room.media ||
              room.media.unavailable ||
              room.state.waitingForReady
            ? 'Waiting'
            : room.state.paused
              ? 'Paused'
              : 'Playing',
      viewers,
      visibility: record.visibility,
      revision: record.revision,
      epoch: room?.epoch,
      invite: this.config.publicUrl + '/join/' + record.inviteCode,
      posterUrl: this.posterUrl(record.id),
    };
  }
  posterKey(room) {
    return room?.media?.kind === 'plex' ? String(room.media.roomServerId || '') + ':' + room.media.id : undefined;
  }
  posterUrl(id) {
    const poster = this.posters.get(id);
    return poster && poster.key === this.posterKey(this.watch.rooms.get(id))
      ? this.config.publicUrl + '/api/watch/shared-poster/' + id + '/' + poster.token
      : undefined;
  }
  posterResource(id, token) {
    const publication = this.records.get(id),
      poster = this.posters.get(id);
    if (
      this.stopped ||
      !publication?.active ||
      publication.remove ||
      !poster ||
      poster.token !== token ||
      poster.key !== this.posterKey(this.watch.rooms.get(id))
    )
      return;
    return { bytes: poster.bytes, type: poster.type };
  }
  async refreshPoster(id, actor) {
    const room = this.watch.rooms.get(id),
      key = this.posterKey(room);
    if (!key) {
      this.posters.delete(id);
      return;
    }
    if (this.posters.get(id)?.key === key) return;
    this.posters.delete(id);
    const attempted = this.posterAttempts.get(id);
    if (attempted?.key === key && Date.now() < attempted.retryAt) return;
    this.posterAttempts.set(id, { key, retryAt: Date.now() + 30000 });
    const candidates = [actor, ...[...(room.viewers?.values() || [])].map(viewer => viewer.actor)].filter(Boolean);
    for (const person of [...new Map(candidates.map(candidate => [candidate.userId, candidate])).values()].slice(
      0,
      2,
    )) {
      try {
        const art = await waitFor(
          (async () => {
            if ((person.watchCurrent && !(await person.watchCurrent())) || !(await this.watch.canView(room, person)))
              return;
            const plex = this.hub.plexFor ? await this.hub.plexFor(person) : this.watch.plex;
            if (!plex?.artwork) return;
            const result = await plex.artwork(room.media.id, 'poster', room.media.source?.type);
            if (!(await this.watch.canView(room, person))) return;
            return result;
          })(),
          AbortSignal.timeout(2500),
        );
        if (!art) continue;
        if (this.stopped || this.watch.rooms.get(id) !== room || this.posterKey(room) !== key) return;
        if (
          !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(art.type) ||
          !Buffer.isBuffer(art.bytes) ||
          art.bytes.length > 2000000
        )
          continue;
        this.posters.set(id, { key, token: randomBytes(24).toString('hex'), bytes: art.bytes, type: art.type });
        return;
      } catch {
        /* Missing artwork does not prevent publishing or playback. */
      }
    }
  }
  payload(preview, closed = false) {
    const status = closed ? 'Closed' : preview.status;
    return {
      content: '',
      allowedMentions: { parse: [] },
      embeds: [
        {
          title: clean(preview.name),
          color: closed ? 0x777777 : 0xff984f,
          description: closed
            ? 'This room is closed.'
            : [markdown(preview.title), markdown(preview.subtitle)].filter(Boolean).join('\n'),
          ...(!closed && preview.posterUrl ? { thumbnail: { url: preview.posterUrl } } : {}),
          fields: [
            { name: 'Status', value: status, inline: true },
            { name: 'Viewers', value: String(closed ? 0 : preview.viewers), inline: true },
          ],
          footer: { text: 'uburoom' },
        },
      ],
      components: closed
        ? []
        : [{ type: 1, components: [{ type: 2, style: 5, label: 'Join room', url: preview.invite }] }],
    };
  }
  async summary(id, actor) {
    const record = this.getRecord(id);
    if (!record) throw fail('Room unavailable', 404);
    const publication = this.records.get(id),
      canManage = this.hub.authorize(actor, record, 'room.host').ok;
    const value = {
      invite: { code: record.inviteCode, url: this.config.publicUrl + '/join/' + record.inviteCode },
      preview: this.preview(record),
      canManage,
      configured: !!this.config.shareChannelId || !!publication,
      canPublish: !!this.config.shareChannelId,
      published: !!publication?.active,
      hasPost: !!publication?.messageId,
      removing: !!publication?.remove,
      uncertain: !!publication && !publication.messageId,
      messageUrl: publication?.messageId
        ? `https://discord.com/channels/${publication.guildId}/${publication.channelId}/${publication.messageId}`
        : undefined,
    };
    if (!canManage)
      return { ...value, messageUrl: undefined, published: false, hasPost: false, removing: false, uncertain: false };
    if (publication?.channelName) value.channelName = publication.channelName;
    if (this.config.shareChannelId || publication) {
      try {
        value.channelName = (
          await this.channel(
            publication?.channelId || this.config.shareChannelId,
            publication?.guildId || this.config.guildId,
          )
        ).name;
        value.available = true;
      } catch (error) {
        value.available = false;
        value.error = this.safeError(error);
      }
    }
    if (this.errors.has(id)) value.error = this.errors.get(id);
    return value;
  }
  safeError(error, subject = 'room post') {
    const wait = retryDelay(error);
    if (wait) return `Discord is busy. Try again in ${Math.max(1, Math.ceil(wait / 1000))} seconds.`;
    return error?.status && error.status < 500 && error.message && !error.code
      ? error.message
      : error?.status === 503
        ? error.message
        : `Discord could not update the ${subject}. Check the bot and permissions, then try again.`;
  }
  async check(room, actor, permitted) {
    if (actor.watchCurrent && !(await actor.watchCurrent())) throw fail('Room access changed.', 403);
    const id = room.roomId;
    let media;
    do {
      if (this.watch.rooms.get(id) !== room || room.closed) throw fail('This room is closed.', 409);
      if (this.stopped || this.watch.shuttingDown || !permitted()) throw fail('Publishing timed out. Try again.', 409);
      media = room.media;
      const allowed = await this.watch.canView(room, actor);
      if (media === room.media && !allowed) throw fail('Room access changed.', 403);
    } while (media !== room.media);
    const record = this.getRecord(id);
    if (this.watch.rooms.get(id) !== room || room.closed || !record) throw fail('This room is closed.', 409);
    if (this.stopped || this.watch.shuttingDown || !permitted()) throw fail('Publishing timed out. Try again.', 409);
    if (!this.hub.authorize(actor, record, 'room.host').ok)
      throw fail('Only room hosts can publish or remove the post.', 403);
    return record;
  }
  async command(room, action, actor, permitted) {
    if (!room || room.closed) throw fail('This room is closed.', 409);
    const id = room.roomId;
    return this.lane(id, async () => {
      await this.check(room, actor, permitted);
      let publication = this.records.get(id);
      if (action === 'room.unpublish') {
        if (!publication) return { status: 'applied', message: 'Room post removed.' };
        publication = { ...publication, active: false, remove: true };
        await this.save(id, publication);
        await this.update(id);
        return { status: 'applied', message: 'Room post removed.' };
      }
      if (!this.config.shareChannelId) throw fail('Discord room publishing is not configured.');
      const channel = await this.channel();
      await this.check(room, actor, permitted);
      if (
        publication?.channelId !== undefined &&
        (publication.channelId !== channel.id || publication.guildId !== this.config.guildId)
      )
        throw fail('Remove the previous room post before publishing to the new channel.', 409);
      if (publication && !publication.messageId) {
        await this.recoverReceipt(id, channel);
        publication = this.records.get(id);
        if (!publication?.messageId)
          throw fail(
            'The previous post could not be confirmed. Check Discord before retrying; no duplicate was posted.',
            409,
          );
      }
      await this.refreshPoster(id, actor);
      let preview = this.preview(await this.check(room, actor, permitted));
      // Build each attempt from current details after authorization, including
      // changes made while fetching artwork or waiting for Discord.
      const latestPayload = () => {
        preview = this.preview(this.getRecord(id));
        return this.payload(preview);
      };
      if (publication?.messageId) {
        try {
          await discordRequest(() => channel.messages.edit(publication.messageId, latestPayload()), {
            current: () => this.check(room, actor, permitted),
            signal: this.lifetime.signal,
          });
        } catch (error) {
          if (error.code === 10008) await this.save(id, undefined);
          throw error;
        }
        await this.save(id, { ...publication, preview, active: true, remove: false, channelName: channel.name });
        this.sent.set(id, JSON.stringify(this.payload(preview)));
      } else {
        publication = {
          guildId: this.config.guildId,
          channelId: channel.id,
          channelName: channel.name,
          active: true,
          nonce: randomBytes(12).toString('hex'),
          preview,
        };
        await this.save(id, publication);
        // Recheck after durable intent, immediately before the external mutation.
        try {
          await this.check(room, actor, permitted);
        } catch (error) {
          await this.save(id, undefined);
          throw error;
        }
        try {
          const message = await discordRequest(
            () => channel.send({ ...latestPayload(), nonce: publication.nonce, enforceNonce: true }),
            {
              current: () => this.check(room, actor, permitted),
              signal: this.lifetime.signal,
            },
          );
          await this.save(id, { ...publication, preview, messageId: message.id });
          this.sent.set(id, JSON.stringify(this.payload(preview)));
        } catch (error) {
          // A definite API refusal did not create a message. Timeouts and 5xx
          // remain uncertain and are never retried as fresh sends.
          if (error.status >= 400 && error.status < 500) await this.save(id, undefined);
          throw error;
        }
      }
      if (room.closed || this.watch.rooms.get(id) !== room) {
        const value = this.records.get(id);
        if (value) await this.save(id, { ...value, active: false });
        await this.update(id);
        throw fail('The room closed while publishing. Its post is now closed.', 409);
      }
      this.errors.delete(id);
      this.retries.delete(id);
      return { status: 'applied', message: 'Room published to Discord.' };
    }).catch(error => {
      throw fail(this.safeError(error), error.status || 503);
    });
  }
  async removeSaved(id, actor, permitted) {
    return this.lane(id, async () => {
      if (actor.watchCurrent && !(await actor.watchCurrent())) throw fail('Room access changed.', 403);
      const record = this.getRecord(id);
      if (this.stopped || !record || !permitted()) throw fail('Room changed or command expired.', 409);
      if (!this.hub.authorize(actor, record, 'room.host').ok) throw fail('Only room hosts can remove the post.', 403);
      const publication = this.records.get(id);
      if (publication) {
        await this.save(id, { ...publication, active: false, remove: true });
        await this.update(id, false, async () => {
          if (actor.watchCurrent && !(await actor.watchCurrent())) return false;
          const current = this.getRecord(id);
          return !this.stopped && !!current && permitted() && this.hub.authorize(actor, current, 'room.host').ok;
        });
      }
      return { status: 'applied', message: 'Room post removed.' };
    }).catch(error => {
      throw fail(this.safeError(error), error.status || 503);
    });
  }
  async recoverReceipt(id, channel) {
    const publication = this.records.get(id);
    if (!publication || publication.messageId) return;
    const messages = await channel.messages.fetch({ limit: 100 });
    const found = [...messages.values()].find(
      message => message.author?.id === this.hub.discordClient.user.id && String(message.nonce) === publication.nonce,
    );
    if (found) await this.save(id, { ...publication, messageId: found.id });
  }
  roomClosed(id) {
    if (!this.records.has(id) || this.stopped) return;
    // Serialize the close intent with in-flight publication. A reopened room
    // cannot inherit the old active flag, even if Discord is offline.
    void this.lane(id, async () => {
      const value = this.records.get(id);
      if (value) await this.save(id, { ...value, active: false });
      await this.update(id);
    }).catch(error => this.recordError(id, error));
  }
  async update(id, force = false, current = () => !this.stopped) {
    let publication = this.records.get(id);
    if (!publication) return;
    const record = this.getRecord(id),
      room = this.watch.rooms.get(id);
    if (publication.active && (!record || (!room && !this.watch.roomState.recoveries.has(id)))) {
      publication = { ...publication, active: false };
      await this.save(id, publication);
    }
    if (!publication.active) {
      this.posters.delete(id);
      this.posterAttempts.delete(id);
    }
    const channel = await this.channel(publication.channelId, publication.guildId);
    if (!publication.messageId) {
      await this.recoverReceipt(id, channel);
      publication = this.records.get(id);
    }
    if (!publication.messageId)
      throw fail('The room post could not be confirmed. Check Discord; no duplicate was posted.', 409);
    if (publication.remove) {
      try {
        await discordRequest(() => channel.messages.delete(publication.messageId), {
          current,
          signal: this.lifetime.signal,
        });
      } catch (error) {
        if (error.code !== 10008) throw error;
      }
      await this.save(id, undefined);
      this.sent.delete(id);
      this.errors.delete(id);
      return;
    }
    if (publication.active) await this.refreshPoster(id);
    const payload = this.payload(record ? this.preview(record) : publication.preview, !publication.active);
    const signature = JSON.stringify(payload);
    if (!force && this.sent.get(id) === signature) return;
    try {
      await discordRequest(() => channel.messages.edit(publication.messageId, payload), {
        current,
        signal: this.lifetime.signal,
      });
    } catch (error) {
      if (error.code === 10008) {
        await this.save(id, undefined);
        this.sent.delete(id);
        return;
      }
      throw error;
    }
    this.sent.set(id, signature);
    this.errors.delete(id);
    this.retries.delete(id);
    if (!record) {
      await this.save(id, undefined);
      this.sent.delete(id);
    }
  }
  async reconcile() {
    if (this.stopped || !this.hub.discordClient?.isReady()) return;
    await Promise.allSettled(
      [...this.records.keys()]
        .filter(id => !this.lanes.has(id) && Date.now() >= (this.retries.get(id) || 0))
        .map(id => this.lane(id, () => this.update(id)).catch(error => this.recordError(id, error))),
    );
  }
  recordError(id, error) {
    this.errors.set(id, this.safeError(error));
    this.retries.set(id, Date.now() + (retryDelay(error) || 30000));
  }
  async close() {
    this.stopped = true;
    this.lifetime.abort();
    clearInterval(this.timer);
    await Promise.allSettled([...this.lanes.values()]);
  }
}
module.exports = { DiscordPublications };
