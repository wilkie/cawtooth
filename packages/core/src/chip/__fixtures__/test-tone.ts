import type { OplRegisterWrite } from '../types.js';

/**
 * Register sequence that programs channel 0 on an OPL2/OPL3 chip with a
 * basic two-operator tone and triggers a key-on. Useful as a smoke-test
 * fixture: if the emulator is wired up correctly, generating samples after
 * applying these writes produces audible output.
 */
export const TEST_TONE_WRITES: readonly OplRegisterWrite[] = [
  { reg: 0x20, value: 0x01 }, // op1: mult=1
  { reg: 0x23, value: 0x01 }, // op2: mult=1
  { reg: 0x40, value: 0x10 }, // op1: total level (modulator)
  { reg: 0x43, value: 0x00 }, // op2: total level (carrier, full)
  { reg: 0x60, value: 0xf0 }, // op1: attack=F, decay=0
  { reg: 0x63, value: 0xf0 }, // op2: attack=F, decay=0
  { reg: 0x80, value: 0x77 }, // op1: sustain=7, release=7
  { reg: 0x83, value: 0x77 }, // op2: sustain=7, release=7
  { reg: 0xa0, value: 0x41 }, // F-Number low byte
  { reg: 0xb0, value: 0x32 }, // key-on=1, block=4, F-Number high bits
];
