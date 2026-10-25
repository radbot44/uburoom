// @ts-check
/* Authenticated room messages, bounded reconnect and no command replay. */
/** @typedef {{token?: string, csrf?: string}} WatchSocketIdentity */
/** @typedef {{timeoutMs?: number, signal?: AbortSignal}} WatchRequestOptions */
(function(root) {
  'use strict';
  const CLOCK_TIMEOUT_MS=5000, HEARTBEAT_TIMEOUT_MS=30000;
  class WatchTransport {
    constructor(options={}) {
      const {url,identity,onReady=()=>{},onClose=()=>{},onMessage=()=>{},beginClock=()=>{},onClock=()=>{},clockTimeoutMs=CLOCK_TIMEOUT_MS,heartbeatTimeoutMs=HEARTBEAT_TIMEOUT_MS}=options;
      Object.assign(this,{url,identity,onReady,onClose,onMessage,beginClock,onClock,clockTimeoutMs,heartbeatTimeoutMs},options);
      this.pending=new Map();this.sequence=0;this.attempt=0;this.stopped=false;
    }
    connect() {
      if(this.ready&&this.socket?.readyState===1)return Promise.resolve();
      if(this.connecting)return this.connecting;
      this.stopped=false;
      this.connecting=new Promise((resolve,reject)=>{
        this.authResolve=resolve;this.authReject=reject;
        const socket=this.socket=new (this.WebSocket||WebSocket)(this.url);
        this.authTimer=setTimeout(()=>socket.close(),5000);
        socket.onopen=()=>socket.send(JSON.stringify({type:'auth',...this.identity()}));
        socket.onerror=()=>{};
        socket.onmessage=event=>{
          if(socket!==this.socket)return;
          this.lastReceivedAt=Date.now();
          if(this.ready)this.scheduleHeartbeat();
          try {
            const message=JSON.parse(event.data);
            if(message.type==='auth-ok') {
              clearTimeout(this.authTimer);this.ready=true;this.attempt=0;this.connecting=undefined;
              this.authResolve?.();this.authResolve=this.authReject=undefined;
              clearInterval(this.heartbeat);
              this.heartbeat=setInterval(()=>this.clock(),1000);this.clock();
              this.scheduleHeartbeat();
              Promise.resolve(this.onReady()).catch(()=>{});return;
            }
            if(message.type==='response'||message.type==='clock') {
              const pending=this.pending.get(message.id);if(!pending)return;
              this.pending.delete(message.id);clearTimeout(pending.timer);pending.cleanup?.();
              if(message.type==='clock')this.onClock(message,pending.exchange);
              if(message.status>=400){const error=new Error(message.value?.error||'Request failed');error.status=message.status;error.rejection=message.value?.rejection;pending.reject(error);}
              else pending.resolve(message.value);return;
            }
            this.onMessage(message);
          } catch { socket.close(4002,'Invalid server message'); }
        };
        socket.onclose=event=>{
          if(socket!==this.socket)return;
          this.ready=false;this.connecting=undefined;
          clearTimeout(this.authTimer);clearInterval(this.heartbeat);clearTimeout(this.heartbeatTimer);
          const error=new TypeError('Room connection lost; reconnecting');
          this.authReject?.(error);this.authResolve=this.authReject=undefined;
          for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.cleanup?.();pending.reject(error);}
          this.pending.clear();this.onClose({code:event?.code,reason:event?.reason,clean:event?.wasClean});
          if(!this.stopped){const delay=Math.max(this.resumeAt-Date.now()||0,Math.min(15000,500*2**Math.min(this.attempt++,5)));this.retry=setTimeout(()=>{void this.connect().catch(()=>{});},delay);}
        };
      });
      return this.connecting;
    }
    reauthenticate() {
      if(this.ready&&this.socket?.readyState!==1)this.socket.send(JSON.stringify({type:'auth',...this.identity()}));
    }
    scheduleHeartbeat() {
      clearTimeout(this.heartbeatTimer);
      const timeoutMs=this.heartbeatTimeoutMs||HEARTBEAT_TIMEOUT_MS;
      const socket=this.socket,deadline=Date.now()+timeoutMs;
      this.heartbeatTimer=setTimeout(()=>{
        if(socket!==this.socket)return;
        // A late timer also means receive callbacks may still be queued. Give
        // a waking tab a fresh exchange rather than closing a healthy socket.
        if(Date.now()-deadline<1000&&Date.now()-this.lastReceivedAt>=timeoutMs)socket.close(4000,'Server heartbeat timed out');
        else if(!this.stopped&&this.ready){this.scheduleHeartbeat();this.clock();}
      },timeoutMs);
    }
    clock() {
      if(!this.ready||this.socket?.readyState!==1||this.pending.size>=8)return;
      // One outstanding sample is enough. Clock exchange expiry is bounded to
      // the timing sample validity window so dropped exchanges can recover
      // promptly without waiting for the connection heartbeat deadline.
      if([...this.pending.values()].some(entry=>entry.clock))return;
      const id=++this.sequence,exchange=this.beginClock();
      const timer=setTimeout(()=>{
        this.pending.delete(id);
      },this.clockTimeoutMs||CLOCK_TIMEOUT_MS);
      this.pending.set(id,{resolve:()=>{},reject:()=>{},timer,exchange,clock:true});
      this.socket.send(JSON.stringify({type:'clock',id}));
    }
    syncQuality(value) {
      if(!this.ready||this.socket?.readyState!==1)return false;
      this.socket.send(JSON.stringify({type:'sync-quality',...value}));
      return true;
    }
    /** @param {string} path @param {Object|undefined} data @param {WatchRequestOptions} options */
    request(path,data,{timeoutMs=12000,signal}={}) {
      if(!this.ready||this.socket?.readyState!==1||this.pending.size>=8)return Promise.reject(new TypeError('Room connection unavailable; retry after reconnecting'));
      if(signal?.aborted)return Promise.reject(signal.reason);
      return new Promise((resolve,reject)=>{
        const id=++this.sequence;
        const cancel=()=>{const entry=this.pending.get(id);if(!entry)return;this.pending.delete(id);clearTimeout(entry.timer);entry.cleanup?.();reject(signal?.reason||new DOMException('Request timed out','TimeoutError'));};
        const timer=setTimeout(cancel,timeoutMs),cleanup=()=>signal?.removeEventListener('abort',cancel);
        this.pending.set(id,{resolve,reject,timer,cleanup});signal?.addEventListener('abort',cancel,{once:true});
        this.socket.send(JSON.stringify({type:'request',id,path,...(data===undefined?{}:{data})}));
      });
    }
    interrupt(milliseconds=6000) {this.resumeAt=Date.now()+milliseconds;this.socket?.close();}
    close() {this.stopped=true;clearTimeout(this.retry);clearInterval(this.heartbeat);clearTimeout(this.heartbeatTimer);this.socket?.close();}
  }
  root.uburoomWatchTransport=WatchTransport;
  if(typeof module==='object')module.exports=WatchTransport;
})(typeof globalThis==='object'?globalThis:this);
