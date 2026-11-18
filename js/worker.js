// Runs the Monte Carlo off the main thread.
import { evaluate } from './mc.js';
import { Polar } from './polar.js';
import { WindField } from './wind.js';

self.onmessage = (e) => {
  const { id, cal, preset, course, wind, snap, options, n, horizon, seed, ghostTracks } = e.data;
  try {
    Object.setPrototypeOf(wind, WindField.prototype);
    const polar = new Polar(cal.polar);
    const out = evaluate({
      snap, ctx: { cal, polar, preset, course, wind, ghostTracks }, options, n, horizon, seed,
      onProgress: (p) => self.postMessage({ id, progress: p }),
    });
    self.postMessage({ id, result: out });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
