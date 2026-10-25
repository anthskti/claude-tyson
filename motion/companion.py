"""Run local sensors/inference for the hosted client; never start Next or a database."""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import urlencode

from boxing_cv.companion_config import website_origin
from boxing_cv.iphone_bridge import choose_left, iproxy_command
from boxing_cv.model_bundle import load_model
from boxing_cv.outward_models import resolve_model

ROOT=Path(__file__).resolve().parents[1]
MOTION=ROOT/'motion'


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--website',default='https://claude-tyson.vercel.app',help='Exact production or preview origin with this feature deployed')
    p.add_argument('--left-log',type=Path)
    p.add_argument('--udid')
    p.add_argument('--check',action='store_true')
    p.add_argument('--no-open',action='store_true')
    a=p.parse_args()
    origin=website_origin(a.website)
    if sys.platform!='darwin': raise RuntimeError('The companion requires macOS')
    import cv2,mediapipe,websockets
    iproxy_command(18765,a.udid)
    for side in ('left','right'): load_model(resolve_model(side,side),side)
    for port in (8765,18765):
        with socket.socket() as probe:
            try: probe.bind(('127.0.0.1',port))
            except OSError as error:
                raise RuntimeError(f'Port {port} is already in use. Stop the previous local demo/companion first; no existing process was changed.') from error
    if not (ROOT/'assets/mediapipe/pose_landmarker_lite.task').exists():
        raise RuntimeError('Missing Pose model; download/extract the complete companion')
    if a.check:
        print(f'Companion check passed for {origin}. Original outward models; no sensors or servers started.')
        return
    if not a.left_log:
        app=MOTION/'collectors/build/AirPodsCollector.app'
        if not app.exists(): subprocess.run(['bash',str(MOTION/'collectors/build.sh')],check=True)
        subprocess.run(['open',str(app)],check=True)
    print('Start LEFT in the Mac collector; keep RIGHT on the iPhone collector over USB.',flush=True)
    deadline=time.monotonic()+120
    while True:
        try: left=choose_left(a.left_log);break
        except ValueError:
            if time.monotonic()>deadline: raise RuntimeError('No fresh left stream; start its recording and retry')
            time.sleep(.25)
    run=MOTION/'runs'/('companion-'+time.strftime('%Y%m%d-%H%M%S'))
    run.mkdir(parents=True,exist_ok=False)
    token=secrets.token_urlsafe(32)
    config=run/'pairing.private.json'
    with os.fdopen(os.open(config,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f:
        json.dump(dict(origin=origin,token=token),f)
    args=[sys.executable,'-m','boxing_cv.iphone_bridge','--source','airpod','--left-log',str(left),
          '--output',str(run/'usb'),'--launch-inference','--browser-config',str(config)]
    if a.udid: args+=['--udid',a.udid]
    child=None
    try:
        with (run/'motion.log').open('w',buffering=1) as log:
            child=subprocess.Popen(args,cwd=MOTION,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            url=origin+'/?input=airpods#'+urlencode(dict(motionToken=token))
            print(f'Open this private pairing link in Chrome/Edge:\n{url}\nLogs: {run}\nAllow local-network access for the site. Calibrate rest → straight → hook per hand in the native window.',flush=True)
            if not a.no_open: subprocess.run(['open',url],check=True)
            while child.poll() is None: time.sleep(.2)
            if child.returncode: raise RuntimeError(f'Companion stopped with code {child.returncode}; see {run}/motion.log')
    finally:
        if child and child.poll() is None:
            os.killpg(child.pid,signal.SIGINT)
            try: child.wait(timeout=12)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=3)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
        config.unlink(missing_ok=True)


if __name__=='__main__':
    try: main()
    except KeyboardInterrupt: pass
    except Exception as error: print(f'Companion: {error}',file=sys.stderr);sys.exit(1)
