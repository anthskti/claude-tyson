import { CvProvider } from './cv-provider.js';
import { toPlayerActions, type PlayerAction, type CvObservation } from './contracts';
/** Supply your actual SpacetimeDB reducer/renderer methods; no SDK assumptions here. */
export function attachCv(fightId: string, roundId: string, hooks: {
  render: (observation: CvObservation) => void;
  submitPlayerAction: (action: PlayerAction) => void;
  clearTransientInputs: (reason: string) => void;
}) {
  const provider = new CvProvider({
    onReset: hooks.clearTransientInputs,
    onSample: ({ sample, events, canScore }) => {
      hooks.render(sample.observation); // Optional wrist/head markers, canonical x/y.
      if (!canScore) return;
      for (const action of toPlayerActions({ ...sample, events }, ms => provider.mapTime(ms))) {
        hooks.submitPlayerAction(action); // Fire-and-forget reducer dispatch; server validates.
      }
    },
  });
  void provider.connect({ fightId, roundId }).catch(error => hooks.clearTransientInputs(String(error)));
  return () => provider.close();
}
