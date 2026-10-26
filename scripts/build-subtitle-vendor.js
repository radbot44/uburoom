'use strict';
const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),out=path.join(root,'web/vendor/subtitles');fs.mkdirSync(out,{recursive:true});
const packages=new Set(['jassub','libbitsub']);
async function bundle(entry,name,plugins=[]){
  const result=await esbuild.build({entryPoints:[entry],bundle:true,minify:true,format:'esm',platform:'browser',target:'es2022',
    outfile:path.join(out,name),legalComments:'eof',metafile:true,...(plugins.length?{plugins}:{})});
  for(const input of Object.keys(result.metafile.inputs)){const name=/node_modules\/(\@[^/]+\/[^/]+|[^/]+)\//.exec(input)?.[1];if(name)packages.add(name);}
}
// Keep import.meta asset URLs valid without exposing node_modules or fetching CDNs.
async function main(){
await bundle(path.join(root,'node_modules/jassub/dist/jassub.js'),'jassub.js',[{name:'bounded-subtitle-disposal',setup(build){
  build.onLoad({filter:/jassub[\\/]dist[\\/]jassub\.js$/},args=>{
    const contents=fs.readFileSync(args.path,'utf8'),original='await this.ready;\n            await this.renderer?.[releaseProxy]();';
    if(!contents.includes(original))throw new Error('Review JASSUB teardown integration after upstream update.');
    return {contents:contents.replace(original,'await Promise.race([(async()=>{await this.ready;await this.renderer?.[releaseProxy]();})(),new Promise(resolve=>setTimeout(resolve,1000))]);'),loader:'js'};
  });
}}]);
await bundle(path.join(root,'node_modules/jassub/dist/worker/worker.js'),'jassub-worker.js',[{name:'transparent-ass-compositing',setup(build){
  build.onLoad({filter:/jassub[\\/]dist[\\/]worker[\\/]worker\.js$/},args=>{
    const contents=fs.readFileSync(args.path,'utf8');
    const selection=/        try \{\n            const testCanvas = new OffscreenCanvas\(1, 1\);[\s\S]*?        this\._gpurender\.setCanvas\(ctrl\);/;
    if(!selection.test(contents))throw new Error('Review JASSUB transparent compositor integration after upstream update.');
    // Avoid a second GPU compositing surface over hardware-decoded video.
    // libass still renders all authored styles; only bitmap composition changes.
    return {contents:contents.replace(selection,'        this._gpurender = new Canvas2DRenderer();\n        this._gpurender.setCanvas(ctrl);'),loader:'js'};
  });
  build.onLoad({filter:/jassub[\\/]dist[\\/]worker[\\/]renderers[\\/]2d-renderer\.js$/},args=>({
    contents:fs.readFileSync(args.path,'utf8').replaceAll('desynchronized: true','desynchronized: false'),loader:'js'
  }));
}}]);
await bundle(path.join(root,'node_modules/libbitsub/dist/wrapper.js'),'libbitsub-renderer.js',[{name:'subtitle-asset-urls',setup(build){
  build.onLoad({filter:/libbitsub[\\/]dist[\\/]ts[\\/]wasm\.js$/},args=>({contents:fs.readFileSync(args.path,'utf8').replaceAll("new URL('../../pkg/","new URL('./"),loader:'js'}));
  build.onLoad({filter:/libbitsub[\\/]dist[\\/]ts[\\/]renderers\.js$/},args=>{
    let contents=fs.readFileSync(args.path,'utf8');
    const mount='const videoRect = this.video.getBoundingClientRect();\n        const containerRect = containerElement.getBoundingClientRect();';
    const bounds='const rect = this.video.getBoundingClientRect();';
    if(!contents.includes(mount)||!contents.includes(bounds))throw new Error('Review libbitsub picture geometry integration after upstream update.');
    // uburoom transforms the picture and overlay together AFTER object-fit.
    // Measure the original layout box so zoom/stretch is applied exactly once.
    contents=contents.replace(mount,'const videoRect = {left:this.video.offsetLeft,top:this.video.offsetTop};\n        const containerRect = {left:0,top:0};')
      .replace(bounds,'const rect = {width:this.video.clientWidth,height:this.video.clientHeight};');
    const manual='renderAtMediaTime(mediaTime) {\n        this.renderSynchronizedFrame({ mediaTime, presentedFrames: null });\n    }';
    const indexed='emitIndexed(format, metadata, partial) {\n        this.emitEvent({ type: \'indexed\', format, metadata, partial });\n    }';
    const refresh='refreshStreamPresentation() {\n        this.invalidatePresentation();\n        this.lastRenderedIndex = -1;\n        this.lastRenderedTime = -1;\n        this.renderPausedFrame();\n    }';
    const metadata='this.loadedMetadataHandler = () => this.updateCanvasSize();';
    const syncFrame='const currentTime = tick.mediaTime + this.timeOffset;';
    const pgsIndex='findCurrentIndex(time) {\n        if (this.state.useWorker && this.state.workerReady) {\n            return binarySearchTimestamp(this.state.timestamps, time * 1000);\n        }\n        return this.pgsParser?.findIndexAtTimestamp(time) ?? -1;\n    }';
    if(!contents.includes(manual)||!contents.includes(indexed)||!contents.includes(refresh)||!contents.includes(metadata)||!contents.includes(syncFrame)||!contents.includes(pgsIndex))
      throw new Error('Review libbitsub readiness/repaint integration after upstream update.');
    // Expose initialization completion rather than treating parsed-data onLoaded
    // as presentation readiness. Forced host repaints also invalidate stale work.
    contents=contents.replace(indexed,'emitIndexed(format, metadata, partial) {\n        this.isPartialStream = Boolean(partial);\n        this.emitEvent({ type: \'indexed\', format, metadata, partial });\n    }')
      .replace(refresh,'refreshStreamPresentation() {\n        const mediaTime = typeof this.resolveMediaTime === \'function\' ? this.resolveMediaTime(this.video.currentTime) : this.video.currentTime;\n        const nextIndex = this.findCurrentIndex(mediaTime + this.timeOffset);\n        if (nextIndex === this.lastRenderedIndex) return;\n        this.renderAtMediaTime(mediaTime, true);\n    }')
      .replace(metadata,'this.loadedMetadataHandler = () => { this.frameScheduler?.start(); this.updateCanvasSize(); };')
      .replace(manual,'whenReady() { return this.waitUntilInitialized(); }\n    renderAtMediaTime(mediaTime, force = false) {\n        if (force) { this.invalidatePresentation(); this.lastRenderedIndex = -2; this.lastRenderedTime = -1; }\n        this.renderSynchronizedFrame({ mediaTime, presentedFrames: null });\n    }')
      .replace(syncFrame,'const effectiveMediaTime = typeof this.resolveMediaTime === \'function\' ? this.resolveMediaTime(tick.mediaTime) : tick.mediaTime;\n        const currentTime = effectiveMediaTime + this.timeOffset;')
      .replace(pgsIndex,'isSyncedAtMediaTime(mediaTime) {\n        if (!this.isPartialStream) return true;\n        const timestamps = (this.state.useWorker && this.state.workerReady) ? this.state.timestamps : (this.pgsParser?.getTimestamps() ?? this.state.timestamps);\n        return timestamps.length > 0 && timestamps[timestamps.length - 1] > Math.max(0, (mediaTime + this.timeOffset) * 1000);\n    }\n    findCurrentIndex(time) {\n        const timestamps = (this.state.useWorker && this.state.workerReady) ? this.state.timestamps : (this.pgsParser?.getTimestamps() ?? this.state.timestamps);\n        const index = (this.state.useWorker && this.state.workerReady) ? binarySearchTimestamp(timestamps, time * 1000) : (this.pgsParser?.findIndexAtTimestamp(time) ?? -1);\n        return this.isPartialStream && (index < 0 || index >= timestamps.length - 1) ? -1 : index;\n    }');
    return {contents,loader:'js'};
  });
}}]);
for(const name of ['jassub-worker.wasm','jassub-worker-modern.wasm'])fs.copyFileSync(path.join(root,'node_modules/jassub/dist/wasm',name),path.join(out,name));
fs.copyFileSync(path.join(root,'node_modules/jassub/dist/default.woff2'),path.join(out,'default.woff2'));
for(const name of ['libbitsub.js','libbitsub_bg.wasm'])fs.copyFileSync(path.join(root,'node_modules/libbitsub/pkg',name),path.join(out,name));
const notices=[];
for(const name of [...packages].sort()){
  const directory=path.join(root,'node_modules',name),pkg=JSON.parse(fs.readFileSync(path.join(directory,'package.json')));
  const license=[...['LICENSE','LICENSE.md','LICENSE.txt','LICENCE','license','license.md'].map(n=>path.join(directory,n)),path.join(root,'web/vendor/licenses',name+'.txt')].find(p=>fs.existsSync(p));
  if(!license && !['abslink','lfa-ponyfill','throughput'].includes(name))throw new Error('Missing upstream license for '+name);
  const declaration='Upstream author metadata: '+JSON.stringify(pkg.author || pkg.contributors || 'unspecified')+'\nRepository: '+JSON.stringify(pkg.repository)+'\n';
  const fallback=pkg.license==='Apache-2.0'?fs.readFileSync(path.join(root,'web/vendor/licenses/Apache-2.0.txt'),'utf8'):
    fs.readFileSync(path.join(root,'node_modules/jassub/LICENSE'),'utf8').split('\n').filter(line=>!/^Copyright/.test(line)).join('\n');
  notices.push(name+' '+pkg.version+' ('+pkg.license+')\n'+declaration+(license?fs.readFileSync(license,'utf8'):
    'Upstream package and repository omit a dedicated license file. Standard text for the declared license follows; upstream attribution clarification remains a publication gate.\n'+fallback));
}
notices.push('JASSUB native components: see ../licenses/JASSUB-components.txt and docs/third-party.md for source/build provenance.');
notices.push('uburoom modifies libbitsub asset URLs and overlay geometry during bundling. See scripts/build-subtitle-vendor.js. Upstream copyright and licenses are retained.');
notices.push('uburoom exposes libbitsub initialization completion and an optional forced manual repaint that invalidates prior presentation work.');
notices.push('uburoom bounds JASSUB worker disposal to one second if startup or worker IPC does not settle. See scripts/build-subtitle-vendor.js.');
notices.push('uburoom selects JASSUB transparent Canvas2D composition with synchronized presentation to avoid GPU overlays obscuring decoded video. libass layout and fonts are unchanged.');
fs.writeFileSync(path.join(out,'THIRD_PARTY_NOTICES.txt'),notices.join('\n-----\n\n'));
console.log('Built pinned subtitle modules, workers, WASM and notices.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
