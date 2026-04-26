import type { PsidClock, PsidFlags, PsidMagic, PsidSidModel, PsidSong } from './types.js';

const MAGIC_PSID = 0x50534944;
const MAGIC_RSID = 0x52534944;

const V1_HEADER_SIZE = 0x76;
const V2_HEADER_SIZE = 0x7c;

const CLOCK_TABLE: readonly PsidClock[] = ['unknown', 'PAL', 'NTSC', 'both'];
const MODEL_TABLE: readonly PsidSidModel[] = ['unknown', 'MOS6581', 'MOS8580', 'both'];

function readString(view: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  let end = bytes.indexOf(0);
  if (end < 0) end = length;
  // Windows-1252 is the canonical encoding per the HVSC spec; it covers
  // the Latin-1 range plus a few punctuation codepoints in 0x80–0x9F.
  return new TextDecoder('windows-1252').decode(bytes.subarray(0, end));
}

function decodeFlags(raw: number): PsidFlags {
  return {
    musPlayer: (raw & 0x01) !== 0,
    psidSpecific: (raw & 0x02) !== 0,
    clock: CLOCK_TABLE[(raw >> 2) & 0x3],
    sidModel: MODEL_TABLE[(raw >> 4) & 0x3],
    sidModel2: MODEL_TABLE[(raw >> 6) & 0x3],
    sidModel3: MODEL_TABLE[(raw >> 8) & 0x3],
  };
}

const DEFAULT_FLAGS: PsidFlags = {
  musPlayer: false,
  psidSpecific: false,
  clock: 'unknown',
  sidModel: 'unknown',
  sidModel2: 'unknown',
  sidModel3: 'unknown',
};

/**
 * Parse a PSID/RSID file.
 *
 * The returned `data` field is the C64 binary payload with any PRG-style
 * embedded load-address prefix already stripped — caller can blit `data`
 * verbatim into C64 memory starting at `loadAddress`.
 *
 * Throws on malformed files: bad magic, truncated header, unsupported
 * version, or payload smaller than a 2-byte load prefix when one is needed.
 */
export function parsePsid(buffer: ArrayBuffer | Uint8Array): PsidSong {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.length < V1_HEADER_SIZE) {
    throw new Error(`psid: file too short for v1 header (${bytes.length} < ${V1_HEADER_SIZE})`);
  }

  const magicWord = view.getUint32(0, false);
  let magic: PsidMagic;
  if (magicWord === MAGIC_PSID) magic = 'PSID';
  else if (magicWord === MAGIC_RSID) magic = 'RSID';
  else throw new Error(`psid: unrecognized magic 0x${magicWord.toString(16).padStart(8, '0')}`);

  const version = view.getUint16(4, false);
  if (version < 1 || version > 4) {
    throw new Error(`psid: unsupported version ${version} (expected 1–4)`);
  }

  const dataOffset = view.getUint16(6, false);
  const expectedOffset = version === 1 ? V1_HEADER_SIZE : V2_HEADER_SIZE;
  if (dataOffset !== expectedOffset) {
    throw new Error(
      `psid: version ${version} expects dataOffset=0x${expectedOffset.toString(16)}, ` +
        `got 0x${dataOffset.toString(16)}`,
    );
  }
  if (bytes.length < dataOffset) {
    throw new Error(
      `psid: file truncated — header claims ${dataOffset} bytes but file is ${bytes.length}`,
    );
  }

  const loadAddressField = view.getUint16(8, false);
  const initAddress = view.getUint16(10, false);
  const playAddress = view.getUint16(12, false);
  const songs = view.getUint16(14, false);
  const startSong = view.getUint16(16, false);
  const speed = view.getUint32(18, false);
  const name = readString(view, 22, 32);
  const author = readString(view, 54, 32);
  const released = readString(view, 86, 32);

  let flags = DEFAULT_FLAGS;
  let startPage = 0;
  let pageLength = 0;
  let secondSIDAddress = 0;
  let thirdSIDAddress = 0;

  if (version >= 2) {
    flags = decodeFlags(view.getUint16(118, false));
    startPage = view.getUint8(120);
    pageLength = view.getUint8(121);
  }
  if (version >= 3) {
    secondSIDAddress = view.getUint8(122);
  }
  if (version >= 4) {
    thirdSIDAddress = view.getUint8(123);
  }

  // Payload begins at dataOffset. If loadAddressField is 0, the first two
  // bytes of the payload are the PRG-style little-endian load address,
  // which we strip so `data` is a clean "blit into C64 memory" buffer.
  let data: Uint8Array;
  let loadAddress: number;
  if (loadAddressField === 0) {
    if (bytes.length < dataOffset + 2) {
      throw new Error('psid: loadAddress field is 0 but payload too short for embedded PRG header');
    }
    loadAddress = bytes[dataOffset] | (bytes[dataOffset + 1] << 8);
    data = bytes.subarray(dataOffset + 2);
  } else {
    loadAddress = loadAddressField;
    data = bytes.subarray(dataOffset);
  }

  return {
    magic,
    version: version as 1 | 2 | 3 | 4,
    dataOffset,
    loadAddress,
    initAddress: initAddress === 0 ? loadAddress : initAddress,
    playAddress,
    songs,
    startSong,
    speed,
    name,
    author,
    released,
    flags,
    startPage,
    pageLength,
    secondSIDAddress,
    thirdSIDAddress,
    data,
  };
}
