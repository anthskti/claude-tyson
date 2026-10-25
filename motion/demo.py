"""Start the local game client and USB/IMU harness against the shared backend."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT=Path(__file__).resolve().parents[1]
MOTION=ROOT/'motion'
DEFAULT_HOST='wss://maincloud.spacetimedb.com'


def bun_path():
    path=shutil.which('bun') or str(MOTION/'.tools/node_modules/.bin/bun')
    if not Path(path).is_file(): raise RuntimeError('Run bash scripts/setup-motion-demo.sh first (Bun missing)')
    return path


def build_identity(env):
    digest=hashlib.sha256()
    paths=[p for folder in ['src','public','scripts','assets'] for p in (ROOT/folder).rglob('*')
           if p.is_file() and not (folder=='public' and 'cv' in p.relative_to(ROOT/'public').parts)]
    paths += [p for p in ROOT.iterdir() if p.is_file() and (p.name.startswith(('next.config','tsconfig','.env')) or p.name=='package.json')]
    for p in sorted(paths):
        digest.update(str(p.relative_to(ROOT)).encode());digest.update(p.read_bytes())
    digest.update(json.dumps({k:env[k] for k in ['NEXT_PUBLIC_STDB_HOST','NEXT_PUBLIC_STDB_DB']},sort_keys=True).encode())
    return digest.hexdigest()


def check_port(port):
    with socket.socket() as sock:
        try: sock.bind(('127.0.0.1',port))
        except OSError as e: raise RuntimeError(f'Port {port} already in use. Stop the previous demo/USB bridge first.') from e


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--left-log',type=Path,help='Use an already-running Mac collector instead of the packaged one')
    p.add_argument('--udid')
    p.add_argument('--dev',action='store_true',help='Next dev instead of a cached production build')
    p.add_argument('--record-video',action='store_true',help='Optional AVI evidence; off by default to reduce disk work')
    p.add_argument('--fast',action='store_true',help='Demo-only earlier predictions using separate fast weights for both hands')
    p.add_argument('--check',action='store_true',help='Verify dependencies, models and ports without opening sensors or starting processes')
    a=p.parse_args()
    if sys.platform!='darwin': raise RuntimeError('The live collector requires macOS')
    from boxing_cv.outward_models import resolve_model
    from boxing_cv.model_bundle import load_model, TARGET, FAST_TARGET
    from boxing_cv.outward_models import REGISTRY
    from boxing_cv.airpod_fast import FAST_REGISTRY
    from boxing_cv.iphone_bridge import choose_left, iproxy_command
    import cv2, mediapipe, websockets  # fail before starting any children
    bun=bun_path(); iproxy_command(18765,a.udid)
    registry=FAST_REGISTRY if a.fast else REGISTRY
    for side in ('left','right'):
        load_model(resolve_model(side,side,registry=registry),side,target=FAST_TARGET if a.fast else TARGET)
    print('Motion mode: '+('FAST DEMO (early targets, separate weights)' if a.fast else 'original outward'),flush=True)
    for port in (3001,8765,18765): check_port(port)
    if not (ROOT/'node_modules/next/package.json').exists(): raise RuntimeError('Frontend dependencies missing; run setup-motion-demo.sh')
    env=dict(os.environ)
    env['PATH']=str(Path(bun).parent)+os.pathsep+env.get('PATH','')
    env['NEXT_PUBLIC_STDB_HOST']=env.get('NEXT_PUBLIC_STDB_HOST') or DEFAULT_HOST
    env['NEXT_PUBLIC_STDB_DB']=env.get('NEXT_PUBLIC_STDB_DB') or 'claude-tyson'
    if not env['NEXT_PUBLIC_STDB_HOST'].startswith('wss://'):
        raise RuntimeError('Demo expects the shared secure backend; set NEXT_PUBLIC_STDB_HOST=wss://...')
    print(f"Frontend localhost:3001 → {env['NEXT_PUBLIC_STDB_HOST']} / {env['NEXT_PUBLIC_STDB_DB']}",flush=True)
    if a.check:
        print('Preflight passed. No sensors, app, backend mutation, or processes started.')
        return
    app=MOTION/'collectors/build/AirPodsCollector.app'
    if a.left_log is None:
        if not app.exists(): subprocess.run(['bash',str(MOTION/'collectors/build.sh')],check=True)
        subprocess.run(['open',str(app)],check=True)
    print('Start a LEFT recording in the Mac collector. On iPhone, select Right AirPod and tap Start; keep it open over USB.',flush=True)
    deadline=time.monotonic()+120
    while True:
        try: left=choose_left(a.left_log);break
        except ValueError:
            if time.monotonic()>=deadline: raise RuntimeError('No fresh left stream within 120s; start the collector, then retry')
            time.sleep(.25)
    stamp=time.strftime('%Y%m%d-%H%M%S')
    run=MOTION/'runs'/(('demo-fast-' if a.fast else 'demo-')+stamp)
    run.mkdir(parents=True,exist_ok=False)
    logs=[]; children=[]
    def spawn(args,name,cwd):
        log=(run/name).open('w',buffering=1);logs.append(log)
        child=subprocess.Popen(args,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        children.append(child);return child
    try:
        if not a.dev:
            fingerprint=build_identity(env); cache=MOTION/'.frontend-build.json'
            previous=json.loads(cache.read_text()) if cache.exists() else {}
            if not (ROOT/'.next/BUILD_ID').is_file() or previous.get('fingerprint')!=fingerprint:
                print('Building local production frontend...',flush=True)
                subprocess.run([bun,'run','build:demo'],cwd=ROOT,env=env,check=True)
                cache.write_text(json.dumps(dict(fingerprint=fingerprint)))
        frontend=spawn([bun,'run','dev' if a.dev else 'start:demo'],'frontend.log',ROOT)
        args=[sys.executable,'-m','boxing_cv.iphone_bridge','--source','airpod','--left-log',str(left),
              '--output',str(run/'usb'),'--launch-inference']
        if a.udid:args+=['--udid',a.udid]
        if a.record_video:args+=['--record-video']
        if a.fast:args+=['--fast']
        bridge=spawn(args,'motion.log',MOTION)
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if frontend.poll() is not None or bridge.poll() is not None:raise RuntimeError(f'Demo startup failed; see {run}')
            try:
                with urlopen('http://localhost:3001',timeout=1) as response:
                    if response.status==200:break
            except OSError:time.sleep(.25)
        else:raise RuntimeError('Frontend did not start within 60s')
        subprocess.run(['open','http://localhost:3001/?input=airpods'],check=True)
        print(f'Logs: {run}\nCalibrate in the native window: SPACE rest → straight → hook; TAB right; repeat.\nCtrl-C stops this demo and its USB forwarder. Collector apps can be stopped separately.',flush=True)
        while all(child.poll() is None for child in children):time.sleep(.2)
        for child in children:
            if child.poll() not in (None,0):raise RuntimeError(f'Demo child exited {child.returncode}; see {run}')
    finally:
        # Only children/process groups launched by this invocation are stopped.
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid,signal.SIGINT)
                try:child.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid,signal.SIGTERM)
                    try:child.wait(timeout=3)
                    except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
        for log in logs:log.close()


if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:pass
    except Exception as exc:print(f'Demo: {exc}',file=sys.stderr);sys.exit(1)
