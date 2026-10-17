'use strict';
// Procedural solid rectangles, not third-party subtitle artwork or footage.
function pgs(){
  const out=[],u16=n=>[n>>8&255,n&255],u32=n=>[n>>>24,n>>>16&255,n>>>8&255,n&255];
  const segment=(type,payload,pts=90000)=>out.push(0x50,0x47,...u32(pts),0,0,0,0,type,...u16(payload.length),...payload);
  segment(0x16,[...u16(640),...u16(360),0x10,0,0,0x80,0,0,1,0,1,0,0,...u16(280),...u16(280)]);
  segment(0x17,[1,0,...u16(280),...u16(280),...u16(80),...u16(16)]);
  segment(0x14,[0,0,0,16,128,128,0,1,235,128,128,255]);
  const rle=Array.from({length:16},()=>[0,0xbf,1,0,0x91,1,0,0]).flat();
  segment(0x15,[0,1,0,0xc0,0,(rle.length+4)>>8,(rle.length+4)&255,...u16(80),...u16(16),...rle]);segment(0x80,[]);
  segment(0x16,[...u16(640),...u16(360),0x10,0,1,0,0,0,0],450000);segment(0x80,[],450000);
  return Buffer.from(out);
}
function vobsub(){
  const u16=n=>[n>>8&255,n&255],pixels=Array.from({length:16},()=>[0x01,0x41]).flat(),control=4+pixels.length;
  const commands=[1,3,0x32,0x10,4,0xff,0xf0,5,0x11,0x81,0x67,0x11,0x81,0x27,6,0,4,0,20,0xff];
  const next=control+4+commands.length,spu=[0,0,...u16(control),...pixels,0,0,...u16(next),...commands,...u16(352),...u16(next),2,0xff];
  spu[0]=spu.length>>8;spu[1]=spu.length&255;
  const payload=[0x80,0,0,0x20,...spu];
  return {data:Buffer.from([0,0,1,0xbd,...u16(payload.length),...payload]),index:Buffer.from('# VobSub index file, v7\nsize: 640x360\npalette: 000000, ffffff, 808080, 404040, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000\nid: en, index: 0\ntimestamp: 00:00:01:000, filepos: 000000000\n')};
}
function ass(){return Buffer.from('[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Liberation Sans,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,16,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,uburoom styled subtitle\nDialogue: 1,0:00:07.00,0:00:10.00,Default,,0,0,0,,{\\an8\\c&H00FFFF&}Positioned sign\n');}
module.exports={pgs,vobsub,ass};
