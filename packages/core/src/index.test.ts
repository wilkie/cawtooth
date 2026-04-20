import { VERSION } from './index.js';

describe('cawtooth', () => {
  it('exports a version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
