export type { Chip, OplChip, OplRegisterWrite, PerVoiceChip } from './chip/types.js';
export { OPL_CHANNEL_COUNT, supportsPerVoiceOutput } from './chip/types.js';
export {
  asNukedOpl3Exports,
  compileNukedOpl3,
  createNukedOpl3Imports,
  instantiateNukedOpl3,
} from './chip/loader.js';
export type { NukedOpl3Exports } from './chip/loader.js';
export { NukedOpl3Chip } from './chip/nuked-opl3.js';

export {
  asReSidExports,
  compileReSid,
  createReSidImports,
  instantiateReSid,
} from './chip/resid-loader.js';
export type { ReSidExports } from './chip/resid-loader.js';
export {
  SidChip,
  SID_CLOCK_PAL,
  SID_CLOCK_NTSC,
  SID_VOICE_COUNT,
} from './chip/resid-sid.js';
export type {
  SidChipModel,
  SidChipOptions,
  SidSamplingMethod,
} from './chip/resid-sid.js';

export type {
  RegisterEventStream,
  RegisterStreamTiming,
  TimedRegisterStream,
} from './sequencer/types.js';
export { RegisterSequencer } from './sequencer/register-sequencer.js';
export {
  dedupRegisterEventStream,
  windowedDedupRegisterEventStream,
} from './sequencer/transforms.js';

export { parseImf } from './formats/imf/parser.js';
export type { ImfSong, ParseImfOptions } from './formats/imf/parser.js';
export { encodeImf } from './formats/imf/encoder.js';
export type { EncodeImfOptions } from './formats/imf/encoder.js';

export { parseDro } from './formats/dro/parser.js';
export type { DroSong } from './formats/dro/parser.js';
export { encodeDro } from './formats/dro/encoder.js';
export type { EncodeDroOptions } from './formats/dro/encoder.js';

export { decompressHsq, readHsqHeader, isHsq } from './formats/herad/hsq.js';
export type { HsqHeader } from './formats/herad/hsq.js';

export { decompressSqx, readSqxHeader, isSqx } from './formats/herad/sqx.js';
export type { SqxHeader } from './formats/herad/sqx.js';

export { parseHerad, parseDecompressedHerad } from './formats/herad/parser.js';
export { renderHeradToStream } from './formats/herad/render.js';
export { parseHeradTrack } from './formats/herad/events.js';
export type { HeradEvent, HeradTimedEvent } from './formats/herad/events.js';
export { HERAD_INST_SIZE, HERAD_INSTMODE, HERAD_MAX_TRACKS } from './formats/herad/types.js';
export type {
  HeradInstrument,
  HeradKeymap,
  HeradPatch,
  HeradSong,
  HeradVariant,
  ParseHeradOptions,
} from './formats/herad/types.js';

export { OplPlayer } from './audio/opl-player.js';
export type { ChannelsListener, OplPlayerOptions } from './audio/opl-player.js';

export { SidPlayer } from './audio/sid-player.js';
export type { SidPlayerOptions } from './audio/sid-player.js';

export {
  renderToPcm,
  renderToWav,
  renderSidTuneToPcm,
  renderSidTuneToWav,
  encodeWav,
} from './audio/export.js';
export type {
  RenderToPcmOptions,
  RenderSidTuneOptions,
  EncodeWavOptions,
} from './audio/export.js';

export { OPL_PROCESSOR_NAME } from './worklet/opl-processor-name.js';
export type { FromWorkletMessage, ToWorkletMessage } from './worklet/messages.js';

export { SID_PROCESSOR_NAME } from './worklet/sid-processor-name.js';
export type {
  FromSidWorkletMessage,
  SidRegisterWrite,
  ToSidWorkletMessage,
} from './worklet/sid-messages.js';

export { parsePsid } from './formats/psid/parser.js';
export type {
  PsidClock,
  PsidFlags,
  PsidMagic,
  PsidSidModel,
  PsidSong,
} from './formats/psid/types.js';
export {
  SidTune,
  PAL_CYCLES_PER_FRAME,
  NTSC_CYCLES_PER_FRAME,
} from './formats/psid/runtime.js';
export type { SidTuneOptions } from './formats/psid/runtime.js';
export {
  asSidplayExports,
  compileSidplay,
  createSidplayImports,
  instantiateSidplay,
} from './formats/psid/sidplay-loader.js';
export type { SidplayExports } from './formats/psid/sidplay-loader.js';

export { PsidPlayer } from './audio/psid-player.js';
export type { PsidPlayerCreateOptions, PsidPlaybackInfo } from './audio/psid-player.js';

export { PSID_PROCESSOR_NAME } from './worklet/psid-processor-name.js';
export type {
  FromPsidWorkletMessage,
  ToPsidWorkletMessage,
  PsidReadyMessage,
} from './worklet/psid-messages.js';
