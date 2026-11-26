import { CaptureRate } from './capture-rate.js';

it('reduces work under shared pressure and recovers after a stable interval', () => {
  const rate = new CaptureRate();
  for (let time = 0; time <= 4000; time += 250) rate.observe(false, true, time);
  expect(rate.bitrateScale).toBeLessThan(1);
  const reduced = rate.fpsScale;
  for (let time = 4250; time <= 14000; time += 250)
    rate.observe(true, false, time);
  expect(rate.fpsScale).toBe(reduced);
  for (let time = 14250; time <= 26000; time += 250)
    rate.observe(true, false, time);
  expect(rate.fpsScale).toBe(1);
});

it('preserves quality for a fast viewer when another lags or waits for keyframes', () => {
  const rate = new CaptureRate();
  for (let time = 0; time < 20000; time += 100) {
    rate.observe(true, true, time);
    rate.observe(false, false, time);
  }
  expect(rate.bitrateScale).toBe(1);
});
