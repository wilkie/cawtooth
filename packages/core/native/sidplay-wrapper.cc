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

// Up to 3 SID chips per v3/v4 PSID spec. Index 0 is the primary at
// $D400 (always present); 1 and 2 are optional extras at whatever
// address the tune's secondSIDAddress / thirdSIDAddress header bytes
// decode to. A zero base_addr means the slot is inactive.
static const int MAX_SIDS = 3;
static SID* sids[MAX_SIDS] = { nullptr, nullptr, nullptr };
static uint32_t sid_base[MAX_SIDS] = { 0xd400, 0, 0 };

// Parameters cached from create() so lazy-allocation of extra SIDs can
// mirror the primary's clock/sample/method without the caller needing
// to re-pass them.
static double chip_clock_freq = 985248.0;
static double chip_sample_freq = 44100.0;
static int chip_sampling_method = 2;  // SAMPLE_RESAMPLE

// Per-sample scratch for mixing extra SIDs into the primary's output
// buffer. 2048 caps us at whatever batch size a single generate() loop
// iteration asks for — comfortably above the ~880 samples a PAL vblank
// produces at 44.1 kHz.
static int16_t mix_scratch[2048];

// Cached between init() and generate() so the caller doesn't have to pass
// them every frame.
static uint16_t play_addr_cached = 0;
static int32_t cycles_per_play_frame = 19656;  // PAL C64 default
static int32_t cycles_until_next_play = 0;

// RSID-specific flag set at init. When true, the play routine is called
// "IRQ-style" (status + PC pushed onto the stack so the tune can end the
// handler with RTI) instead of as a plain JSR (RTS-ending).
static bool rsid_mode = false;

// Cap cycles spent inside a single JSR-equivalent. Init routines can be
// long (decompressors, table builds); play routines should finish in well
// under a frame. If we exceed the cap we bail rather than hanging the
// audio thread.
static const int32_t INIT_MAX_CYCLES = 20000000;   // ~20s of C64 time
static const int32_t PLAY_MAX_CYCLES = 500000;     // ~500ms of C64 time

// Sentinel for subroutine returns. For a JSR-style call we push $0000 as
// the "return address" so RTS pulls $00,$00 and the 6502's RTS-increment
// makes PC=$0001. For an IRQ-style (RTI-ending) call we push $0000,$0001
// for PC + a zero status byte, so RTI lands at exactly PC=$0001 too. In
// both cases we watch for PC==$0001 and stop the step loop. $0001 on a
// real C64 is the processor I/O port, but nothing in tune init/play code
// ever branches through it as code, so this is a reliable sentinel.
static const uint16_t RETURN_SENTINEL = 0x0001;

} // namespace

// ----------------------------------------------------------------------------
// fake6502 bus callbacks.
// ----------------------------------------------------------------------------

// Return the SID slot covering `address`, or -1 if none.
//
// Each SID exposes a 32-byte register window. The primary SID at $D400
// is widely mirrored throughout $D400-$D7FF on real hardware (every
// $20 bytes), which lots of tunes poke into; we honor that by matching
// any address in $D400-$D7FF against slot 0.
//
// Extras are checked FIRST on their strict 32-byte window, so a tune
// whose second SID sits inside $D400-$D7FF (e.g. secondSIDAddress=$42
// → $D420) has its writes routed to the secondary instead of being
// swallowed by the primary's mirror range.
static int find_sid_slot(uint16_t address) {
    for (int i = 1; i < MAX_SIDS; i++) {
        if (sid_base[i] != 0 && sids[i] && (address & ~0x1fu) == sid_base[i]) {
            return i;
        }
    }
    if ((address & 0xfc00) == 0xd400 && sids[0]) {
        return 0;
    }
    return -1;
}

extern "C" uint8_t read6502(uint16_t address) {
    int slot = find_sid_slot(address);
    if (slot >= 0) {
        return (uint8_t)sids[slot]->read(address & 0x1f);
    }
    return ram[address];
}

extern "C" void write6502(uint16_t address, uint8_t value) {
    ram[address] = value;
    int slot = find_sid_slot(address);
    if (slot >= 0) {
        sids[slot]->write(address & 0x1f, value);
        // Match SidChip's behavior: 1-cycle advance after every SID write
        // so 8580+SAMPLE_FAST's pipelined writes don't clobber each other.
        // On other modes the tick is a no-op of negligible cost.
        cycle_count one = 1;
        sids[slot]->clock(one);
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

/**
 * Set up the CPU to enter `entry` as if from a hardware IRQ and run
 * until the handler RTIs (or RTS-es, defensively) back to the sentinel.
 * RSID play routines live at the IRQ vector and end with RTI, which
 * pops 3 bytes (status + PC lo + PC hi) rather than RTS's 2-byte PC pop.
 *
 * Stack setup matches what hardware does on IRQ entry:
 *   [$01FF] = $00    <- PC high
 *   [$01FE] = $01    <- PC low    (RTI: PC high<<8 | PC low = $0001)
 *   [$01FD] = $00    <- status    (RTI pops this first; any value OK)
 *   SP = $FC
 */
static int32_t run_irq_handler(uint16_t entry, int32_t max_cycles) {
    ram[0x01ff] = 0x00;
    ram[0x01fe] = 0x01;
    ram[0x01fd] = 0x00;
    SP = 0xfc;
    A = 0;
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
    // Tear down any existing SID instances, including extras, so a
    // recreate starts from a clean slate.
    for (int i = 0; i < MAX_SIDS; i++) {
        if (sids[i]) {
            delete sids[i];
            sids[i] = nullptr;
        }
        sid_base[i] = (i == 0) ? 0xd400 : 0;
    }

    chip_clock_freq = clock_hz;
    chip_sample_freq = sample_hz;
    chip_sampling_method = (int)method;

    sids[0] = new SID();
    sids[0]->set_chip_model(model == 1 ? reSID::MOS8580 : reSID::MOS6581);
    sids[0]->set_sampling_parameters(clock_hz, (sampling_method)method, sample_hz);
    sids[0]->reset();

    memset(ram, 0, sizeof(ram));
    cycles_until_next_play = 0;
    cycles_per_play_frame = 19656;
    play_addr_cached = 0;
    reset6502();
    return 1;
}

CAWTOOTH_EXPORT void cawtooth_sidplay_destroy(void) {
    for (int i = 0; i < MAX_SIDS; i++) {
        if (sids[i]) {
            delete sids[i];
            sids[i] = nullptr;
        }
        sid_base[i] = 0;
    }
    sid_base[0] = 0xd400; // retain the convention even when empty
}

/**
 * Configure an extra SID chip (slot 1 or 2) living at `base_addr`.
 * Pass base_addr=0 to disable/tear down the slot. Uses the same clock,
 * sample rate, and sampling method as the primary SID so a multi-SID
 * tune sounds internally consistent. model is 0 (MOS6581) or 1 (MOS8580).
 *
 * Call this AFTER cawtooth_sidplay_create and BEFORE cawtooth_sidplay_init
 * so the init routine's register writes are routed correctly.
 */
CAWTOOTH_EXPORT void cawtooth_sidplay_set_extra_sid(
    uint32_t index, uint32_t base_addr, uint32_t model
) {
    if (index < 1 || index >= (uint32_t)MAX_SIDS) return;

    if (base_addr == 0) {
        // Disable this slot.
        if (sids[index]) {
            delete sids[index];
            sids[index] = nullptr;
        }
        sid_base[index] = 0;
        return;
    }

    if (!sids[index]) {
        sids[index] = new SID();
        sids[index]->set_sampling_parameters(
            chip_clock_freq, (sampling_method)chip_sampling_method, chip_sample_freq
        );
    }
    sids[index]->set_chip_model(model == 1 ? reSID::MOS8580 : reSID::MOS6581);
    sids[index]->reset();
    sid_base[index] = base_addr;
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
/**
 * Run the tune's init routine and resolve the per-frame play address +
 * interval.
 *
 * Parameters:
 *   init_addr, song_num, play_addr:
 *     From the PSID/RSID header. For RSID files play_addr is always 0 —
 *     the tune installs its own IRQ handler during init, and we read the
 *     resolved address from either $0314/$0315 (KERNAL soft vector) or
 *     $FFFE/$FFFF (CPU hardware vector) post-init.
 *   cycles_per_frame_vblank:
 *     Fallback period (PAL 19656 or NTSC 17095) used for vblank-speed
 *     subsongs, and for CIA-speed subsongs where init explicitly zeroes
 *     the timer.
 *   use_cia_timer:
 *     Non-zero → read CIA 1 Timer A post-init and use it as the play
 *     interval. Automatically forced for RSID files (always CIA-driven).
 *     Pre-programs CIA to the KERNAL default ($4025 PAL / $4295 NTSC)
 *     so tunes that don't reprogram CIA still get a sensible rate.
 *   is_rsid:
 *     Non-zero for RSID files. Changes playback behavior: the play
 *     routine is invoked IRQ-style (RTI-ending) instead of JSR-style,
 *     and we resolve play_addr from vectors if header said 0.
 *
 * Returns the number of CPU cycles consumed by init, or -1 on timeout.
 */
CAWTOOTH_EXPORT int32_t cawtooth_sidplay_init(
    uint16_t init_addr,
    uint8_t song_num,
    uint16_t play_addr,
    int32_t cycles_per_frame_vblank,
    uint32_t use_cia_timer,
    uint32_t is_rsid
) {
    // Reset all active SIDs so subsong changes start from a clean register
    // state. libsidplayfp does the same between subsongs; tunes commonly
    // assume power-on SID state in their init routine.
    for (int i = 0; i < MAX_SIDS; i++) {
        if (sids[i]) sids[i]->reset();
    }

    int32_t fallback = cycles_per_frame_vblank > 0 ? cycles_per_frame_vblank : 19656;
    rsid_mode = is_rsid != 0;

    // RSID tunes expect a closer-to-real C64 environment. Set up the
    // processor port at $01 to the standard banking (CPU sees RAM at
    // $0000-$9FFF, BASIC + I/O + KERNAL mapped above that). Clear the
    // KERNAL soft IRQ vector and the CPU IRQ vector so we can detect
    // which one (if any) the tune's init wires up.
    if (rsid_mode) {
        ram[0x0000] = 0x2f;  // data direction register: default
        ram[0x0001] = 0x37;  // processor port: KERNAL + BASIC + I/O all in
        ram[0x0314] = 0;
        ram[0x0315] = 0;
        ram[0xfffe] = 0;
        ram[0xffff] = 0;
    }

    // RSID playback is always CIA-timer-driven — the IRQ that invokes
    // the tune's play handler on real hardware comes from CIA 1 Timer A.
    // Force the CIA path so we pre-program the default and sample the
    // period the same way as a CIA-speed PSID subsong.
    uint32_t effective_cia = use_cia_timer || rsid_mode;

    // Pre-program CIA 1 Timer A before init.
    //
    // For CIA-speed subsongs, match the KERNAL default state a real C64
    // would have at the moment the player takes over — $4025 for PAL
    // ($4295 NTSC), which gives the jiffy-clock IRQ rate of ~60 Hz.
    // Some multi-speed tunes (e.g. Rob Hubbard's "The Human Race")
    // rely on this default being in place and never reprogram CIA in
    // their init routine. libsidplayfp does the same pre-set.
    //
    // For vblank-speed subsongs we zero the registers so stale CIA state
    // from a prior subsong doesn't leak into anything that reads them.
    if (effective_cia) {
        uint16_t default_cia = (fallback >= 19000) ? 0x4025 : 0x4295;
        ram[0xdc04] = (uint8_t)(default_cia & 0xff);
        ram[0xdc05] = (uint8_t)((default_cia >> 8) & 0xff);
    } else {
        ram[0xdc04] = 0;
        ram[0xdc05] = 0;
    }

    play_addr_cached = play_addr;
    cycles_until_next_play = 0;

    int32_t init_cycles = run_subroutine(init_addr, song_num, INIT_MAX_CYCLES);

    // RSID resolution: header play_addr is always 0. The tune's init
    // installed its own IRQ handler — check the KERNAL soft vector
    // ($0314/$0315) first (used by tunes that leave the KERNAL ROM
    // mapped), then the CPU hardware IRQ vector ($FFFE/$FFFF) for
    // tunes that bank out KERNAL. If both are zero we have no handler
    // and generate() will silently produce whatever the post-init SID
    // state emits.
    if (rsid_mode && play_addr_cached == 0) {
        uint16_t soft = (uint16_t)(ram[0x0314] | (ram[0x0315] << 8));
        uint16_t hard = (uint16_t)(ram[0xfffe] | (ram[0xffff] << 8));
        play_addr_cached = soft != 0 ? soft : hard;
    }

    if (effective_cia) {
        uint16_t period = (uint16_t)(ram[0xdc04] | (ram[0xdc05] << 8));
        // 0 is the only truly "bad" value — can happen if init explicitly
        // zeroed CIA. Fall back to vblank so we don't hang on zero-length
        // frames.
        cycles_per_play_frame = period > 0 ? (int32_t)period : fallback;
    } else {
        cycles_per_play_frame = fallback;
    }

    return init_cycles;
}

/** Return the resolved per-frame cycle budget, set by the most recent init. */
CAWTOOTH_EXPORT int32_t cawtooth_sidplay_get_play_interval(void) {
    return cycles_per_play_frame;
}

// Sum int16 samples from `src` into `dst` with saturation. Used to fold
// extra SID outputs into the primary SID's buffer.
static inline void sum_saturate(int16_t* dst, const int16_t* src, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) {
        int32_t s = (int32_t)dst[i] + (int32_t)src[i];
        if (s > 32767) s = 32767;
        else if (s < -32768) s = -32768;
        dst[i] = (int16_t)s;
    }
}

/**
 * Fill `buf` with `num_samples` mono int16 frames of audio. Internally
 * calls the tune's play routine each time the per-frame cycle budget
 * expires, then clocks each active SID for the remaining cycles and
 * sums the outputs into `buf`. Mixing uses saturating addition — two
 * or three SIDs at high levels will clip, matching what a real C64
 * playing a multi-SID tune through parallel chips would do.
 */
CAWTOOTH_EXPORT void cawtooth_sidplay_generate(int16_t* buf, uint32_t num_samples) {
    if (!sids[0] || num_samples == 0) return;

    uint32_t written = 0;
    while (written < num_samples) {
        // Time to fire the play routine?
        if (cycles_until_next_play <= 0) {
            if (play_addr_cached != 0) {
                if (rsid_mode) {
                    run_irq_handler(play_addr_cached, PLAY_MAX_CYCLES);
                } else {
                    run_subroutine(play_addr_cached, 0, PLAY_MAX_CYCLES);
                }
            }
            cycles_until_next_play += cycles_per_play_frame;
        }

        cycle_count dt_orig = cycles_until_next_play;
        uint32_t remaining = num_samples - written;

        // Primary SID: produce directly into buf.
        cycle_count dt0 = dt_orig;
        int produced = sids[0]->clock(dt0, buf + written, (int)remaining);

        // Extra SIDs: produce into scratch, saturate-sum into buf.
        for (int i = 1; i < MAX_SIDS; i++) {
            if (sid_base[i] != 0 && sids[i] && produced > 0) {
                int slot_remaining = produced;
                int slot_written = 0;
                while (slot_written < slot_remaining) {
                    int chunk = slot_remaining - slot_written;
                    int cap = (int)(sizeof(mix_scratch) / sizeof(mix_scratch[0]));
                    if (chunk > cap) chunk = cap;
                    cycle_count dti = dt_orig;
                    int produced_i = sids[i]->clock(dti, mix_scratch, chunk);
                    if (produced_i <= 0) break;
                    sum_saturate(
                        buf + written + slot_written,
                        mix_scratch,
                        (uint32_t)produced_i
                    );
                    slot_written += produced_i;
                }
            }
        }

        written += (uint32_t)produced;

        int32_t new_remaining = (int32_t)dt0;
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
 * buffer for oscilloscope use.
 *
 * Channels buffer layout is frame-interleaved with ALWAYS 9 voices
 * (3 voices × MAX_SIDS slots), even on single-SID tunes:
 *   [f0_SID1_V1, f0_SID1_V2, f0_SID1_V3,
 *    f0_SID2_V1, f0_SID2_V2, f0_SID2_V3,
 *    f0_SID3_V1, f0_SID3_V2, f0_SID3_V3,
 *    f1_SID1_V1, ...]
 *
 * Inactive SID slots are zero-filled so the caller can read a stable
 * stride of 9. The single-SID bandwidth cost is a handful of extra
 * Float32s per audio block — negligible.
 *
 * Runs the play-routine / resampler loop one output sample at a time so
 * each voice's output is snapshotted at the exact moment its stereo
 * sample is emitted. See the matching comment in resid-wrapper.cc for
 * the voice-tap scaling (20-bit voice output → int16 via >>5).
 */
CAWTOOTH_EXPORT void cawtooth_sidplay_generate_channels(
    int16_t* stereo_buf, int16_t* channels_buf, uint32_t num_samples
) {
    if (!sids[0] || num_samples == 0) return;

    const int VOICES_PER_SID = 3;
    const int STRIDE = VOICES_PER_SID * MAX_SIDS;

    uint32_t written = 0;
    while (written < num_samples) {
        // Fire the play routine when the per-frame cycle budget expires.
        if (cycles_until_next_play <= 0) {
            if (play_addr_cached != 0) {
                if (rsid_mode) {
                    run_irq_handler(play_addr_cached, PLAY_MAX_CYCLES);
                } else {
                    run_subroutine(play_addr_cached, 0, PLAY_MAX_CYCLES);
                }
            }
            cycles_until_next_play += cycles_per_play_frame;
        }

        cycle_count dt_orig = cycles_until_next_play;
        cycle_count dt0 = dt_orig;
        int16_t primary_sample = 0;
        int produced = sids[0]->clock(dt0, &primary_sample, 1);
        int32_t new_remaining = (int32_t)dt0;
        if (produced == 0 && new_remaining == cycles_until_next_play) {
            new_remaining = 0;
        }
        cycles_until_next_play = new_remaining;

        if (produced > 0) {
            // Sum extra SIDs into the stereo sample (same saturating mix
            // as the bulk generate path). Each extra SID is advanced
            // by the same dt_orig so its voice_output() snapshots align
            // with the primary's output sample.
            int32_t mix = (int32_t)primary_sample;
            for (int i = 1; i < MAX_SIDS; i++) {
                if (sid_base[i] != 0 && sids[i]) {
                    cycle_count dti = dt_orig;
                    int16_t s = 0;
                    int prod_i = sids[i]->clock(dti, &s, 1);
                    if (prod_i > 0) mix += s;
                }
            }
            if (mix > 32767) mix = 32767;
            else if (mix < -32768) mix = -32768;
            stereo_buf[written] = (int16_t)mix;

            // Per-voice taps for all slots; inactive slots are zero.
            int16_t* cb = channels_buf + written * STRIDE;
            for (int s = 0; s < MAX_SIDS; s++) {
                if (sid_base[s] != 0 && sids[s]) {
                    cb[s * VOICES_PER_SID + 0] = (int16_t)(sids[s]->voice_output(0) >> 5);
                    cb[s * VOICES_PER_SID + 1] = (int16_t)(sids[s]->voice_output(1) >> 5);
                    cb[s * VOICES_PER_SID + 2] = (int16_t)(sids[s]->voice_output(2) >> 5);
                } else {
                    cb[s * VOICES_PER_SID + 0] = 0;
                    cb[s * VOICES_PER_SID + 1] = 0;
                    cb[s * VOICES_PER_SID + 2] = 0;
                }
            }
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

/** Reset all active SID chips; leaves CPU state and RAM untouched. */
CAWTOOTH_EXPORT void cawtooth_sidplay_reset_sid(void) {
    for (int i = 0; i < MAX_SIDS; i++) {
        if (sids[i]) sids[i]->reset();
    }
}
