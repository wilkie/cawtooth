export type { OplChip, OplRegisterWrite } from './chip/types.js';
export { OPL_CHANNEL_COUNT } from './chip/types.js';
export {
  asNukedOpl3Exports,
  compileNukedOpl3,
  createNukedOpl3Imports,
  instantiateNukedOpl3,
} from './chip/loader.js';
export type { NukedOpl3Exports } from './chip/loader.js';
export { NukedOpl3Chip } from './chip/nuked-opl3.js';

export type {
  RegisterEventStream,
  RegisterStreamTiming,
  TimedRegisterStream,
} from './sequencer/types.js';
export { RegisterSequencer } from './sequencer/register-sequencer.js';

export { parseImf } from './formats/imf/parser.js';
export type { ImfSong, ParseImfOptions } from './formats/imf/parser.js';

export { parseDro } from './formats/dro/parser.js';
export type { DroSong } from './formats/dro/parser.js';

export { decompressHsq, readHsqHeader, isHsq } from './formats/hsq/decompress.js';
export type { HsqHeader } from './formats/hsq/decompress.js';

export { OplPlayer } from './audio/opl-player.js';
export type { ChannelsListener, OplPlayerOptions } from './audio/opl-player.js';

export { OPL_PROCESSOR_NAME } from './worklet/opl-processor-name.js';
export type { FromWorkletMessage, ToWorkletMessage } from './worklet/messages.js';
