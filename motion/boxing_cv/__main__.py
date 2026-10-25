"""Local demo only: two outward classifiers plus pose-only dodges."""
import argparse
from pathlib import Path
from types import SimpleNamespace
from .dual_airpod import run


def main():
    root=Path(__file__).resolve().parents[1]
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--airpod-streams',type=Path,required=True)
    p.add_argument('--output',type=Path)
    p.add_argument('--camera',type=int,default=0)
    p.add_argument('--bridge-port',type=int,default=8765)
    p.add_argument('--record-video',action='store_true')
    p.add_argument('--browser-config',type=Path,help='Private companion pairing configuration')
    p.add_argument('--seconds',type=float)
    p.add_argument('--save-preview',type=Path)
    p.add_argument('--no-mirror',action='store_true')
    a=p.parse_args()
    if not 1024<=a.bridge_port<=65535: p.error('Invalid game bridge port')
    # Keep tested capture settings; no hand model or alternative punch mode here.
    defaults=dict(models=root.parent/'assets/mediapipe',variant='lite',width=640,height=480,fps=30,
                  input_mirrored=False,calibrated_config=None,airpod_left_log=None,airpod_right_log=None,
                  airpod_left_model=None,airpod_right_model=None,headless=False,realtime=False)
    run(SimpleNamespace(**defaults,**vars(a)))


if __name__=='__main__': main()
