import { CaptureRate } from './capture-rate.js';

it('reduces work under shared pressure and recovers after a stable interval', () => {
  const rate = new CaptureRate();
  for (let time = 0; time <= 750; time += 250) rate.observe(false, true, time);
  expect(rate.bitrateScale).toBeLessThan(1);
  expect(rate.resolutionScale).toBeLessThan(1);
  const reduced = rate.fpsScale;
  for (let time = 1000; time <= 14_000; time += 250)
    rate.observe(true, false, time);
  expect(rate.fpsScale).toBe(reduced);
  for (let time = 14_250; time <= 17_000; time += 250)
    rate.observe(true, false, time);
  expect(rate.fpsScale).toBe(1);
});

it('does not treat isolated gaps on an idle display as sustained pressure', () => {
  const rate = new CaptureRate();
  for (const time of [0, 15_000, 30_000]) rate.observe(false, true, time);
  expect(rate.resolutionScale).toBe(1);
});

it('preserves quality for a fast viewer when another lags or waits for keyframes', () => {
  const rate = new CaptureRate();
  for (let time = 0; time < 20000; time += 100) {
    rate.observe(true, true, time);
    rate.observe(false, false, time);
  }
  expect(rate.bitrateScale).toBe(1);
});

it('reduces quality when blocked samples stay sparse and recovers only with sustained delivery', () => {
  const rate = new CaptureRate();
  for (const time of [0, 1600, 3200]) rate.observe(false, true, time);
  expect(rate.resolutionScale).toBe(0.85);

  for (const time of [20_000, 21_600, 23_200]) rate.observe(true, false, time);
  expect(rate.resolutionScale).toBe(0.85);
  for (let time = 24_800; time <= 37_600; time += 1600)
    rate.observe(true, false, time);
  expect(rate.resolutionScale).toBe(1);
});
