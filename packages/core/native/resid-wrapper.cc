/*
 * cawtooth — reSID WASM wrapper
 *
 * Thin C-ABI shim exposing a minimal, pointer-stable API for driving Dag
 * Lem's reSID MOS 6581/8580 emulator from JavaScript. Compiled to WASM
 * by tools/build-wasm.sh.
 *
 * Parallel to wrapper.c (Nuked-OPL3): caller treats the returned handle
 * as opaque. The wrapper owns the C++ SID instance and tracks the clock
 * frequency so cawtooth_sid_generate can advance the chip for the caller
 * without requiring the caller to manage cycle budgets.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "sid.h"

using reSID::SID;
using reSID::chip_model;
using reSID::sampling_method;
using reSID::cycle_count;

#define CAWTOOTH_EXPORT extern "C" __attribute__((used, visibility("default")))

namespace {

struct SidHandle {
    SID* sid;
    double clock_freq;
    double sample_freq;
};

} // namespace

CAWTOOTH_EXPORT SidHandle* cawtooth_sid_create(
    double clock_freq,
    double sample_freq,
    uint32_t model,      // 0 = MOS6581, 1 = MOS8580
    uint32_t method      // matches reSID::sampling_method enum
) {
    SidHandle* h = (SidHandle*)malloc(sizeof(SidHandle));
    if (!h) {
        return 0;
    }
    h->sid = new SID();
    h->clock_freq = clock_freq;
    h->sample_freq = sample_freq;
    h->sid->set_chip_model(model == 1 ? reSID::MOS8580 : reSID::MOS6581);
    h->sid->set_sampling_parameters(
        clock_freq,
        (sampling_method)method,
        sample_freq
    );
    h->sid->reset();
    return h;
}

CAWTOOTH_EXPORT void cawtooth_sid_destroy(SidHandle* h) {
    if (!h) {
        return;
    }
    delete h->sid;
    free(h);
}

CAWTOOTH_EXPORT void cawtooth_sid_reset(SidHandle* h) {
    if (!h) {
        return;
    }
    h->sid->reset();
}

CAWTOOTH_EXPORT void cawtooth_sid_write(SidHandle* h, uint8_t offset, uint8_t value) {
    if (!h) {
        return;
    }
    h->sid->write(offset, value);
    // reSID models a 1-cycle write pipeline on MOS8580+SAMPLE_FAST. Until
    // something clocks the chip, a second write in that mode overwrites
    // the pending slot and the first write never lands. Advance one cycle
    // after every write so successive writes each commit. On other modes
    // the write is already committed, and a 1-cycle tick is well below
    // the sampler's resolution.
    cycle_count one = 1;
    h->sid->clock(one);
}

CAWTOOTH_EXPORT uint8_t cawtooth_sid_read(SidHandle* h, uint8_t offset) {
    if (!h) {
        return 0;
    }
    return (uint8_t)h->sid->read(offset);
}

/*
 * Fill `buf` with `num_samples` mono int16 frames.
 *
 * The wrapper converts sample-domain requests into cycle budgets for
 * reSID's clock() loop. We pass a generous delta_t each iteration (enough
 * cycles for the remaining samples plus a little headroom) and loop
 * until reSID has produced every requested sample. Any unused cycles
 * returned in delta_t are discarded — typically 0–1 cycles per batch.
 */
CAWTOOTH_EXPORT void cawtooth_sid_generate(SidHandle* h, int16_t* buf, uint32_t num_samples) {
    if (!h || num_samples == 0) {
        return;
    }
    uint32_t produced = 0;
    while (produced < num_samples) {
        uint32_t remaining = num_samples - produced;
        // Cycles needed to produce `remaining` samples, rounded up with
        // headroom. reSID will consume only what it needs and return the
        // rest in delta_t.
        double cycles_needed = (remaining * h->clock_freq) / h->sample_freq;
        cycle_count delta_t = (cycle_count)(cycles_needed + 16.0);
        int written = h->sid->clock(delta_t, buf + produced, (int)remaining);
        if (written <= 0) {
            // Defensive: reSID didn't advance. Force a minimum cycle batch
            // to avoid an infinite loop on pathological clock ratios.
            cycle_count forced = 256;
            h->sid->clock(forced, buf + produced, (int)remaining);
            // If still nothing, bail rather than hang.
            break;
        }
        produced += (uint32_t)written;
    }
}

/**
 * Fill `stereo_buf` with `num_samples` mono int16 frames AND
 * `channels_buf` with per-voice taps (3 voices × num_samples, frame-
 * interleaved: [f0_v0, f0_v1, f0_v2, f1_v0, ...]).
 *
 * Per-voice values are snapshots taken immediately after each output
 * sample's clock call — they track the stereo output with at most one
 * native-cycle of lag, similar to the OPL per-channel tap. Scope view
 * cares about shape and activity, not perfect phase, so this is fine.
 *
 * The loop emits one sample per clock() call so we get per-sample voice
 * snapshots. This is more overhead than our bulk `cawtooth_sid_generate`
 * path and slightly lowers effective sampling quality with SAMPLE_RESAMPLE
 * (the resampler still runs, just one sample at a time); consumers who
 * don't need scope output should keep using `cawtooth_sid_generate`.
 */
CAWTOOTH_EXPORT void cawtooth_sid_generate_channels(
    SidHandle* h, int16_t* stereo_buf, int16_t* channels_buf, uint32_t num_samples
) {
    if (!h || num_samples == 0) return;

    for (uint32_t i = 0; i < num_samples; i++) {
        double cycles_needed = h->clock_freq / h->sample_freq;
        cycle_count delta_t = (cycle_count)(cycles_needed + 16.0);
        int16_t sample = 0;
        int written = h->sid->clock(delta_t, &sample, 1);
        if (written <= 0) {
            // Defensive: force a minimum cycle batch to avoid stalling.
            cycle_count forced = 256;
            h->sid->clock(forced, &sample, 1);
        }
        stereo_buf[i] = sample;
        // Voice outputs are 20-bit signed ([-2048*255, 2047*255]); shift
        // to int16 range. >>5 = divide by 32 ≈ 0x7FFFF / 32 = 0x3FFF,
        // which keeps individual voices well below clipping even when
        // several play at max amplitude simultaneously.
        channels_buf[i * 3 + 0] = (int16_t)(h->sid->voice_output(0) >> 5);
        channels_buf[i * 3 + 1] = (int16_t)(h->sid->voice_output(1) >> 5);
        channels_buf[i * 3 + 2] = (int16_t)(h->sid->voice_output(2) >> 5);
    }
}

CAWTOOTH_EXPORT uint32_t cawtooth_sid_handle_size(void) {
    return (uint32_t)sizeof(SidHandle);
}
