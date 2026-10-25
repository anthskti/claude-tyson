'use client';

import { useEffect } from 'react';

export default function FightPage() {
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    // Three.js and the SpacetimeDB client touch the browser, so load them after mount.
    void import('../game/main').then(mod => {
      if (cancelled) return;
      stop = mod.startGame();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return (
    <>
      <canvas id="scene" />
      <div id="hud" />
    </>
  );
}
