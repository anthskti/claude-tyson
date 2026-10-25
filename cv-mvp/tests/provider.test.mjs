import test from 'node:test';
import assert from 'node:assert/strict';
import {CvProvider,validateSample} from '../web/cv-provider.js';
const packet=(seq=1,source='synthetic')=>({contractVersion:1,kind:'cv_sample',fightId:'f',roundId:'r',seq,source,
 observation:{schemaVersion:1,kind:'observation',sessionId:'s',timestampMs:10,availableMs:11,trackingState:'good',
 validity:{dodge:true,punch_left:true,punch_right:false},markers:{head:{x:.5,y:.3},left:{x:.7,y:.4}},calibrationId:'c'},
 producer:{resetGeneration:0},batch:{firstSeq:seq,lastSeq:seq,coalescedObservations:0},trace:{liveLatencyMeasurable:false},
 events:[{schemaVersion:1,eventId:'s-1',sessionId:'s',type:'punch_left',onsetMs:1,sampleMs:10,detectedMs:11,sideConvention:'player_anatomical',resetGeneration:0}]});
function client(){const deliveries=[],states=[],resets=[];const p=new CvProvider({allowTestInput:true,
 onSample:x=>deliveries.push(x),onState:x=>states.push(x),onReset:x=>resets.push(x)});p.context={fightId:'f',roundId:'r'};p.sessionId='s';return{p,deliveries,states,resets};}
test('wire validation rejects unsupported schema, invalid markers and event timing',()=>{
 assert.ok(validateSample(packet()));for(const mutate of [s=>s.contractVersion=2,s=>s.observation.markers.left.x=2,s=>s.events[0].sampleMs=12]){
 const s=packet();mutate(s);assert.equal(validateSample(s),false);}
});
test('one movement can be delivered once despite repeated packets/events',()=>{const{p,deliveries}=client();p.receive(packet());p.receive(packet());p.receive(packet(2));assert.equal(deliveries.length,2);assert.equal(deliveries[0].events.length,1);assert.equal(deliveries[1].events.length,0);});
test('announced observation coalescing is accepted, unexplained gaps pause input',()=>{
 const{p,states}=client();p.receive(packet());let s=packet(4);s.batch={firstSeq:2,lastSeq:4,coalescedObservations:2};p.receive(s);assert.equal(p.lastSeq,4);
 p.receive(packet(6));assert.ok(states.includes('sequence_gap'));
});
test('stale live samples never reach game delivery',()=>{const{p,deliveries,states}=client();p.offset=0;p.uncertainty=1;const s=packet(1,'live');s.observation.timestampMs=performance.now()-1000;p.receive(s);assert.equal(deliveries.length,0);assert.ok(states.includes('stale_sample'));});
test('synthetic data is unscorable unless explicitly enabled',()=>{const{p,deliveries}=client();p.allowTestInput=false;p.receive(packet());assert.equal(deliveries[0].canScore,false);assert.equal(deliveries[0].latency,null);});
test('reset generation excludes an event from before a queued reset',()=>{const{p,deliveries}=client();p.requiredGeneration=1;const s=packet();s.producer.resetGeneration=1;p.receive(s);assert.equal(deliveries[0].events.length,0);});
test('foreign fight or round is not forwarded',()=>{const{p,deliveries}=client();const s=packet();s.fightId='other';p.receive(s);assert.equal(deliveries.length,0);});
test('reset pauses scoring while acknowledgement is in flight',async()=>{
 const{p,deliveries}=client();let acknowledge;
 p.request=()=>new Promise(resolve=>{acknowledge=resolve;});
 const reset=p.resetCalibration();p.receive(packet());
 assert.equal(deliveries[0].canScore,false);assert.equal(deliveries[0].events.length,0);
 acknowledge({targetResetGeneration:1});await reset;
 const s=packet(2);s.producer.resetGeneration=1;s.events[0].resetGeneration=1;p.receive(s);
 assert.equal(deliveries[1].canScore,true);assert.equal(deliveries[1].events.length,1);
});
