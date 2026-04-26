/*
 * cawtooth — Ayumi (AY-3-8910 / YM2149) WASM wrapper
 *
 * Thin C shim exposing a minimal, pointer-stable API for driving Peter
 * Sovietov's Ayumi emulator from JavaScript. Compiled to WASM by
 * tools/build-wasm.sh.
 *
 * Ayumi natively exposes a "structured setter" API (set_tone / set_noise
 * / set_mixer / set_envelope / set_envelope_shape / set_volume), but the
 * actual AY-3-8910 hardware exposes 16 byte-addressable registers. Real
 * chiptune file formats (.vtx, .ym, .psg, register-dump VGM) describe
 * music as register writes, so the JS-facing API mirrors the hardware:
 * `cawtooth_ay_write(reg, value)` updates an internal 16-byte register
 * file, then re-derives the affected Ayumi setters.
 *
 * Output: stereo int16 frames, sample-rate-matched to whatever the
 * caller passed at create() time. Ayumi internally oversamples 8× and
 * applies a 192-tap polyphase FIR before decimation, so the output is
 * properly bandlimited at any reasonable sample rate.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "ayumi.h"

#define CAWTOOTH_EXPORT __attribute__((used, visibility("default")))

/*
 * AY-3-8910 register file (16 bytes). The wrapper owns this state so
 * write semantics match the hardware: a write to R7 (mixer) needs to
 * read R8/R9/R10's envelope-mode bits, etc. Per-channel state on the
 * Ayumi struct is "decoded form"; this is the raw "as-written form".
 *
 * Clock + sample-rate + variant are cached so reset() can fully
 * reconfigure (zeros DC filter + FIR + interpolator state, not just
 * the registers). Per-channel pans are cached too so reset() doesn't
 * silently snap them back to the default ABC stereo.
 */
typedef struct {
    struct ayumi ay;
    uint8_t regs[16];
    int is_ym;
    double clock_rate;
    int sample_rate;
    double pan[3];
} cawtooth_ay_chip;

/*
 * Push the (re-)decoded value of `reg` into Ayumi. Called both on direct
 * register writes and on reset. Ordered to match the AY-3-8910 register
 * map; see https://map.grauw.nl/resources/sound/generalinstrument_ay-3-8910.pdf
 * for the full bit-level layout.
 */
static void apply_register(cawtooth_ay_chip* chip, int reg) {
    struct ayumi* ay = &chip->ay;
    const uint8_t* r = chip->regs;
    switch (reg) {
        case 0:
        case 1:
            // Channel A tone period: 12 bits = (R1 & 0x0F) << 8 | R0.
            ayumi_set_tone(ay, 0, ((r[1] & 0x0f) << 8) | r[0]);
            break;
        case 2:
        case 3:
            ayumi_set_tone(ay, 1, ((r[3] & 0x0f) << 8) | r[2]);
            break;
        case 4:
        case 5:
            ayumi_set_tone(ay, 2, ((r[5] & 0x0f) << 8) | r[4]);
            break;
        case 6:
            // Noise period: 5 bits.
            ayumi_set_noise(ay, r[6] & 0x1f);
            break;
        case 7: {
            // Mixer: bits 0-2 disable tone A/B/C, bits 3-5 disable noise
            // A/B/C. Re-derive all three channels' mixer state, which
            // also depends on each channel's envelope-mode bit (R8/9/10
            // bit 4).
            for (int i = 0; i < 3; i++) {
                int t_off = (r[7] >> i) & 1;
                int n_off = (r[7] >> (i + 3)) & 1;
                int e_on = (r[8 + i] >> 4) & 1;
                ayumi_set_mixer(ay, i, t_off, n_off, e_on);
            }
            break;
        }
        case 8:
        case 9:
        case 10: {
            // Channel amplitude: low 4 bits = volume, bit 4 = envelope
            // mode flag. Volume change is independent; envelope-mode
            // change requires re-applying mixer.
            int i = reg - 8;
            int t_off = (r[7] >> i) & 1;
            int n_off = (r[7] >> (i + 3)) & 1;
            int e_on = (r[reg] >> 4) & 1;
            ayumi_set_volume(ay, i, r[reg] & 0x0f);
            ayumi_set_mixer(ay, i, t_off, n_off, e_on);
            break;
        }
        case 11:
        case 12:
            // Envelope period: 16 bits = R12 << 8 | R11.
            ayumi_set_envelope(ay, (r[12] << 8) | r[11]);
            break;
        case 13:
            // Envelope shape: low 4 bits. Ayumi resets segment counters
            // every time this is set, which matches AY hardware
            // behaviour (writing the same shape restarts the envelope).
            ayumi_set_envelope_shape(ay, r[13] & 0x0f);
            break;
        case 14:
        case 15:
            // I/O ports — not used for sound. Real chips toggle them
            // when scanning the keyboard (ZX) or driving paddles
            // (Atari ST). We accept the writes silently.
            break;
    }
}

CAWTOOTH_EXPORT cawtooth_ay_chip* cawtooth_ay_create(
    int is_ym,
    double clock_rate,
    int sample_rate
) {
    cawtooth_ay_chip* chip = (cawtooth_ay_chip*)malloc(sizeof(cawtooth_ay_chip));
    if (!chip) return 0;
    memset(chip, 0, sizeof(cawtooth_ay_chip));
    if (!ayumi_configure(&chip->ay, is_ym, clock_rate, sample_rate)) {
        // ayumi_configure returns 0 (false) on bad config; the only
        // failure mode is sample_rate too high relative to clock_rate.
        free(chip);
        return 0;
    }
    chip->is_ym = is_ym;
    chip->clock_rate = clock_rate;
    chip->sample_rate = sample_rate;
    // Default ABC stereo: A left, B center, C right. Standard ZX
    // Spectrum convention. Caller can override via cawtooth_ay_set_pan.
    chip->pan[0] = 0.0;
    chip->pan[1] = 0.5;
    chip->pan[2] = 1.0;
    for (int i = 0; i < 3; i++) {
        ayumi_set_pan(&chip->ay, i, chip->pan[i], 1);
    }
    return chip;
}

CAWTOOTH_EXPORT void cawtooth_ay_destroy(cawtooth_ay_chip* chip) {
    if (chip) free(chip);
}

CAWTOOTH_EXPORT void cawtooth_ay_reset(cawtooth_ay_chip* chip) {
    if (!chip) return;
    // Reconfigure from scratch: ayumi_configure memsets the whole
    // ayumi struct, so this clears the DC filter delay line, the FIR
    // delay lines, the interpolator state, and the resampler's
    // fractional accumulator — the things a "register file zero"
    // would otherwise leave dirty (audible as a slow DC ramp after
    // a tone is cut). Pans are re-applied from the cached values.
    memset(chip->regs, 0, sizeof(chip->regs));
    ayumi_configure(&chip->ay, chip->is_ym, chip->clock_rate, chip->sample_rate);
    for (int i = 0; i < 3; i++) {
        ayumi_set_pan(&chip->ay, i, chip->pan[i], 1);
    }
}

CAWTOOTH_EXPORT void cawtooth_ay_write(cawtooth_ay_chip* chip, uint8_t reg, uint8_t value) {
    if (!chip || reg > 15) return;
    chip->regs[reg] = value;
    apply_register(chip, reg);
}

CAWTOOTH_EXPORT uint8_t cawtooth_ay_read(cawtooth_ay_chip* chip, uint8_t reg) {
    if (!chip || reg > 15) return 0;
    return chip->regs[reg];
}

/*
 * Per-channel pan control. `pan` ∈ [0, 1]: 0 = full left, 1 = full
 * right, 0.5 = center. `is_eqp` selects equal-power (sqrt) panning vs
 * linear; equal-power is the standard for music applications and
 * matches Ayumi's recommended default.
 */
CAWTOOTH_EXPORT void cawtooth_ay_set_pan(
    cawtooth_ay_chip* chip,
    int channel,
    double pan,
    int is_eqp
) {
    if (!chip || channel < 0 || channel > 2) return;
    chip->pan[channel] = pan;
    ayumi_set_pan(&chip->ay, channel, pan, is_eqp);
}

/*
 * Convert Ayumi's double output to int16, clamped. Ayumi's output range
 * after dc_filter is roughly ±1 with peaks slightly past full scale on
 * dense mixes — clamp before scaling to avoid wraparound.
 */
static inline int16_t to_int16(double v) {
    if (v >= 1.0) return 32767;
    if (v <= -1.0) return -32768;
    return (int16_t)(v * 32767.0);
}

/*
 * Fill `buf` with `num_frames` stereo-interleaved int16 frames.
 * Caller must ensure buf has capacity >= num_frames * 2 * sizeof(int16_t).
 *
 * The DC removal filter is always on — it's cheap (one delay-line +
 * scalar add per channel) and removes the slow drift Ayumi's mixer
 * accumulates from non-zero DAC entries at idle.
 */
CAWTOOTH_EXPORT void cawtooth_ay_generate(
    cawtooth_ay_chip* chip,
    int16_t* buf,
    uint32_t num_frames
) {
    if (!chip) return;
    struct ayumi* ay = &chip->ay;
    for (uint32_t i = 0; i < num_frames; i++) {
        ayumi_process(ay);
        ayumi_remove_dc(ay);
        buf[i * 2] = to_int16(ay->left);
        buf[i * 2 + 1] = to_int16(ay->right);
    }
}

/*
 * Fill `stereo_buf` with mixed output AND `channels_buf` with per-voice
 * pre-pan output for each of the 3 AY tone channels.
 *
 * channels_buf layout is frame-interleaved: [f0_v0, f0_v1, f0_v2,
 * f1_v0, ...]. Caller must ensure channels_buf length >= num_frames * 3.
 *
 * Per-channel snapshot is the chip's last sub-sample state at output
 * time (Ayumi internally oversamples 8× and runs the mixer 8× per
 * output sample; we capture the tone/noise/envelope state from the last
 * sub-step). This is plenty accurate for scope visualization — the only
 * thing it misses is sub-sample tone toggles, which the FIR-decimated
 * stereo output also smooths over.
 */
CAWTOOTH_EXPORT void cawtooth_ay_generate_channels(
    cawtooth_ay_chip* chip,
    int16_t* stereo_buf,
    int16_t* channels_buf,
    uint32_t num_frames
) {
    if (!chip) return;
    struct ayumi* ay = &chip->ay;
    for (uint32_t i = 0; i < num_frames; i++) {
        ayumi_process(ay);
        ayumi_remove_dc(ay);
        stereo_buf[i * 2] = to_int16(ay->left);
        stereo_buf[i * 2 + 1] = to_int16(ay->right);

        // Snapshot per-channel DAC value. Mirrors Ayumi's update_mixer
        // computation (ayumi.c: `out = (tone|t_off) & (noise|n_off);
        // out *= e_on ? envelope : volume*2+1; dac_table[out]`).
        int noise_bit = ay->noise & 1;
        for (int c = 0; c < 3; c++) {
            struct tone_channel* ch = &ay->channels[c];
            int gate = (ch->tone | ch->t_off) & (noise_bit | ch->n_off);
            int dac_idx = gate * (ch->e_on ? ay->envelope : (ch->volume * 2 + 1));
            channels_buf[i * 3 + c] = to_int16(ay->dac_table[dac_idx]);
        }
    }
}

CAWTOOTH_EXPORT uint32_t cawtooth_ay_chip_size(void) {
    return (uint32_t)sizeof(cawtooth_ay_chip);
}
