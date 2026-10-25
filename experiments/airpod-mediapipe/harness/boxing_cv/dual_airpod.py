"""Two source-pinned outward workers, one pose camera, independent hand state."""
from contextlib import ExitStack
from dataclasses import asdict
import json
import os
from pathlib import Path
from threading import Event, Thread
import time
import traceback
import uuid

from .airpod_outward import OutwardExperiment
from .calibrated_airpod import Settings
from .calibrated_runner import SampleTail
from .calibrated_runtime import AsyncLogs, SensorLoop

SIDES = ('left', 'right')


def source_types(manifest=None):
    sources = dict(left='airpod', right='airpod')
    if manifest:
        declared = json.loads(Path(manifest).read_text()).get('sources', {})
        if not isinstance(declared, dict) or set(declared)-set(SIDES):
            raise ValueError('Invalid sources in stream manifest')
        sources.update(declared)
    if sources['left'] != 'airpod' or sources['right'] not in ('airpod', 'iphone'):
        raise ValueError('Supported sources: left AirPod + right AirPod or iPhone')
    return sources


def input_paths(manifest=None, left=None, right=None):
    if manifest:
        if left or right:
            raise ValueError('Use --airpod-streams OR both per-side logs, not both')
        manifest = Path(manifest).resolve()
        data = json.loads(manifest.read_text())
        paths = {side: (manifest.parent/Path(data[side])).resolve() for side in SIDES}
    else:
        if not left or not right:
            raise ValueError('Dual mode requires --airpod-streams or --airpod-left-log and --airpod-right-log')
        paths = dict(left=Path(left).resolve(), right=Path(right).resolve())
    if not all(p.is_file() for p in paths.values()):
        raise ValueError('Both motion log files must exist; start the collectors first')
    if os.path.samefile(paths['left'], paths['right']):
        raise ValueError('Two different source files are required; one stream cannot represent both hands')
    return paths


class SideSink:
    """Per-hand logs plus one shared event feed; timestamps keep a common origin."""
    def __init__(self, side, local, combined, publisher=None):
        self.side, self.local, self.combined = side, local, combined
        self.files = local.files
        self.publisher = publisher

    def publish_snapshot(self, engine):
        if self.publisher: self.publisher.publish_snapshot(self.side, engine)

    @property
    def error(self):
        return self.local.error or self.combined.error

    def submit(self, names=(), value=None, console=None):
        self.local.submit(names, value, f'[{self.side.upper()}] {console}' if console else None)
        if 'events.jsonl' in names:
            if value['type'] != f'punch_{self.side}':
                raise ValueError('Punch event routed to the wrong hand')
            if self.publisher: self.publisher.punch(self.side, value)
            self.combined.submit(('events.jsonl',), dict(value, inputStream=self.side,
                                                       earbud=None if value.get('sourceType') == 'iphone' else self.side,
                                                       punchingHand=self.side))


def build_engines(settings, session, origin_unix, models=None, fast=False):
    from .airpod_fast import FastExperiment
    experiment=FastExperiment if fast else OutwardExperiment
    models = models or {}
    # Load/warm both models before following live logs; no startup backlog.
    return {side: experiment(settings, side, session+'-'+side, origin_unix,
                 hand=side, model_path=models.get(side), defer_reviews=True, calibration_policy='quick')
            for side in SIDES}


def draw_dual(preview, snapshots, selected, now, recent, fast=False):
    import cv2
    import numpy as np
    from .ui import BG, TEXT, MUTED, AMBER, GREEN, _wrap
    canvas = np.full((900, 1200, 3), BG, np.uint8)
    def text(s, x, y, color=TEXT, scale=.5):
        cv2.putText(canvas, str(s), (x,y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)
    text(('FAST DEMO' if fast else 'DUAL STATEFUL OUTWARD')+' | IMU PUNCHES | CV DODGING', 18, 28, scale=.63)
    text('TAB: select hand | SPACE: calibrate | R: recalibrate selected hand | Q: stop both',18,57,AMBER)
    h,w = preview.shape[:2]; ratio=min(450/w,220/h)
    view=cv2.resize(preview,(round(w*ratio),round(h*ratio)))
    canvas[77:77+view.shape[0],18:18+view.shape[1]]=view
    fresh = [side for side in SIDES if snapshots.get(side) and snapshots[side].sensor_state=='fresh']
    text('Fresh controller streams: '+(', '.join(fresh) or 'none'),500,106, GREEN if len(fresh)==2 else AMBER)
    for i,line in enumerate(_wrap('Verify each hand moves only its own stream. Right source may be AirPod or iPhone motion via USB. Relay estimates exclude sensor delivery and physical movement onset.',650,.48)):
        text(line,500,140+i*23,MUTED,.48)
    text('Selected hand: '+selected.upper(),500,253,AMBER,.65)
    for side,x in [('left',18),('right',615)]:
        snapshot=snapshots.get(side)
        source = 'IPHONE' if getattr(snapshot,'source_type','airpod') == 'iphone' else side.upper()+' BUD'
        text(source+' / '+side.upper()+' HAND'+('  [SELECTED]' if side==selected else ''),x,332,AMBER,.57)
        if snapshot is None:
            text('Waiting for sensor worker...',x,367);continue
        f=snapshot.last_features if snapshot.sensor_state=='fresh' else {}
        text(f'Sensor: {snapshot.sensor_state} | armed: {snapshot.detector.armed}',x,363)
        for i,line in enumerate(_wrap(snapshot.prompt(now),565,.46)[:3]):text(line,x,394+i*22,AMBER,.46)
        text(f"Prediction: {f.get('classification','--')} | {f.get('state','waiting')}",x,479)
        p=f.get('probabilities',{})
        text('  '.join(f'{k}: {p[k]:.2f}' if k in p else f'{k}: --' for k in ['straight','hook','non_punch']),x,510,scale=.46)
        text(f"Probability: {f.get('topProbability',0):.2f} / {f.get('minProbability','--')} | confirmations: {f.get('confirmationCount',0)}/{f.get('confirmationRequired',2)}",x,541,scale=.46)
        text(f"Rearm: {f.get('rearmCount',0)}/{f.get('rearmRequired',2)} | history: {f.get('historySpanMs',0):.0f}/2000 ms",x,572,scale=.46)
        text(f"Samples: {f.get('bufferSamples',0)} | consumed: {f.get('consumedSamples',0)} | model: {f.get('modelExecutionMs',0):.1f} ms",x,603,scale=.46)
        event=getattr(snapshot,'last_model_event',None)
        def delay(k):return '--' if not event or event.get(k) is None else f"{event[k]:.1f} ms"
        text('Last punch receipt -> event: '+delay('receiptToEventMs'),x,634,scale=.46)
        text('Confirmation -> event: '+delay('confirmationToEventMs'),x,662,scale=.46)
        transport = getattr(snapshot, 'transport', None) if snapshot.sensor_state == 'fresh' else None
        if isinstance(transport, dict) and transport.get('kind') == 'usb':
            text(f"USB relay ~{transport['estimatedRelayMs']:.1f} ms | clock +/-{transport['clockUncertaintyMs']:.1f} ms | RTT {transport['clockRoundTripMs']:.1f} ms",x,690,MUTED,.43)
        else:
            text('Physical movement latency: not measured',x,690,MUTED,.45)
        text('Blockers: '+(', '.join(f.get('blockedBy',[])) or '--'),x,719,AMBER,.43)
    text('COMBINED EVENTS (common session clock)',18,754,AMBER)
    for i,e in enumerate(sorted(recent,key=lambda e:e['sampleMs'])[-4:]):
        text(f"{e['sampleMs']/1000:.3f}s   {e['type']}   {e.get('punchType','pose')}",18,782+i*24,GREEN)
    return canvas


def validate_arguments(a):
    if any(getattr(a,k,None) for k in ('airpod_log','airpod_model','airpod_bud','airpod_hand','video','replay',
            'collect_dataset','dataset_plan','config','airpod_threshold_g','airpod_max_age_ms','arm_feature_diagnostics')):
        raise ValueError('Dual mode uses per-side logs/models and fixed left/left + right/right pairing; omit single-stream/replay/dataset/CV punch options')
    if a.headless or a.realtime:
        raise ValueError('Live dual calibration requires the preview; replay each saved side timeline separately')
    return input_paths(a.airpod_streams,a.airpod_left_log,a.airpod_right_log)


def run(a):
    paths=validate_arguments(a)
    import cv2
    from .capture import Capture
    from .inference import Inference
    from .recording import VideoRecorder
    from .config import Config
    from .detector import Detector
    from .calibrated_debug import event_line
    settings=Settings.load(a.calibrated_config)
    session=uuid.uuid4().hex[:12]; origin=time.perf_counter(); origin_unix=time.time()*1000
    fast=getattr(a,'fast',False)
    mode='fast' if fast else 'outward'
    window='Dual AirPod '+('FAST DEMO' if fast else 'outward')
    engines=build_engines(settings,session,origin_unix,dict(left=a.airpod_left_model,right=a.airpod_right_model),fast=fast)
    sources=source_types(a.airpod_streams)
    for side in SIDES: engines[side].source_type=sources[side]
    out=a.output or Path(__file__).resolve().parents[1]/'runs'/time.strftime(mode+'-dual-%Y%m%d-%H%M%S')
    out.mkdir(parents=True,exist_ok=False)
    stop,reset_head=Event(),Event(); sensors={}; tails={}; localsinks={}
    camera_enabled=Event(); camera_enabled.set()
    from .game_bridge import GameBridge
    publisher=GameBridge(session, origin_unix, camera_enabled, a.bridge_port, model_mode=mode).start()
    shared=dict(packet=None,error=None,done=False,frames=0,recent=())
    inference=capture=pose_thread=combined=None; error=None; last_preview=None
    metadata=dict(kind='metadata',schemaVersion=1,sessionId=session,punchMode='airpod-stateful-'+mode+'-dual',
        clockAlignment=dict(originUnixMs=origin_unix,method='same Mac receipt clock; sensor clocks remain independent'),
        inference='pose_only',handsInferenceEnabled=False,recordVideo=a.record_video,calibrationPolicy='quick_rest_straight_hook',
        streams={s:dict(sourceType=sources[s],earbud=None if sources[s]=='iphone' else s,
                        punchingHand=s,motionInput=str(paths[s]),model=engines[s].detector.metadata()) for s in SIDES},
        limitation='Concurrent software workers do not guarantee Core Motion supplies two independent devices')
    (out/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
    with ExitStack() as stack:
        names=('events.jsonl','pose-observations.jsonl','landmarks.jsonl','input.avi.timestamps.jsonl')
        combined=AsyncLogs({name:stack.enter_context((out/name).open('w')) for name in names})
        try:
            for side in SIDES:
                folder=out/side;folder.mkdir()
                names=('timeline.jsonl','diagnostics.jsonl','events.jsonl','trials.jsonl','raw-motion.jsonl')
                localsinks[side]=AsyncLogs({name:stack.enter_context((folder/name).open('w')) for name in names},profile_path=folder/'calibration.json')
            inference=Inference(a.models,a.variant,hands=False,schedule='sequential')
            capture=Capture(a.camera,origin,a.width,a.height,a.fps,a.input_mirrored).start()
            for side in SIDES:
                tail=SampleTail(paths[side]);tails[side]=tail
                meta=dict(kind='metadata',schemaVersion=1,sessionId=session+'-'+side,punchMode='airpod-stateful-'+mode,
                    airpodBud=side,airpodHand=side,punchingHand=side,
                    sourceType=sources[side],earbud=None if sources[side]=='iphone' else side,settings=asdict(settings),
                    modelTrainingSource='airpod',crossDeviceTransfer=sources[side]=='iphone',
                    experimentVersion=9,clockAlignment=metadata['clockAlignment'],model=engines[side].detector.metadata(),
                    motionInput=str(paths[side]),motionStartByteOffset=tail.offset,inference='pose_only',handsInferenceEnabled=False,
                    parentSessionId=session,recordVideo=False,sharedVideo='../input.avi',capture=capture.info)
                (out/side/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n')
                localsinks[side].submit(('timeline.jsonl',),meta)
                sink=SideSink(side,localsinks[side],combined,publisher)
                sensors[side]=SensorLoop(engines[side],tail,sink,stop)
                sensors[side].thread.name='airpod-'+side+'-classifier'
            for worker in sensors.values():worker.start()
            head=Detector(Config(),session_id=session)

            def pose_worker():
                nonlocal capture
                writer=None
                try:
                    while not stop.is_set():
                        if not camera_enabled.is_set():
                            if capture:
                                capture.close(); capture=None
                                publisher.pose(None, ())
                                shared['packet']=None
                            stop.wait(.02)
                            continue
                        if capture is None:
                            try:
                                capture=Capture(a.camera,origin,a.width,a.height,a.fps,a.input_mirrored).start()
                            except RuntimeError as exc:
                                shared['pose_error']=str(exc)
                                publisher.pose(None, ())
                                stop.wait(.5)
                                continue
                            shared['pose_error']=None
                            head.reset_calibration()
                        item=capture.take(timeout=.05)
                        if item is None:
                            if capture.finished:
                                if capture.error:
                                    shared['pose_error']=capture.error
                                    capture.close(); capture=None
                                    shared['packet']=None
                                    publisher.pose(None, ())
                                    stop.wait(.5)
                                    continue
                                break
                            continue
                        index,stamp,frame,_=item
                        record=inference.process(frame,stamp);record['capture_index']=index
                        completed=time.time()*1000;packet=(completed,record)
                        for worker in sensors.values():worker.pose_packet=packet
                        shared['packet']=(frame,record,completed);shared['frames']+=1
                        if reset_head.is_set():head.reset_calibration();reset_head.clear()
                        observation,events=head.process(record,int((time.perf_counter()-origin)*1000))
                        publisher.pose(observation, events)
                        combined.submit(('landmarks.jsonl',),record);combined.submit(('pose-observations.jsonl',),observation)
                        for event in events:
                            if not event['type'].startswith('punch_'):
                                combined.submit(('events.jsonl',),dict(event,inputStream='pose'),event_line(event))
                                shared['recent']=(*shared['recent'][-5:],event)
                        if a.record_video:
                            if writer is None:writer=VideoRecorder(out/'input.avi',capture.fps,(a.width,a.height))
                            combined.submit(('input.avi.timestamps.jsonl',),writer.write(frame,stamp))
                except Exception:
                    shared['error']=traceback.format_exc();stop.set()
                finally:
                    if capture: capture.close()
                    publisher.pose(None, ())
                    try:
                        if writer:writer.close()
                    except Exception:
                        shared['error']=traceback.format_exc();stop.set()
                    shared['done']=True

            pose_thread=Thread(target=pose_worker,name='dual-airpod-pose',daemon=True);pose_thread.start()
            selected='left';last_draw=0.
            print(f'Following LEFT: {paths["left"]}\nFollowing RIGHT: {paths["right"]}\nTAB selects calibration hand. No stream is copied to the other hand.',flush=True)
            while not stop.is_set():
                if publisher.error: raise RuntimeError(publisher.error)
                if combined.error or any(s.error for s in localsinks.values()):raise RuntimeError('Dual log writer failed')
                packet=shared['packet'];cycle=time.perf_counter()
                if cycle-last_draw>=1/30:
                    import numpy as np
                    frame=packet[0] if packet is not None else np.zeros((220,450,3),dtype=np.uint8)
                    preview=cv2.flip(frame,1) if not a.no_mirror else frame.copy()
                    snapshots={s:sensors[s].snapshot for s in SIDES}
                    recent=[e for snap in snapshots.values() if snap for e in snap.recent]+list(shared['recent'])
                    last_preview=draw_dual(preview,snapshots,selected,time.time()*1000,recent,fast=fast)
                    cv2.imshow(window,last_preview);last_draw=cycle
                if last_preview is not None:
                    key=cv2.waitKey(1)&0xff
                    if key in (27,ord('q')):break
                    if key==9:selected='right' if selected=='left' else 'left'
                    elif key in [8,127,32,ord('r'),ord('x'),*map(ord,'123456')]:
                        sensors[selected].command('space' if key==32 else 'backspace' if key in (8,127) else chr(key))
                        if key==ord('r'):reset_head.set()
                    if cv2.getWindowProperty(window,cv2.WND_PROP_VISIBLE)<1:break
                if shared['done']:break
                if shared['frames']==0 and camera_enabled.is_set() and cycle-origin>15:raise RuntimeError('No camera frame within 15 seconds')
                if a.seconds and cycle-origin>=a.seconds:break
                stop.wait(.005)
        except KeyboardInterrupt:
            pass
        except Exception as exc:
            error=repr(exc)
        finally:
            stop.set()
            publisher.close()
            if pose_thread is None and capture: capture.close()
            for worker in [*(w.thread for w in sensors.values()),pose_thread]:
                if worker:
                    worker.join(timeout=5)
                    if worker.is_alive():raise RuntimeError('Dual worker did not stop; logs may be incomplete')
            for side,tail in tails.items():
                try:tail.snapshot(out/side/'collector-motion.jsonl')
                except Exception as exc:error=error or str(exc)
                finally:tail.close()
            if inference:inference.close()
            cv2.destroyAllWindows()
            if a.save_preview and last_preview is not None:
                a.save_preview.parent.mkdir(parents=True,exist_ok=True)
                if not cv2.imwrite(str(a.save_preview),last_preview):error=error or 'Preview save failed'
            for side,sink in localsinks.items():
                for result in engines[side].finish_reviews():sink.submit(('diagnostics.jsonl',),result)
                sink.close()
            combined.close()
            error=error or shared['error'] or next((s.error for s in sensors.values() if s.error),None)
            state=dict(error=error,poseFrames=shared['frames'],streams={s:dict(sensorState=engines[s].sensor_state,
                calibrationReady=engines[s].detector.profile is not None,sensorSamples=w.samples,
                maxSensorCycleMs=w.max_cycle_ms,model=engines[s].detector.model_path) for s,w in sensors.items()})
            (out/'run-state.json').write_text(json.dumps(state,indent=2)+'\n')
    if error:raise RuntimeError(error)
    print(f'Dual logs: {out.resolve()} (combined events.jsonl; independent left/ and right/ logs)')
