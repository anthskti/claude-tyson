"""Fit the straight vs hook model from smoke-page labeled recordings.

    python scripts/fit_punch_types.py labeled-punches-*.json --out configs/punch-types.json
    python -m cv_mvp --camera 0 --punch-config configs/punch-types.json

Prints the current classifier's confusion table, how well each feature separates
straights from hooks, then fits a small logistic model (leave-one-out checked) and
writes it as a punch config. Older recordings labeled jab/cross count as straight.
Needs numpy (installed with the camera extra).
"""

import argparse
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cv_mvp.punch_type import FEATURES, PunchTypeConfig  # noqa: E402

KINDS = ("straight", "hook")
OLD = {"jab": "straight", "cross": "straight"}  # recordings from before the rename


def table(rows, title):
    print(f"\n{title}\n  threw \\ detected " + "".join(f"{k:>7}" for k in KINDS))
    for k in KINDS:
        mine = [r for r in rows if r[0] == k]
        print(f"  {k:>8} ({len(mine):>3})   " + "".join(f"{sum(1 for r in mine if r[1] == d):>7}" for d in KINDS))
    correct = sum(1 for r in rows if r[0] == r[1])
    print(f"  accuracy {correct}/{len(rows)} = {correct / max(len(rows), 1):.0%}")


def fit(x, y, l2=0.1, steps=3000, lr=0.1):
    w, b = np.zeros(x.shape[1]), 0.0
    for _ in range(steps):
        p = 1 / (1 + np.exp(-(x @ w + b)))
        w -= lr * (x.T @ (p - y) / len(y) + l2 * w / len(y))
        b -= lr * float(np.mean(p - y))
    return w, b


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, default=Path("configs/punch-types.json"))
    ap.add_argument("--min-coverage", type=float, default=0.8, help="Use features present in this fraction of punches")
    a = ap.parse_args()

    punches = []
    for f in a.files:
        for p in json.loads(f.read_text())["punches"]:
            p = dict(p, label=OLD.get(p.get("label"), p.get("label")), punchType=OLD.get(p.get("punchType"), p.get("punchType")))
            if p["label"] in KINDS and p.get("features"):
                punches.append(p)
    table([(p["label"], p["punchType"]) for p in punches], "Current classifier")

    y = np.array([p["label"] == "hook" for p in punches], dtype=float)
    if y.sum() < 5 or (1 - y).sum() < 5:
        sys.exit(f"Need at least 5 hooks and 5 straights; got {int(y.sum())} hooks, {int((1 - y).sum())} straights")

    print("\nFeature separation (straight vs hook means; best single threshold)")
    names = []
    for name in FEATURES:
        vals = [p["features"].get(name) for p in punches]
        present = np.array([v is not None for v in vals])
        coverage = present.mean()
        if not present.any():
            print(f"  {name:>18}  never measured")
            continue
        v = np.array([x if x is not None else np.nan for x in vals], dtype=float)
        best = max(((np.mean((v[present] >= t) == y[present].astype(bool)) if s else np.mean((v[present] < t) == y[present].astype(bool)), t, s)
                    for t in np.unique(v[present]) for s in (True, False)))
        print(f"  {name:>18}  straight {np.nanmean(v[y == 0]):7.2f}  hook {np.nanmean(v[y == 1]):7.2f}"
              f"  hook if {'>=' if best[2] else '<'} {best[1]:.2f} -> {best[0]:.0%}  (measured {coverage:.0%})")
        if coverage >= a.min_coverage:
            names.append(name)
    if not names:
        sys.exit("No feature was measured often enough; keep elbows and hands in frame")

    raw = np.array([[p["features"].get(n) if p["features"].get(n) is not None else np.nan for n in names] for p in punches], dtype=float)
    mean = np.nanmean(raw, axis=0)
    std = np.nanstd(raw, axis=0)
    std[std < 1e-6] = 1.0
    x = np.nan_to_num((raw - mean) / std)  # missing -> mean, the model's neutral value
    w, b = fit(x, y)

    loo = np.zeros(len(y))
    for i in range(len(y)):
        keep = np.arange(len(y)) != i
        wi, bi = fit(x[keep], y[keep])
        loo[i] = 1 / (1 + np.exp(-(x[i] @ wi + bi)))

    table([(p["label"], "hook" if q >= 0.5 else "straight") for p, q in zip(punches, loo)], "Fitted model, leave-one-out (honest estimate)")
    unsure = np.mean((loo > 0.35) & (loo < 0.65))
    print(f"  {unsure:.0%} of punches would wait up to defer_ms for more motion")
    print("\nWeights (standardized; positive = more hook-like)")
    for n, wi in sorted(zip(names, w), key=lambda t: -abs(t[1])):
        print(f"  {n:>18} {wi:+.2f}")

    config = json.loads(a.out.read_text()) if a.out.exists() else {}
    config.pop("stance", None)
    config.update(model=dict(features=names, mean=mean.tolist(), std=std.tolist(),
                                               weights=w.tolist(), bias=b, trainedOn=len(punches)))
    PunchTypeConfig(**config).validate()
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(config, indent=2) + "\n")
    print(f"\nWrote {a.out}. Run: python -m cv_mvp --camera 0 --punch-config {a.out}")


if __name__ == "__main__":
    main()
