/** Framework-free local provider. Imports no camera, model or game dependencies. */
const types = new Set(['punch_left','punch_right','dodge_left','dodge_right','return_neutral']);
const finite = x => typeof x === 'number' && Number.isFinite(x);
export function validateSample(s) {
  if (s?.contractVersion !== 1 || s.kind !== 'cv_sample' || !Number.isSafeInteger(s.seq) || s.seq < 1 ||
      typeof s.fightId !== 'string' || typeof s.roundId !== 'string' || !['live','replay','synthetic'].includes(s.source)) return false;
  const o = s.observation, b = s.batch;
  if (o?.schemaVersion !== 1 || o.kind !== 'observation' || typeof o.sessionId !== 'string' ||
      !finite(o.timestampMs) || !finite(o.availableMs) || !['calibrating','good','degraded','lost'].includes(o.trackingState) ||
      !o.validity || !o.markers || !Array.isArray(s.events) || !b || b.lastSeq !== s.seq ||
      !Number.isSafeInteger(b.firstSeq) || b.firstSeq < 1 || b.firstSeq > s.seq ||
      b.coalescedObservations !== s.seq - b.firstSeq || !Number.isSafeInteger(s.producer?.resetGeneration)) return false;
  for (const key of ['dodge','punch_left','punch_right']) if (typeof o.validity[key] !== 'boolean') return false;
  for (const [key,p] of Object.entries(o.markers)) {
    if (!['head','left','right'].includes(key) || !finite(p?.x) || !finite(p?.y) || p.x<0 || p.x>1 || p.y<0 || p.y>1) return false;
    if (!o.validity[key === 'head' ? 'dodge' : 'punch_'+key]) return false;
  }
  return s.events.every(e => e.schemaVersion === 1 && typeof e.eventId === 'string' &&
    e.sessionId === o.sessionId && types.has(e.type) && e.sideConvention === 'player_anatomical' &&
    finite(e.onsetMs) && finite(e.sampleMs) && finite(e.detectedMs) && e.onsetMs<=e.sampleMs && e.sampleMs<=e.detectedMs);
}
export class CvProvider {
  constructor({url='ws://127.0.0.1:8765',onSample=()=>{},onState=()=>{},onReset=()=>{},
               freshnessMs=250,allowTestInput=false}={}) {
    Object.assign(this,{url,onSample,onState,onReset,freshnessMs,allowTestInput});
    this.pending=new Map();this.serial=0;this.ids=new Set();this.lastSeq=null;
    this.offset=null;this.uncertainty=null;this.receivedAt=null;this.lastSample=null;this.requiredGeneration=0;
  }
  request(kind,fields={}) {
    const requestId=String(++this.serial);
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error(kind+' timed out'));},2000);
      this.pending.set(requestId,{resolve,reject,timer});
      this.socket.send(JSON.stringify({contractVersion:1,kind,requestId,...fields}));
    });
  }
  async connect(context) {
    this.close();this.context=context;this.ids.clear();this.lastSeq=null;this.calibrationId=undefined;
    this.sessionId=undefined;this.requiredGeneration=0;this.offset=null;
    const socket=this.socket=new WebSocket(this.url);
    socket.onmessage=event=>{try{this.receive(JSON.parse(event.data));}catch{this.invalidate('invalid_json');socket.close();}};
    socket.onclose=()=>{this.clearPending('Disconnected');this.invalidate('disconnected');};
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=()=>reject(new Error('WebSocket connection failed'));});
    await this.syncClock();
    const ack=await this.request('set_context',context);this.sessionId=ack.sessionId;
    this.timer=setInterval(()=>this.checkFreshness(),50);
    this.syncTimer=setInterval(()=>this.syncClock().catch(()=>this.invalidate('clock_sync_failed')),30000);
    this.onState('connected');return ack;
  }
  async syncClock() {
    let best=null;
    for(let i=0;i<6;i++) {
      const c0=performance.now(),reply=await this.request('clock_sync',{clientSendMs:c0}),c3=performance.now();
      const rtt=(c3-c0)-(reply.serverSendMs-reply.serverReceiveMs);
      const offset=((reply.serverReceiveMs-c0)+(reply.serverSendMs-c3))/2;
      if(finite(rtt)&&rtt>=0&&finite(offset)&&(!best||rtt<best.rtt)) best={rtt,offset};
    }
    if(!best)throw new Error('No clock alignment sample');
    this.offset=best.offset;this.uncertainty=best.rtt/2;
  }
  mapTime(ms) { return this.offset === null ? null : ms-this.offset; }
  invalidate(reason) { this.lastSample=null;this.receivedAt=null;this.onReset(reason);this.onState(reason); }
  checkFreshness() {
    if(this.receivedAt!==null && (performance.now()-this.receivedAt>this.freshnessMs ||
       (this.lastSample?.source==='live' && performance.now()-this.mapTime(this.lastSample.observation.timestampMs)>this.freshnessMs))) this.invalidate('stale');
  }
  receive(message) {
    if(message.kind==='cv_error') {
      const request=this.pending.get(message.requestId);
      if(request){clearTimeout(request.timer);this.pending.delete(message.requestId);request.reject(new Error(message.reason));}
      else this.invalidate('producer_error');
      return;
    }
    const pending=this.pending.get(message.requestId);
    if(pending){clearTimeout(pending.timer);this.pending.delete(message.requestId);pending.resolve(message);return;}
    if(message.kind==='cv_hello') {
      if(message.contractVersion!==1 || message.observationSchemaVersion!==1 || message.motionSchemaVersion!==1) {
        this.invalidate('unsupported_version');this.socket?.close();
      }
      return;
    }
    if(message.kind==='cv_status'){this.invalidate(message.status);return;}
    if(!validateSample(message)){this.invalidate('invalid_contract');this.socket?.close();return;}
    if(message.fightId!==this.context.fightId||message.roundId!==this.context.roundId)return;
    if(this.sessionId!==undefined && message.observation.sessionId!==this.sessionId){this.invalidate('session_changed');this.socket?.close();return;}
    if(this.lastSeq!==null&&message.seq<=this.lastSeq)return;
    if(this.lastSeq!==null&&message.batch.firstSeq!==this.lastSeq+1){this.invalidate('sequence_gap');this.socket?.close();return;}
    this.lastSeq=message.seq;
    const now=performance.now(),live=message.source==='live',mapped=this.mapTime(message.observation.timestampMs);
    const age=live&&mapped!==null?now-mapped:null;
    if(live&&(age===null||age>this.freshnessMs||age<-(this.uncertainty??0)-5 ||
        message.events.some(e=>now-this.mapTime(e.sampleMs)>this.freshnessMs))) {this.invalidate('stale_sample');return;}
    if(this.calibrationId!==undefined&&this.calibrationId!==message.observation.calibrationId)this.onReset('calibration_changed');
    this.calibrationId=message.observation.calibrationId;
    const events=message.events.filter(e=>e.resetGeneration>=this.requiredGeneration&&!this.ids.has(e.eventId));
    for(const e of events)this.ids.add(e.eventId);
    while(this.ids.size>2048)this.ids.delete(this.ids.values().next().value);
    this.receivedAt=now;this.lastSample=message;
    const resetReady=message.producer.resetGeneration>=this.requiredGeneration;
    const canScore=resetReady&&message.observation.validity.dodge&&(live||this.allowTestInput)&&
                   (!live||this.uncertainty<=25);
    this.onSample({sample:message,events:resetReady?events:[],canScore,mappedSampleMs:live?mapped:null,
      latency:live?{sampleToReceiveMs:age,readToResultMs:message.trace.readToResultMs??null,
        producerToReceiveMs:finite(message.trace.sentMs)?now-this.mapTime(message.trace.sentMs):null,
        clockUncertaintyMs:this.uncertainty}:null});
  }
  async resetCalibration() {
    this.requiredGeneration=Infinity; // Pause immediately, including packets racing the ack.
    this.invalidate('reset_requested');
    const ack=await this.request('reset_calibration');this.requiredGeneration=ack.targetResetGeneration;return ack;
  }
  clearPending(reason) {for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(reason));}this.pending.clear();}
  close() {
    clearInterval(this.timer);clearInterval(this.syncTimer);this.clearPending('Closed');
    if(this.socket){this.socket.onclose=null;this.socket.close();this.socket=null;}
    this.lastSeq=null;this.receivedAt=null;this.lastSample=null;
  }
}
