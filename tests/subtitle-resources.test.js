'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PlaybackError } = require('../server/av1');
const SubtitleResources = require('../server/subtitle-resources');

test('classifyExtractionError maps error messages and instances to standard PlaybackError', () => {
  const { classifyExtractionError } = SubtitleResources;

  // Timed out case
  const errTimeout = classifyExtractionError(new Error('Process timed out after 30s'));
  assert.ok(errTimeout instanceof PlaybackError);
  assert.equal(errTimeout.message, 'Subtitle extraction timed out. Try Plex burn-in.');

  // Exceeded limit case
  const errExceeded = classifyExtractionError(new Error('Subtitle font exceeded the supported limit.'));
  assert.ok(errExceeded instanceof PlaybackError);
  assert.equal(errExceeded.message, 'Subtitle resource or fonts exceeded the supported limits. Try Plex burn-in.');

  const errExceed = classifyExtractionError(new Error('Data size exceed max capacity'));
  assert.ok(errExceed instanceof PlaybackError);
  assert.equal(errExceed.message, 'Subtitle resource or fonts exceeded the supported limits. Try Plex burn-in.');

  // No usable data case
  const errNoData = classifyExtractionError(new Error('Subtitle extraction produced no usable data.'));
  assert.ok(errNoData instanceof PlaybackError);
  assert.equal(errNoData.message, 'Subtitle extraction produced no usable data. Try Plex burn-in.');

  // Failed case
  const errFailed = classifyExtractionError(new Error('Extraction failed during demux'));
  assert.ok(errFailed instanceof PlaybackError);
  assert.equal(errFailed.message, 'Subtitle extraction failed during media demuxing. Try Plex burn-in.');

  // Already PlaybackError instance
  const originalPbError = new PlaybackError('Custom playback error');
  const errSame = classifyExtractionError(originalPbError);
  assert.strictEqual(errSame, originalPbError);

  // Fallbacks: unknown error, empty error, null, undefined
  const errGeneric = classifyExtractionError(new Error('Uncategorized network error'));
  assert.ok(errGeneric instanceof PlaybackError);
  assert.equal(errGeneric.message, 'Original subtitles could not be extracted. Try Plex burn-in.');

  const errNull = classifyExtractionError(null);
  assert.ok(errNull instanceof PlaybackError);
  assert.equal(errNull.message, 'Original subtitles could not be extracted. Try Plex burn-in.');

  const errUndefined = classifyExtractionError(undefined);
  assert.ok(errUndefined instanceof PlaybackError);
  assert.equal(errUndefined.message, 'Original subtitles could not be extracted. Try Plex burn-in.');
});

test('clear resets media.subtitleAssets and operates safely on any media object', () => {
  const { clear } = SubtitleResources;
  const media = { subtitleAssets: new Map([['data', Buffer.from('test')]]) };

  clear(media);
  assert.equal(media.subtitleAssets, undefined);

  // Clearing again should be safe and non-throwing
  assert.doesNotThrow(() => clear(media));
  assert.equal(media.subtitleAssets, undefined);
});

test('read streams subtitle data and enforces response status and size limits', async () => {
  const { read, LIMIT } = SubtitleResources;
  assert.equal(LIMIT, 64 * 1024 * 1024);

  const signal = new AbortController().signal;

  // Non-ok response throws PlaybackError
  await assert.rejects(
    read({ ok: false }, signal),
    err => err instanceof PlaybackError && err.message.includes('unavailable')
  );

  // Successful read with async iterable body
  async function* createStream(chunks) {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
  }

  const okResponse = {
    ok: true,
    body: createStream(['hello ', 'world'])
  };

  const buffer = await read(okResponse, signal);
  assert.equal(buffer.toString('utf8'), 'hello world');

  // Exceeding limit throws PlaybackError and cancels body
  let canceled = false;
  const oversizedResponse = {
    ok: true,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(10);
        yield Buffer.alloc(10);
      },
      cancel: async () => {
        canceled = true;
      }
    }
  };

  await assert.rejects(
    read(oversizedResponse, signal, 15),
    err => err instanceof PlaybackError && err.message.includes('exceeds the supported size')
  );
  assert.equal(canceled, true);

  // Aborted signal throws when reading stream
  const controller = new AbortController();
  controller.abort();
  const abortedResponse = {
    ok: true,
    body: createStream(['chunk1', 'chunk2'])
  };

  await assert.rejects(
    read(abortedResponse, controller.signal),
    err => err.name === 'AbortError'
  );
});

test('pipe streams PGS chunks progressively with a 300s idle timeout and caches completed output', async () => {
  const { pipe, clear, transfer } = SubtitleResources;
  const streamedOptions = [];
  const plex = {
    av1: {
      ffmpeg: 'ffmpeg',
      input: async (source, signal, fn) => fn('http://127.0.0.1:12345/cap'),
      stream: async (binary, args, signal, onChunk, options) => {
        streamedOptions.push(options);
        onChunk(Buffer.from('PG-CHUNK-1'));
        onChunk(Buffer.from('PG-CHUNK-2'));
      }
    }
  };
  const media = {
    sourceKey: '["https://plex.example","1","10","/library/parts/10/file.mkv",100,60,"1"]',
    principal: 'plex-user-1',
    captionVersion: '11111111-2222-3333-4444-555555555555',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '23', index: 4, delivery: 'pgs', available: true, external: false } },
    source: { Media: [{ Part: [{ Stream: [{ id: 23, index: 4, streamType: 3, codec: 'pgs' }] }] }] }
  };
  const written = [];
  let statusCode = 0;
  const res = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(code) { statusCode = code; this.headersSent = true; },
    write(chunk) { written.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) written.push(Buffer.from(chunk)); this.writableEnded = true; },
    on() {},
    off() {}
  };
  await pipe(plex, media, { method: 'GET' }, res, new AbortController().signal);
  assert.equal(statusCode, 200);
  assert.equal(Buffer.concat(written).toString('utf8'), 'PG-CHUNK-1PG-CHUNK-2');
  assert.equal(streamedOptions.length, 1);
  assert.equal(streamedOptions[0].idleTimeout, 300000);

  // Quality/stream replacement with the same source and subtitle track preserves captionVersion and cached bytes
  const replacement = {
    sourceKey: media.sourceKey,
    principal: media.principal,
    captionVersion: '99999999-8888-7777-6666-555555555555',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '23', index: 4, delivery: 'pgs', available: true, external: false } },
    source: media.source
  };
  assert.equal(transfer(media, replacement), true);
  assert.equal(replacement.captionVersion, '11111111-2222-3333-4444-555555555555');
  assert.equal(media.subtitleAbort, undefined);
  clear(media);

  const cachedWritten = [];
  const cachedRes = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk) { cachedWritten.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) cachedWritten.push(Buffer.from(chunk)); this.writableEnded = true; },
    on() {},
    off() {}
  };
  await pipe(plex, replacement, { method: 'GET' }, cachedRes, new AbortController().signal);
  assert.equal(Buffer.concat(cachedWritten).toString('utf8'), 'PG-CHUNK-1PG-CHUNK-2');
  assert.equal(streamedOptions.length, 1);
  clear(replacement);

  const {EventEmitter}=require('node:events');
  const slowMedia=windowMedia(),slowResponse=new EventEmitter();let writes=0,streamSignal;
  Object.assign(slowResponse,{headersSent:false,destroyed:false,writableEnded:false,
    writeHead(){this.headersSent=true;},write(){writes++;return false;},end(){this.writableEnded=true;},destroy(){this.destroyed=true;this.emit('close');}});
  plex.av1.stream=async(binary,args,signal,onChunk)=>{
    streamSignal=signal;onChunk(Buffer.alloc(65536));onChunk(Buffer.alloc(65536));
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  };
  const slow=pipe(plex,slowMedia,{method:'GET'},slowResponse,new AbortController().signal);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,1,'slow response waits for drain');
  const job=slowMedia.subtitleJob;slowResponse.destroy();await slow;await job.promise.catch(()=>{});
  assert.equal(streamSignal.aborted,true,'last disconnected consumer cancels extraction');
  assert.equal(slowMedia.subtitleJob,undefined);clear(slowMedia);
});

test('window retrieves bounded subtitle intervals, counts cues, and caches results', async () => {
  const { window, clear, transfer } = SubtitleResources;
  const ffmpegRuns = [];

  // Create a valid dummy PGS display set: PCS (0x16) + END (0x80)
  const pcs = Buffer.alloc(13 + 4);
  pcs[0] = 0x50; pcs[1] = 0x47; // 'PG'
  pcs.writeUInt32BE(90000 * 10, 2); // PTS: 10s
  pcs.writeUInt32BE(90000 * 10, 6); // DTS: 10s
  pcs[10] = 0x16; // PCS
  pcs.writeUInt16BE(4, 11); // size: 4

  const end = Buffer.alloc(13);
  end[0] = 0x50; end[1] = 0x47;
  end.writeUInt32BE(90000 * 10, 2);
  end.writeUInt32BE(90000 * 10, 6);
  end[10] = 0x80; // END
  end.writeUInt16BE(0, 11);

  const mockSupData = Buffer.concat([pcs, end]);

  const plex = {
    av1: {
      ffmpeg: 'ffmpeg',ffprobe:'ffprobe',
      input: async (source, signal, fn) => fn('http://127.0.0.1:12345/source'),
      run: async (binary, args, signal, timeout, maxOutput,diagnostic,options) => {
        if(binary==='ffprobe')return Buffer.from(JSON.stringify({format:{start_time:'0'},streams:[{index:4,codec_name:'hdmv_pgs_subtitle'}],packets:[{stream_index:4,pts_time:'10',size:'10'}]}));
        ffmpegRuns.push(args);options?.outputComplete(mockSupData);
        return mockSupData;
      }
    }
  };

  const media = {
    sourceKey: '["https://plex.example","1","10","/library/parts/10/file.mkv",100,60,"1"]',
    principal: 'plex-user-1',
    captionVersion: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '23', index: 4, delivery: 'pgs', available: true, external: false } },
    source: { Media: [{ Part: [{ Stream: [{ id: 23, index: 4, streamType: 3, codec: 'pgs' }] }] }] }
  };

  // 1. Initial window request at 10s (atMs: 10000, beforeMs: 5000, afterMs: 20000)
  const result = await window(plex, media, { atMs: 10000, beforeMs: 5000, afterMs: 20000 });
  assert.equal(result.format, 'pgs');
  assert.equal(result.startMs, 5000); // 10s - 5s
  assert.equal(result.endMs, 30000); // 5s + (5s + 20s)
  assert.equal(result.cues, 1);
  assert.equal(result.data.length, mockSupData.length);
  assert.equal(ffmpegRuns.length, 1);

  // Verify FFmpeg args included -ss, -t, and -copyts
  const runArgs = ffmpegRuns[0];
  const ssIdx = runArgs.indexOf('-ss');
  assert.ok(ssIdx >= 0);
  assert.equal(runArgs[ssIdx + 1], '5');
  assert.equal(runArgs[runArgs.indexOf('-frames:s')+1],'1');
  assert.equal(runArgs.includes('-copyts'),true);
  assert.equal(result.data.readUInt32BE(2),90000*10);

  // 2. Repeat request within the same interval uses windowCache without running FFmpeg
  const cachedResult = await window(plex, media, { atMs: 10000, beforeMs: 5000, afterMs: 20000 });
  assert.equal(cachedResult.data, result.data);
  assert.equal(ffmpegRuns.length, 1); // No new run!

  // 3. Request contained inside existing coverage also uses windowCache with superset bounds
  const innerResult = await window(plex, media, { atMs: 12000, beforeMs: 2000, afterMs: 5000 });
  assert.equal(innerResult.data, result.data);
  assert.equal(innerResult.startMs, 5000); // returns superset startMs
  assert.equal(innerResult.endMs, 30000);  // returns superset endMs
  assert.equal(ffmpegRuns.length, 1); // Still 1

  // 3b. Request with explicit beforeMs: 0 is honored and not coerced to 15000
  const zeroBefore = await window(plex, media, { atMs: 40000, beforeMs: 0, afterMs: 20000 });
  assert.equal(zeroBefore.startMs, 40000);
  assert.equal(zeroBefore.endMs, 60000);
  assert.equal(ffmpegRuns.length, 2);
  const zeroArgs = ffmpegRuns[1];
  const ssZero = zeroArgs.indexOf('-ss');
  assert.equal(zeroArgs[ssZero + 1], '40'); // at 40s - 0s = 40s (not 25s!)

  // 4. Quality transfer preserves windowCache
  const replacement = {
    sourceKey: media.sourceKey,
    principal: media.principal,
    captionVersion: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '23', index: 4, delivery: 'pgs', available: true, external: false } },
    source: media.source
  };
  assert.equal(transfer(media, replacement), true);
  assert.ok(replacement.windowCache instanceof Map);
  assert.ok(replacement.windowCache.size > 0);

  // 5. Clear cleans up windowCache
  clear(replacement);
  assert.equal(replacement.windowCache.size, 0);

  // 6. ASS subtitle windowing: extracts -f ass and counts Dialogue lines
  const assText = '[Script Info]\nTitle: Test\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:10.00,0:00:15.00,Default,,0,0,0,,Line 1\nDialogue: 0,0:00:16.00,0:00:20.00,Default,,0,0,0,,Line 2\n';
  const mockAssData = Buffer.from(assText, 'utf8');
  const assMedia = {
    sourceKey: '["https://plex.example","1","10","/library/parts/10/file.mkv",100,60,"1"]',
    principal: 'plex-user-1',
    captionVersion: '22222222-bbbb-cccc-dddd-eeeeeeeeeeee',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '24', index: 5, delivery: 'ass', available: true, external: false } },
    source: { Media: [{ Part: [{ Stream: [{ id: 24, index: 5, streamType: 3, codec: 'ass' }] }] }] }
  };
  plex.av1.run = async (binary, args) => {
    ffmpegRuns.push(args);
    return mockAssData;
  };
  const assResult = await window(plex, assMedia, { atMs: 10000, beforeMs: 5000, afterMs: 20000 });
  assert.equal(assResult.format, 'ass');
  assert.equal(assResult.cues, 2);
  const assRunArgs = ffmpegRuns[ffmpegRuns.length - 1];
  const fIdxAss = assRunArgs.indexOf('-f');
  assert.ok(fIdxAss >= 0);
  assert.equal(assRunArgs[fIdxAss + 1], 'ass');

  // 7. VobSub subtitle windowing: extracts -f matroska and detects content
  const mockVobsubData = Buffer.alloc(600, 0x11);
  const vobsubMedia = {
    sourceKey: '["https://plex.example","1","10","/library/parts/10/file.mkv",100,60,"1"]',
    principal: 'plex-user-1',
    captionVersion: '33333333-bbbb-cccc-dddd-eeeeeeeeeeee',
    subtitleAbort: new AbortController(),
    selection: { subtitle: { id: '25', index: 6, delivery: 'vobsub', available: true, external: false } },
    source: { Media: [{ Part: [{ Stream: [{ id: 25, index: 6, streamType: 3, codec: 'vobsub' }] }] }] }
  };
  plex.av1.run = async (binary, args) => {
    ffmpegRuns.push(args);
    return mockVobsubData;
  };
  const vobsubResult = await window(plex, vobsubMedia, { atMs: 10000, beforeMs: 5000, afterMs: 20000 });
  assert.equal(vobsubResult.format, 'vobsub');
  assert.equal(vobsubResult.cues, 1);
  const vobsubRunArgs = ffmpegRuns[ffmpegRuns.length - 1];
  const fIdxVobsub = vobsubRunArgs.indexOf('-f');
  assert.ok(fIdxVobsub >= 0);
  assert.equal(vobsubRunArgs[fIdxVobsub + 1], 'matroska');
});

test('uburoomSubtitleWindows parses "0" header correctly, overlaps lookahead by 5s, and merges intervals', async () => {
  const { uburoomSubtitleWindows } = require('../web/watch-subtitles');

  const appends = [];
  const renderer = {
    append: async bytes => appends.push(bytes),
    destroy: () => {}
  };

  const originalFetch = global.fetch;
  try {
    let requestedUrls = [];
    global.fetch = async (url) => {
      requestedUrls.push(url);
      return new Response(require('../scripts/lib/subtitle-fixtures').pgs(), {
        status: 200,
        headers: {
          'x-subtitle-start-ms': '0',
          'x-subtitle-end-ms': '60000',
          'x-subtitle-cues': '5'
        }
      });
    };

    let syncCount = 0;
    const windows = new uburoomSubtitleWindows(renderer, 'https://example.com/sub/window', () => { syncCount++; });

    // Fetch at target 50000ms: with '0' header, startMs must be 0 (not 35000)
    windows.fetch(50000, false);
    await new Promise(r => setTimeout(r, 20));

    assert.equal(windows.intervals.length, 1);
    assert.equal(windows.intervals[0].startMs, 0, '"0" header parsed as 0 instead of fallback 35000');
    assert.equal(windows.intervals[0].endMs, 60000);
    assert.equal(windows.intervals[0].cues, 5);
    assert.equal(syncCount, 1);
    assert.equal(windows.isCovered(25000), true);

    // Lookahead test: at time 45s (45000ms), 45000+20000=65000 is not covered by [0, 60000]
    // check(45) should trigger fetch(45000 + 30000) = fetch(75000) (overlapping lookahead)
    requestedUrls = [];
    global.fetch = async (url) => {
      requestedUrls.push(url);
      return new Response(require('../scripts/lib/subtitle-fixtures').pgs(), {
        status: 200,
        headers: {
          'x-subtitle-start-ms': '55000',
          'x-subtitle-end-ms': '135000',
          'x-subtitle-cues': '3'
        }
      });
    };

    windows.check(45);
    assert.ok(requestedUrls.length > 0);
    assert.ok(requestedUrls[0].includes('atMs=75000'), 'Lookahead fetches at targetMs + 30000ms for 5s overlap');

    await new Promise(r => setTimeout(r, 20));
    // Interval [0, 60000] and [55000, 135000] overlap and must merge into [0, 135000]
    assert.equal(windows.intervals.length, 1);
    assert.equal(windows.intervals[0].startMs, 0);
    assert.equal(windows.intervals[0].endMs, 135000);
    assert.equal(windows.intervals[0].cues, 8);
  } finally {
    global.fetch = originalFetch;
  }
});

test('uburoomSubtitles preserves loading status until window scheduler covers mediaTime', async () => {
  const { uburoomSubtitles } = require('../web/watch-subtitles');

  const statusEvents = [],appends=[],destroyed=[];
  const mockVideo = {
    currentTime: 10,
    addTextTrack: () => ({ mode: 'disabled' }),
    textTracks: { addEventListener: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const originalFetch = global.fetch;
  const originalRenderers = global.window?.uburoomSubtitleRenderers;
  if (!global.window) global.window = {};

  try {
    global.window.uburoomSubtitleRenderers = {
      create: async () => ({
        offset: () => {},
        picture: () => {},
        append: async bytes => {appends.push(bytes);},
        destroy: () => {destroyed.push(true);}
      })
    };

    // Subtitle manifest advertising format 'pgs' with a window URL
    global.fetch = async (url) => {
      if (url.endsWith('/subtitle-manifest')) {
        return new Response(JSON.stringify({
          format: 'pgs',
          data: 'https://example.com/api/watch/media/123/subtitle-manifest/data',
          window: 'https://example.com/api/watch/media/123/subtitle-manifest/window',
          fonts: []
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Window endpoint returns window covering 0..20s
      return new Response(require('../scripts/lib/subtitle-fixtures').pgs(), {
        status: 200,
        headers: {
          'x-subtitle-start-ms': '0',
          'x-subtitle-end-ms': '20000',
          'x-subtitle-cues': '2'
        }
      });
    };

    const subs = new uburoomSubtitles(mockVideo, status => { statusEvents.push(status); });

    subs.update({ subtitleUrl: 'https://example.com/api/watch/media/123/subtitle-manifest' });
    await new Promise(r => setTimeout(r, 50));

    // When window scheduler was initialized, streamSynced was set to undefined, and Loading subtitles was preserved
    const loadingStates = statusEvents.filter(s => s.loading);
    assert.ok(loadingStates.length > 0, 'Loading subtitles was dispatched');
    assert.equal(subs.windowScheduler.synced(10), true);

    // Status cleared only when window covered currentTime
    const lastStatus = statusEvents[statusEvents.length - 1];
    assert.equal(lastStatus.loading, false);
    assert.equal(lastStatus.message, '');
    const delayed=[];
    global.fetch=async url=>{
      if(url.endsWith('/subtitle-next'))return new Response(JSON.stringify({format:'pgs',data:url+'/data',window:url+'/window',fonts:[]}));
      return new Promise(resolve=>delayed.push({url,resolve}));
    };
    const count=appends.length;
    mockVideo.currentTime=100;subs.onTimeChange();
    await new Promise(resolve=>setImmediate(resolve));
    subs.update({subtitleUrl:'https://example.com/subtitle-next'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(delayed.length,2);
    delayed[0].resolve(windowResponse(pgsAt(100),85000,160000));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(appends.length,count,'successful response arriving after track switch is never appended');
    subs.update({tracks:{subtitleError:'Viewing access expired.'}});
    delayed[1].resolve(windowResponse(pgsAt(100),85000,160000));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(appends.length,count,'successful response arriving after authorization reset is never appended');
    assert.ok(destroyed.length>=2);assert.equal(statusEvents.at(-1).error,true);
    assert.match(statusEvents.at(-1).message,/access expired/);
    subs.destroy();

  } finally {
    global.fetch = originalFetch;
    global.window.uburoomSubtitleRenderers = originalRenderers;
  }
});


function pgsAt(seconds=0){
  const data=Buffer.from(require('../scripts/lib/subtitle-fixtures').pgs());
  for(let offset=0;offset<data.length;offset+=13+data.readUInt16BE(offset+11))data.writeUInt32BE(data.readUInt32BE(offset+2)+seconds*90000,offset+2);
  return data;
}
function windowMedia(){return {sourceKey:'generated',principal:'fixture',sourceStart:'http://fixture.invalid/media',captionVersion:'version-a',subtitleOrigin:0,subtitleAbort:new AbortController(),
  selection:{subtitle:{id:'23',index:1,delivery:'pgs',available:true}},source:{Media:[{Part:[{Stream:[{id:23}]}]}]}};}
function windowResponse(data,startMs,endMs){return new Response(data,{headers:{'x-subtitle-start-ms':String(startMs),'x-subtitle-end-ms':String(endMs),'x-subtitle-cues':data.length?'2':'0'}});}

test('normal playback preserves unfinished window coverage and lookahead without repeated cancellation',async()=>{
  const {uburoomSubtitleWindows}=require('../web/watch-subtitles'),previous=global.fetch,requests=[];
  const scheduler=new uburoomSubtitleWindows({reset:async()=>{},append:async()=>{},flush:async()=>{}},'/window',()=>{});
  global.fetch=(url,{signal})=>new Promise(resolve=>requests.push({url,signal,resolve}));
  try{
    scheduler.check(10);scheduler.check(10.25);scheduler.check(10.5);
    assert.equal(requests.length,1);assert.equal(requests[0].signal.aborted,false);
    requests[0].resolve(windowResponse(pgsAt(),0,60000));await scheduler.fetching.promise;
    scheduler.check(45);scheduler.check(45.25);scheduler.check(45.5);
    assert.equal(requests.length,2);assert.equal(requests[1].signal.aborted,false);
    requests[1].resolve(windowResponse(pgsAt(50),45000,135000));await scheduler.fetching.promise;
    assert.equal(scheduler.synced(45.5),true);
  }finally{scheduler.destroy();global.fetch=previous;}
});

test('PGS overlap and backward seeks preserve a bounded chronological parser index',async()=>{
  const {uburoomSubtitleWindows}=require('../web/watch-subtitles');
  const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
  const wasm=await import(pathToFileURL(path.resolve(__dirname,'../node_modules/libbitsub/pkg/libbitsub.js')).href);
  wasm.initSync({module:fs.readFileSync(path.resolve(__dirname,'../node_modules/libbitsub/pkg/libbitsub_bg.wasm'))});
  const finish=async pending=>{if(pending?.promise)await pending.promise;await new Promise(resolve=>setImmediate(resolve));};
  const parser=new wasm.PgsParser(),requests=[],errors=[];let appends=0;
  const renderer={reset:async()=>parser.reset(),append:async bytes=>{appends++;return parser.feed(bytes);},flush:async()=>parser.finishFeed()};
  const originalFetch=global.fetch;
  global.fetch=(url,{signal})=>new Promise(resolve=>requests.push({url,signal,resolve}));
  const scheduler=new uburoomSubtitleWindows(renderer,'/window',()=>{},undefined,(error,failed)=>errors.push({error,failed}));
  try{
    scheduler.check(10);const first=scheduler.fetching;
    requests[0].resolve(windowResponse(Buffer.concat([pgsAt(),pgsAt(50)]),0,60000));await finish(first);
    assert.equal(parser.count,4);
    scheduler.check(45);const prefetch=scheduler.fetching;scheduler.check(45.25);
    assert.equal(requests[1].signal.aborted,false,'ordinary playback preserves prefetch');
    requests[1].resolve(windowResponse(Buffer.concat([pgsAt(50),pgsAt(100)]),45000,135000));await finish(prefetch);
    const overlap=[...parser.getTimestamps()];
    scheduler.check(500);const obsolete=scheduler.fetching;
    scheduler.check(1000);const latest=scheduler.fetching;
    assert.equal(requests[2].signal.aborted,true);
    requests[3].resolve(windowResponse(pgsAt(1000),985000,1060000));await finish(latest);
    requests[2].resolve(windowResponse(pgsAt(500),485000,560000));await finish(obsolete);
    const late=[...parser.getTimestamps()];
    scheduler.check(400);const backward=scheduler.fetching;
    requests.at(-1).resolve(windowResponse(pgsAt(400),385000,460000));await finish(backward);
    assert.deepEqual({overlap,late,backward:[...parser.getTimestamps()]},{overlap:[1000,5000,51000,55000,101000,105000],late:[1001000,1005000],backward:[401000,405000]});
    for(let i=1;i<=5;i++){
      const at=1000000+i*60000;scheduler.fetch(at);
      const pending=scheduler.fetching;
      requests.at(-1).resolve(windowResponse(pgsAt(at/1000),at-15000,at+60000));await finish(pending);
    }
    assert.ok(scheduler.items.length<=3);assert.ok(parser.count<=6);
    scheduler.check(2000);const destroyed=scheduler.fetching,count=appends;scheduler.destroy();
    requests.at(-1).resolve(windowResponse(pgsAt(2000),1985000,2060000));await finish(destroyed);
    assert.equal(appends,count);assert.deepEqual(errors,[]);
  }finally{scheduler.destroy();parser.free();global.fetch=originalFetch;}
});

test('quiet windows succeed, malformed bytes fail, transient failures recover, and authorization denial stays terminal',async()=>{
  const {uburoomSubtitleWindows}=require('../web/watch-subtitles');const old=global.fetch;
  const errors=[],renderer={reset:async()=>{},append:async()=>{},flush:async()=>{}};
  const scheduler=new uburoomSubtitleWindows(renderer,'/window',()=>{},undefined,(error,failed)=>errors.push({error,failed}));
  try{
    global.fetch=async()=>windowResponse(new Uint8Array(0),0,60000);
    scheduler.check(10);await scheduler.fetching.promise;assert.equal(scheduler.synced(10),true);
    global.fetch=async()=>new Response(JSON.stringify({error:'Fixture demux failure. Try Plex burn-in.'}),{status:503});
    scheduler.check(100);await scheduler.fetching.promise;assert.equal(errors.at(-1).failed,false);assert.equal(scheduler.synced(100),false);
    global.fetch=async()=>windowResponse(pgsAt(100),85000,160000);
    scheduler.retry();await scheduler.fetching.promise;assert.equal(scheduler.synced(100),true);assert.equal(scheduler.error,null);
    global.fetch=async()=>windowResponse(new Uint8Array([1,2,3]),185000,260000);
    scheduler.check(200);await scheduler.fetching.promise;assert.match(scheduler.error.message,/Invalid PGS/);
    global.fetch=async()=>new Response(new Uint8Array(0),{headers:{'x-subtitle-start-ms':'185000','x-subtitle-end-ms':'260000','x-subtitle-cues':'2'}});
    scheduler.retry();await scheduler.fetching.promise;assert.match(scheduler.error.message,/no usable data/);
    global.fetch=async()=>new Response(JSON.stringify({error:'Subtitle access expired.'}),{status:403});
    scheduler.retry();await scheduler.fetching.promise;assert.equal(errors.at(-1).failed,true);
    let requests=0;global.fetch=async()=>{requests++;throw Error('must not retry');};
    scheduler.check(300);scheduler.retry();assert.equal(requests,0);
  }finally{scheduler.destroy();global.fetch=old;}
});

test('shared window jobs isolate caller cancellation, reject obsolete selection, and release capacity after failure',async()=>{
  const media=windowMedia();let runs=0,release,jobSignal;
  const plex={av1:{ffmpeg:'fixture',ffprobe:'ffprobe',input:async(source,signal,action)=>action('http://fixture.invalid/cap'),run:async(binary,args,signal,timeout,limit,diagnostic,options)=>{
    if(binary==='ffprobe')return Buffer.from(JSON.stringify({streams:[{index:1,codec_name:'hdmv_pgs_subtitle'}],packets:[{stream_index:1,pts_time:'1',size:'195'},{stream_index:1,pts_time:'5',size:'17'}]}));
    runs++;jobSignal=signal;return new Promise((resolve,reject)=>{release=data=>{options?.outputComplete(data);resolve(data);};signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }}};
  const assets=[];
  plex.request=async()=>new Response('[Events]');
  plex.av1.stream=async(binary,args,signal,onChunk)=>onChunk(pgsAt());
  const response={headersSent:false,writeHead(){this.headersSent=true;},write(){return true;},end(){},on(){},off(){}};
  await SubtitleResources.pipe(plex,media,{method:'GET'},response,new AbortController().signal);
  const a=new AbortController(),b=new AbortController();
  try{
    const first=SubtitleResources.window(plex,media,{signal:a.signal});
    const second=SubtitleResources.window(plex,media,{signal:b.signal});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(runs,1);
    for(let i=0;i<8;i++){
      const asset=windowMedia();asset.selection.subtitle.delivery='ass';asset.selection.subtitle.external=true;
      asset.source.Media[0].Part[0].Stream[0].key='/library/streams/23.ass';assets.push(asset);
      await SubtitleResources.load(plex,asset,new AbortController().signal);
    }
    assert.equal(media.subtitleAssets,undefined,'cache pressure evicts the old completed resource');
    assert.equal(jobSignal.aborted,false,'evicting cache must not invalidate coalesced authorized work');
    a.abort();await assert.rejects(first);assert.equal(jobSignal.aborted,false);
    release(pgsAt());const result=await second;assert.equal(result.cues,2);
    const c=new AbortController(),cancelled=SubtitleResources.window(plex,media,{atMs:100000,signal:c.signal});
    await new Promise(resolve=>setImmediate(resolve));c.abort();await assert.rejects(cancelled);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(jobSignal.aborted,true);assert.equal(media.windowJobs.size,0);
    const stale=SubtitleResources.window(plex,media,{atMs:200000});await new Promise(resolve=>setImmediate(resolve));
    media.captionVersion='version-b';release(pgsAt());await assert.rejects(stale,/selection changed/);
    plex.av1.run=async()=>{throw new Error('demux failed');};
    await assert.rejects(SubtitleResources.window(plex,media),/failed/);assert.equal(media.windowJobs.size,0);
    plex.av1.run=async()=>Buffer.from(JSON.stringify({streams:[{index:1,codec_name:'hdmv_pgs_subtitle'}],packets:[{stream_index:0,pts_time:'0',size:'100'}]}));assert.equal((await SubtitleResources.window(plex,media)).cues,0);
    assert.equal(media.windowJobs.size,0);
  }finally{SubtitleResources.clear(media);for(const asset of assets)SubtitleResources.clear(asset);}
});


test('generated two-hour MKV windows seek over HTTP ranges, preserve offset timing, and clean up cancelled extraction',{timeout:90000},async t=>{
  const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const http=require('node:http'),{spawnSync}=require('node:child_process'),{Transform}=require('node:stream'),{pipeline}=require('node:stream/promises');
  const {AV1}=require('../server/av1');
  const available=spawnSync('ffmpeg',['-version'],{windowsHide:true});
  if(available.error){t.skip('Operator-supplied FFmpeg is unavailable');return;}
  const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'uburoom-pgs-window-'));
  const tool=(binary,args)=>{const result=spawnSync(binary,args,{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});assert.equal(result.status,0,result.stderr?.toString());return result.stdout;};
  const subtitle=path.join(directory,'generated.sup');await fsp.writeFile(subtitle,Buffer.concat([pgsAt(),pgsAt(3600),pgsAt(7180)]));
  let file,requests=[],delivered=0,ignoreRanges=false,stall=false,requested;
  const upstream=http.createServer(async(req,res)=>{
    if(stall){requested?.();return;}
    const stat=await fsp.stat(file),match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
    const start=match&&!ignoreRanges?Number(match[1]):0,end=match&&match[2]&&!ignoreRanges?Math.min(Number(match[2]),stat.size-1):stat.size-1;
    requests.push(start);
    if(start>=stat.size){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});res.end();return;}
    res.writeHead(match&&!ignoreRanges?206:200,{'Content-Type':'video/x-matroska','Content-Length':end-start+1,'Accept-Ranges':'bytes',...(match&&!ignoreRanges?{'Content-Range':'bytes '+start+'-'+end+'/'+stat.size}:{})});
    try{await pipeline(fs.createReadStream(file,{start,end}),new Transform({transform(chunk,encoding,callback){delivered+=chunk.length;callback(null,chunk);}}),res);}catch{}
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const plex={request:(url,options)=>fetch(url,options)};
  const av1=plex.av1=new AV1(plex,{ffmpegPath:'ffmpeg'});
  const media=windowMedia();media.selection.subtitle.index=2;media.sourceStart='http://127.0.0.1:'+upstream.address().port+'/generated.mkv';
  try{
    for(const origin of [0,120]){
      delete media.subtitleOrigin;media.sourceKey='generated-'+origin;
      file=path.join(directory,'origin-'+origin+'.mkv');
      tool('ffmpeg',['-v','error','-f','lavfi','-i','color=size=64x64:rate=1:duration=7200','-f','lavfi','-i','anullsrc=r=8000:cl=mono','-i',subtitle,
        '-map','0:v','-map','1:a','-map','2:s','-t','7200','-c:v','libx264','-preset','ultrafast','-g','10','-c:a','pcm_u8','-c:s','copy','-output_ts_offset',String(origin),file]);
      const reference=JSON.parse(tool('ffprobe',['-v','error','-show_entries','format=start_time:packet=pts_time','-select_streams','s','-of','json',file]));
      const expected=reference.packets.map(p=>Math.round((Number(p.pts_time)-Number(reference.format.start_time))*1000));
      assert.equal(Number(reference.format.start_time),origin);assert.ok((await fsp.stat(file)).size>50*1024*1024);
      for(const atMs of [0,3600000,7190000,100000]){
        SubtitleResources.clear(media);requests=[];delivered=0;
        const started=performance.now(),result=await SubtitleResources.window(plex,media,{atMs});
        const pts=[];for(let offset=0;offset<result.data.length;offset+=13+result.data.readUInt16BE(offset+11))if(result.data[offset+10]===0x16)pts.push(Math.round(result.data.readUInt32BE(offset+2)/90));
        assert.deepEqual(pts,expected.filter(ms=>ms>=result.startMs&&ms<result.endMs));
        t.diagnostic(JSON.stringify({delivered,fileSize:(await fsp.stat(file)).size,requests}));
        assert.ok(delivered<(await fsp.stat(file)).size/2,'window must not scan the entire container');
        if(atMs>=3600000)assert.ok(requests.some(start=>start>0),'late extraction uses nonzero byte ranges');
        t.diagnostic(JSON.stringify({origin,atMs,ms:Math.round(performance.now()-started),sourceBytes:delivered,cuePtsMs:pts}));
        assert.equal(av1.inputs.size,0);assert.equal(av1.jobs.size,0);
      }
    }
    SubtitleResources.clear(media);ignoreRanges=true;
    await assert.rejects(SubtitleResources.window(plex,media,{atMs:3600000}),/failed/);
    assert.equal(av1.inputs.size,0);assert.equal(av1.jobs.size,0);ignoreRanges=false;
    stall=true;const controller=new AbortController(),waiting=new Promise(resolve=>requested=resolve);
    const pending=SubtitleResources.window(plex,media,{atMs:3600000,signal:controller.signal});await waiting;controller.abort();await assert.rejects(pending);
    await Promise.allSettled([...av1.jobs]);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(av1.inputs.size,0);assert.equal(av1.jobs.size,0);assert.equal(media.windowJobs.size,0);
  }finally{
    media.subtitleAbort.abort();SubtitleResources.clear(media);await av1.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
    for(const name of await fsp.readdir(directory))await fsp.unlink(path.join(directory,name));await fsp.rmdir(directory);
  }
});


test('cross-track transfer rejects compatibility before moving any subtitle cache',()=>{
  const media=windowMedia(),different=windowMedia(),windowCache=new Map([['old',{data:pgsAt()}]]),textCache=new Map([['old',[]]]);
  media.windowCache=windowCache;media.subtitleCache=textCache;
  different.selection={subtitle:{id:'24',delivery:'pgs',available:true}};
  const controller=different.subtitleAbort;
  assert.equal(SubtitleResources.transfer(media,different),false);
  assert.equal(different.windowCache,undefined);assert.equal(different.subtitleCache,undefined);
  assert.equal(media.windowCache,windowCache);assert.equal(media.subtitleCache,textCache);
  assert.equal(different.subtitleAbort,controller);assert.equal(controller.signal.aborted,false);
});

test('empty successful FFmpeg output cannot verify quiet coverage when packet inspection found captions',async()=>{
  const media=windowMedia();let emptyInspection=false,ffmpegRuns=0;
  const plex={av1:{ffmpeg:'ffmpeg',ffprobe:'ffprobe',input:async(source,signal,action)=>action('http://fixture.invalid/cap'),run:async binary=>{
    if(binary==='ffprobe')return Buffer.from(JSON.stringify({streams:[{index:1,codec_name:'hdmv_pgs_subtitle'}],packets:emptyInspection?[{stream_index:0,pts_time:'0',size:'100'}]:[{stream_index:1,pts_time:'1',size:'195'}]}));
    ffmpegRuns++;return Buffer.alloc(0);
  }}};
  try{
    await assert.rejects(SubtitleResources.window(plex,media),/did not match|no usable data/);
    assert.equal(media.windowCache.size,0,'empty demux output must not poison cache with successful coverage');
    emptyInspection=true;
    const quiet=await SubtitleResources.window(plex,media);
    assert.equal(quiet.cues,0);assert.equal(quiet.data.length,0);assert.equal(media.windowCache.size,1);
    assert.equal(ffmpegRuns,1,'verified zero-caption interval bypasses FFmpeg rather than interpreting its empty output');
  }finally{SubtitleResources.clear(media);}
});

test('stale append completion cannot restore coverage after scheduler destruction',async()=>{
  const {uburoomSubtitleWindows}=require('../web/watch-subtitles');const previous=global.fetch;
  let release,started;const appending=new Promise(resolve=>started=resolve);
  const renderer={reset:async()=>{},flush:async()=>{},append:async()=>{started();await new Promise(resolve=>release=resolve);}};
  const scheduler=new uburoomSubtitleWindows(renderer,'/window',()=>{});
  try{
    global.fetch=async()=>windowResponse(pgsAt(),0,60000);
    scheduler.check(1.5);const pending=scheduler.fetching;
    await appending;scheduler.destroy();release();await pending.promise;
    // Await a task as well: the original scheduler did not expose a job promise.
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(scheduler.intervals,[]);assert.equal(scheduler.synced(1.5),false);
  }finally{scheduler.destroy();global.fetch=previous;release?.();}
});

test('retained window buffers participate in aggregate server cache eviction',async()=>{
  const buffer=Buffer.alloc(16*1024*1024),media=[];
  const plex={av1:{ffmpeg:'fixture',input:async(source,signal,action)=>action('http://fixture.invalid/cap'),run:async()=>buffer},
    request:async()=>new Response(Buffer.alloc(1024*1024))};
  const asset=windowMedia();asset.selection.subtitle.delivery='ass';asset.selection.subtitle.external=true;asset.source.Media[0].Part[0].Stream[0].key='/library/streams/23';
  try{
    for(let i=0;i<6;i++){
      const item=windowMedia();item.selection.subtitle.delivery='ass';media.push(item);
      await SubtitleResources.window(plex,item);
    }
    assert.equal(media[0].windowCache.size,1);
    await SubtitleResources.load(plex,asset,new AbortController().signal);
    assert.equal(media[0].windowCache.size,0,'full resource must evict retained window bytes at the shared 96MiB limit');
    assert.ok(media.reduce((sum,item)=>sum+[...item.windowCache.values()].reduce((n,entry)=>n+entry.data.length,0),0)+asset.subtitleAssets.get('data').length<=96*1024*1024);
  }finally{for(const item of [...media,asset])SubtitleResources.clear(item);}
});

test('browser aggregate budget charges retained input, parser data and replay transfers together',async()=>{
  const {uburoomSubtitleWindows}=require('../web/watch-subtitles'),previous=global.fetch;
  const unit=pgsAt();
  const padding=Buffer.alloc(13+1282);padding.write('PG');padding.writeUInt32BE(90000,2);padding[10]=0x14;padding.writeUInt16BE(1282,11);
  const large=Buffer.concat([unit,...Array(1600).fill(padding)]);
  let scheduler,peak=0;
  const renderer={reset:async()=>{},flush:async()=>{},append:async()=>{
    const usage=scheduler.resourceUsage();peak=Math.max(peak,usage.totalBytes);
    assert.ok(usage.parserBytes>0);assert.ok(usage.replayBytes>0);assert.ok(usage.transferBytes>0);
    assert.ok(usage.totalBytes<=usage.limitBytes);
  }};
  scheduler=new uburoomSubtitleWindows(renderer,'/window',()=>{});
  try{
    global.fetch=async url=>{const at=Number(new URL(url,'http://fixture').searchParams.get('atMs'));return windowResponse(large,Math.max(0,at-15000),at+60000);};
    scheduler.check(1.5);await scheduler.fetching.promise;
    assert.equal(scheduler.error,null);
    const first=scheduler.resourceUsage();assert.equal(first.retainedBytes,large.length);assert.equal(first.parserBytes,large.length);
    assert.equal(first.totalBytes,2*large.length);
    scheduler.fetch(100000);await scheduler.fetching.promise;
    assert.equal(scheduler.error,null);assert.ok(peak<=scheduler.resourceUsage().limitBytes);
    assert.ok(scheduler.resourceUsage().totalBytes<=scheduler.resourceUsage().limitBytes);
    // Incoming bytes alone fit the former 16MiB input cap, but cannot fit with
    // the retained window, parser copy, assembly, and transfer reservations.
    const over=Buffer.concat(Array(5).fill(large));
    global.fetch=async()=>windowResponse(over,185000,260000);
    scheduler.fetch(200000);await scheduler.fetching.promise;
    assert.match(scheduler.error.message,/cache limit/);
    assert.ok(scheduler.resourceUsage().totalBytes<=scheduler.resourceUsage().limitBytes);
  }finally{scheduler.destroy();global.fetch=previous;}
});
