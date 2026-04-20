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

CAWTOOTH_EXPORT uint32_t cawtooth_opl_chip_size(void) {
    return (uint32_t)sizeof(opl3_chip);
}
