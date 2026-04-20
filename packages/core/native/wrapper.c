/*
 * cawtooth — Nuked-OPL3 WASM wrapper
 *
 * Thin C shim exposing a minimal, pointer-stable API for driving the Nuked-OPL3
 * emulator from JavaScript. Compiled to WASM by tools/build-wasm.sh.
 *
 * The chip instance is heap-allocated; the JS side keeps the returned pointer
 * opaque and passes it back into subsequent calls.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "opl3.h"

#define CAWTOOTH_EXPORT __attribute__((used, visibility("default")))

CAWTOOTH_EXPORT opl3_chip* cawtooth_opl_create(uint32_t sample_rate) {
    opl3_chip* chip = (opl3_chip*)malloc(sizeof(opl3_chip));
    if (!chip) {
        return 0;
    }
    memset(chip, 0, sizeof(opl3_chip));
    OPL3_Reset(chip, sample_rate);
    return chip;
}

CAWTOOTH_EXPORT void cawtooth_opl_destroy(opl3_chip* chip) {
    if (chip) {
        free(chip);
    }
}

CAWTOOTH_EXPORT void cawtooth_opl_reset(opl3_chip* chip, uint32_t sample_rate) {
    OPL3_Reset(chip, sample_rate);
}

CAWTOOTH_EXPORT void cawtooth_opl_write(opl3_chip* chip, uint16_t reg, uint8_t value) {
    OPL3_WriteReg(chip, reg, value);
}

/*
 * Fill `buf` with `num_samples` stereo-interleaved int16 frames.
 * Caller must ensure buf has capacity >= num_samples * 2 * sizeof(int16_t).
 */
CAWTOOTH_EXPORT void cawtooth_opl_generate(opl3_chip* chip, int16_t* buf, uint32_t num_samples) {
    OPL3_GenerateStream(chip, buf, num_samples);
}

/*
 * Fill `stereo_buf` with mixed output AND `channels_buf` with per-voice output
 * for each of the 18 OPL3 channels (9 for OPL2, upper 9 stay silent in OPL2
 * mode).
 *
 * channels_buf layout is frame-interleaved: [frame0_ch0, frame0_ch1, ...,
 * frame0_ch17, frame1_ch0, ...]. Caller must ensure:
 *   stereo_buf   length >= num_samples * 2
 *   channels_buf length >= num_samples * 18
 *
 * Per-channel values are snapshots taken at the native OPL rate during each
 * resampled output sample — they track the stereo mix with at most one native
 * sample of lag (see cawtooth patch to opl3.c).
 */
CAWTOOTH_EXPORT void cawtooth_opl_generate_channels(
    opl3_chip* chip,
    int16_t* stereo_buf,
    int16_t* channels_buf,
    uint32_t num_samples
) {
    for (uint32_t i = 0; i < num_samples; i++) {
        OPL3_GenerateResampled(chip, &stereo_buf[i * 2]);
        int16_t* ch_out = &channels_buf[i * 18];
        for (int c = 0; c < 18; c++) {
            ch_out[c] = chip->channelsamples[c];
        }
    }
}

CAWTOOTH_EXPORT uint32_t cawtooth_opl_chip_size(void) {
    return (uint32_t)sizeof(opl3_chip);
}
