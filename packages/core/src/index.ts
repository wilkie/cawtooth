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
export { SidChip, SID_CLOCK_PAL, SID_CLOCK_NTSC, SID_VOICE_COUNT } from './chip/resid-sid.js';
export type { SidChipModel, SidChipOptions, SidSamplingMethod } from './chip/resid-sid.js';

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

export type { EndedListener, ProgressInfo, ProgressListener } from './audio/player-events.js';

export { SidPlayer } from './audio/sid-player.js';
export type { SidPlayerOptions } from './audio/sid-player.js';

export {
  asAyumiExports,
  compileAyumi,
  createAyumiImports,
  instantiateAyumi,
} from './chip/ayumi-loader.js';
export type { AyumiExports } from './chip/ayumi-loader.js';
export {
  AyumiChip,
  AY_VOICE_COUNT,
  AY_CLOCK_ZX,
  AY_CLOCK_ATARI_ST,
  AY_CLOCK_AMSTRAD_CPC,
  AY_CLOCK_MSX,
} from './chip/ayumi-chip.js';
export type { AyChipModel, AyChipOptions } from './chip/ayumi-chip.js';

export { AyPlayer } from './audio/ay-player.js';
export type { AyLoadStreamMetadata, AyPlayerOptions } from './audio/ay-player.js';

export { parsePsg } from './formats/ay/psg.js';
export { parseVtx } from './formats/ay/vtx.js';
export { parseYm } from './formats/ay/ym.js';
export { decompressLh5 } from './formats/ay/lh5.js';
export type { AySong } from './formats/ay/types.js';

export { AY_PROCESSOR_NAME } from './worklet/ay-processor-name.js';
export type {
  AyChannelsMessage,
  AyRegisterWrite,
  FromAyWorkletMessage,
  ToAyWorkletMessage,
} from './worklet/ay-messages.js';

export {
  renderToPcm,
  renderToWav,
  renderSidTuneToPcm,
  renderSidTuneToWav,
  encodeWav,
} from './audio/export.js';
export type { RenderToPcmOptions, RenderSidTuneOptions, EncodeWavOptions } from './audio/export.js';

export { OPL_PROCESSOR_NAME } from './worklet/opl-processor-name.js';
export type { FromWorkletMessage, ToWorkletMessage } from './worklet/messages.js';

export { SID_PROCESSOR_NAME } from './worklet/sid-processor-name.js';
export type {
  FromSidWorkletMessage,
  SidChannelsMessage,
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
  computeSidTuneMd5,
  lookupSongLengths,
  md5,
  parseSongLengthsDb,
} from './formats/psid/songlengths.js';
export type { SongLengths, SongLengthsDb } from './formats/psid/songlengths.js';
export {
  SidTune,
  PAL_CYCLES_PER_FRAME,
  NTSC_CYCLES_PER_FRAME,
  PSID_MAX_VOICE_COUNT,
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
export type { PsidPlayerCreateOptions } from './audio/psid-player.js';

export { Player } from './audio/player.js';
export type { AyPlayerInfo, OplPlayerInfo, PlayerInfo, PsidPlayerInfo } from './audio/player.js';
export type { OplLoadStreamMetadata } from './audio/opl-player.js';

export { CawtoothPlayer, detectFormat } from './audio/cawtooth-player.js';
export type {
  CawtoothFormatConfig,
  CawtoothLoadOptions,
  CawtoothPlayerOptions,
  DetectedFormat,
} from './audio/cawtooth-player.js';

export { parseOpl } from './transcode.js';
export type { ParseOplFormat, ParseOplOptions } from './transcode.js';

export { PSID_PROCESSOR_NAME } from './worklet/psid-processor-name.js';
export type {
  FromPsidWorkletMessage,
  ToPsidWorkletMessage,
  PsidReadyMessage,
} from './worklet/psid-messages.js';
