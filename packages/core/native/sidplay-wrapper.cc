/*
 * cawtooth — PSID playback WASM wrapper
 *
 * Combines the vendored fake6502 MOS 6502 emulator, the vendored reSID
 * MOS 6581/8580 emulator, and 64 KB of RAM into a single standalone wasm
 * module sufficient to run PSID tunes.
 *
 * Usage from JS:
 *   cawtooth_sidplay_create(clock, sample_rate, model, method)
 *   cawtooth_sidplay_load(load_addr, bytes, length)
 *   cawtooth_sidplay_init(init_addr, song_num, play_addr, cycles_per_frame)
 *   cawtooth_sidplay_generate(buf, num_samples)   // repeat
 *   cawtooth_sidplay_destroy()
 *
 * fake6502 exposes its CPU state as globals (PC, SP, A, X, Y), so only one
 * CPU instance is live at a time. That's fine — real use is one PSID tune
 * playing at a time, and the SID chip instance is bound to the same wasm
 * module anyway.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "sid.h"

extern "C" {
    #include "fake6502.h"
}

using reSID::SID;
using reSID::sampling_method;
using reSID::cycle_count;

#define CAWTOOTH_EXPORT extern "C" __attribute__((used, visibility("default")))

namespace {

// A real C64 has 64 KB addressable. PSID tunes are "bare metal" and never
// touch I/O ROMs or the BASIC ROM (the $Axxx/$Exxx regions) — the loader
// drops the tune's binary into RAM and the init/play routines run
// self-contained. We model the whole address space as plain RAM plus a
// SID-register trap.
static uint8_t ram[65536];
static SID* sid = nullptr;

// Cached between init() and generate() so the caller doesn't have to pass
// them every frame.
static uint16_t play_addr_cached = 0;
static int32_t cycles_per_play_frame = 19656;  // PAL C64 default
static int32_t cycles_until_next_play = 0;

// Cap cycles spent inside a single JSR-equivalent. Init routines can be
// long (decompressors, table builds); play routines should finish in well
// under a frame. If we exceed the cap we bail rather than hanging the
// audio thread.
static const int32_t INIT_MAX_CYCLES = 20000000;   // ~20s of C64 time
static const int32_t PLAY_MAX_CYCLES = 500000;     // ~500ms of C64 time

// Sentinel RTS target: after calling init/play we want to detect return
// without installing real interrupt vectors. We push $0000 as the "return
// address" so RTS pulls $00,$00 and the 6502's RTS-increment makes PC=$0001.
// Then we watch for PC==$0001 and stop the step loop. $0001 on a real C64
// is the processor I/O port, but nothing in PSID init/play code ever
// branches through it as code, so this is a reliable sentinel.
static const uint16_t RETURN_SENTINEL = 0x0001;

} // namespace

// ----------------------------------------------------------------------------
// fake6502 bus callbacks.
// ----------------------------------------------------------------------------

extern "C" uint8_t read6502(uint16_t address) {
    // First SID lives at $D400 and mirrors at 32-byte intervals throughout
    // $D400-$D7FF. Real hardware mirrors across the whole $D400-$D7FF block.
    if ((address & 0xfc00) == 0xd400 && sid) {
        return (uint8_t)sid->read(address & 0x1f);
    }
    return ram[address];
}

extern "C" void write6502(uint16_t address, uint8_t value) {
    ram[address] = value;
    if ((address & 0xfc00) == 0xd400 && sid) {
        sid->write(address & 0x1f, value);
        // Match SidChip's behavior: 1-cycle advance after every SID write
        // so 8580+SAMPLE_FAST's pipelined writes don't clobber each other.
        // On other modes the tick is a no-op of negligible cost.
        cycle_count one = 1;
        sid->clock(one);
    }
}

// ----------------------------------------------------------------------------
// Helper: run a subroutine and wait for RTS-to-sentinel.
// ----------------------------------------------------------------------------

/**
 * Set up the CPU to call `entry` with accumulator `a` and run until it
 * returns (RTS to sentinel) or `max_cycles` are consumed. Returns the
 * cycle count on success, or -1 on timeout.
 */
static int32_t run_subroutine(uint16_t entry, uint8_t a, int32_t max_cycles) {
    // Sentinel return address: $0000 on the stack. When RTS pulls it, the
    // 6502 increments PC, landing at $0001 — our trap target.
    ram[0x01ff] = 0x00;
    ram[0x01fe] = 0x00;
    SP = 0xfd;
    A = a;
    X = 0;
    Y = 0;
    PC = entry;

    int32_t cycles = 0;
    while (PC != RETURN_SENTINEL && cycles < max_cycles) {
        cycles += step6502();
    }
    return (PC == RETURN_SENTINEL) ? cycles : -1;
}

// ----------------------------------------------------------------------------
// Public C-ABI.
// ----------------------------------------------------------------------------

/**
 * Initialize a new PSID playback session. Returns 1 on success, 0 on
 * failure. Safe to call multiple times — previous state is discarded.
 *
 *   clock_hz     CPU + SID clock frequency. PAL=985248, NTSC=1022727.
 *   sample_hz    Output audio sample rate (e.g. 44100).
 *   model        0 = MOS6581, 1 = MOS8580.
 *   method       reSID sampling_method: 0=fast,1=interpolate,2=resample,3=rfast.
 */
CAWTOOTH_EXPORT uint32_t cawtooth_sidplay_create(
    double clock_hz, double sample_hz, uint32_t model, uint32_t method
) {
    if (sid) {
        delete sid;
        sid = nullptr;
    }
    sid = new SID();
    sid->set_chip_model(model == 1 ? reSID::MOS8580 : reSID::MOS6581);
    sid->set_sampling_parameters(clock_hz, (sampling_method)method, sample_hz);
    sid->reset();
    memset(ram, 0, sizeof(ram));
    cycles_until_next_play = 0;
    cycles_per_play_frame = 19656;
    play_addr_cached = 0;
    reset6502();
    return 1;
}

CAWTOOTH_EXPORT void cawtooth_sidplay_destroy(void) {
    if (sid) {
        delete sid;
        sid = nullptr;
    }
}

/**
 * Copy `length` bytes of `data` into C64 memory starting at `load_addr`.
 * Clips at the end of the address space. Safe to call multiple times to
 * patch in extra data before init().
 */
CAWTOOTH_EXPORT void cawtooth_sidplay_load(
    uint16_t load_addr, const uint8_t* data, uint32_t length
) {
    uint32_t load = (uint32_t)load_addr;
    if (load + length > 65536) {
        length = 65536 - load;
    }
    memcpy(ram + load, data, length);
}

/**
 * Run the tune's init routine with the specified song number and cache
 * the play address + per-frame cycle budget for subsequent generate()
 * calls. Returns the number of CPU cycles consumed by the init routine,
 * or -1 if the init took longer than INIT_MAX_CYCLES.
 *
 * The song_num is 0-indexed per PSID convention — JS callers should pass
 * startSong-1, not startSong.
 */
CAWTOOTH_EXPORT int32_t cawtooth_sidplay_init(
    uint16_t init_addr,
    uint8_t song_num,
    uint16_t play_addr,
    int32_t cycles_per_frame
) {
    // Reset the SID so subsong changes start from a clean register state.
    // libsidplayfp does the same between subsongs; tunes commonly assume
    // power-on SID state in their init routine.
    if (sid) sid->reset();
    play_addr_cached = play_addr;
    cycles_per_play_frame = cycles_per_frame > 0 ? cycles_per_frame : 19656;
    cycles_until_next_play = 0;
    return run_subroutine(init_addr, song_num, INIT_MAX_CYCLES);
}

/**
 * Fill `buf` with `num_samples` mono int16 frames of audio. Internally
 * calls the tune's play routine each time the per-frame cycle budget
 * expires, then clocks the SID for the remaining cycles producing samples.
 */
CAWTOOTH_EXPORT void cawtooth_sidplay_generate(int16_t* buf, uint32_t num_samples) {
    if (!sid || num_samples == 0) return;

    uint32_t written = 0;
    while (written < num_samples) {
        // Time to fire the play routine?
        if (cycles_until_next_play <= 0) {
            if (play_addr_cached != 0) {
                run_subroutine(play_addr_cached, 0, PLAY_MAX_CYCLES);
            }
            cycles_until_next_play += cycles_per_play_frame;
        }

        cycle_count dt = cycles_until_next_play;
        uint32_t remaining = num_samples - written;
        int produced = sid->clock(dt, buf + written, (int)remaining);
        written += (uint32_t)produced;

        int32_t new_remaining = (int32_t)dt;
        // Safety: if the SID neither produced a sample nor consumed any
        // cycles, we'd loop forever. Force a small advance.
        if (produced == 0 && new_remaining == cycles_until_next_play) {
            new_remaining = 0;
        }
        cycles_until_next_play = new_remaining;
    }
}

/**
 * Same as `cawtooth_sidplay_generate` but also fills a per-voice tap
 * buffer (3 voices × num_samples, frame-interleaved: [f0_v0..v2, f1_v0..v2, ...]).
 *
 * Runs the play-routine / resampler loop one output sample at a time so
 * we can snapshot each voice's output at the right moment. See the
 * matching comment in resid-wrapper.cc for the voice-tap scaling (20-bit
 * voice output → int16 via >>5). This is slightly more overhead than
 * the bulk generate path; consumers that don't need scope output should
 * keep using `cawtooth_sidplay_generate`.
 */
CAWTOOTH_EXPORT void cawtooth_sidplay_generate_channels(
    int16_t* stereo_buf, int16_t* channels_buf, uint32_t num_samples
) {
    if (!sid || num_samples == 0) return;

    uint32_t written = 0;
    while (written < num_samples) {
        // Fire the play routine when the per-frame cycle budget expires.
        if (cycles_until_next_play <= 0) {
            if (play_addr_cached != 0) {
                run_subroutine(play_addr_cached, 0, PLAY_MAX_CYCLES);
            }
            cycles_until_next_play += cycles_per_play_frame;
        }

        cycle_count dt = cycles_until_next_play;
        int16_t sample = 0;
        int produced = sid->clock(dt, &sample, 1);
        int32_t new_remaining = (int32_t)dt;
        // Safety: if the SID consumed all cycles without producing a
        // sample, let the loop tick over to fire play on next iteration.
        if (produced == 0 && new_remaining == cycles_until_next_play) {
            new_remaining = 0;
        }
        cycles_until_next_play = new_remaining;

        if (produced > 0) {
            stereo_buf[written] = sample;
            channels_buf[written * 3 + 0] = (int16_t)(sid->voice_output(0) >> 5);
            channels_buf[written * 3 + 1] = (int16_t)(sid->voice_output(1) >> 5);
            channels_buf[written * 3 + 2] = (int16_t)(sid->voice_output(2) >> 5);
            written++;
        }
    }
}

/**
 * Read a single byte from emulated C64 RAM. Useful for tests that want to
 * verify the init routine set up some state correctly. Does NOT route SID
 * register reads — those come back from RAM's cached last-written value.
 */
CAWTOOTH_EXPORT uint8_t cawtooth_sidplay_peek(uint16_t address) {
    return ram[address];
}

/** Reset just the SID chip; leaves CPU state and RAM untouched. */
CAWTOOTH_EXPORT void cawtooth_sidplay_reset_sid(void) {
    if (sid) sid->reset();
}
