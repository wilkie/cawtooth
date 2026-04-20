export type { OplChip, OplRegisterWrite } from './chip/types.js';
export {
  asNukedOpl3Exports,
  compileNukedOpl3,
  createNukedOpl3Imports,
  instantiateNukedOpl3,
} from './chip/loader.js';
export type { NukedOpl3Exports } from './chip/loader.js';
export { NukedOpl3Chip } from './chip/nuked-opl3.js';

export { OplPlayer } from './audio/opl-player.js';
export type { OplPlayerOptions } from './audio/opl-player.js';

export { OPL_PROCESSOR_NAME } from './worklet/opl-processor-name.js';
export type { FromWorkletMessage, ToWorkletMessage } from './worklet/messages.js';
