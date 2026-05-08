/*
 * cawtooth — SNDH (Atari ST) playback WASM wrapper.
 *
 * Combines the vendored Musashi 68000 emulator, an embedded copy of the
 * Ayumi YM2149 emulator, and 4 MB of simulated Atari ST RAM into a
 * single standalone WASM module sufficient to run SNDH files.
 *
 * Usage from JS:
 *   cawtooth_sndh_create(atari_clock_hz, ym_clock_hz, sample_rate, is_ym)
 *   cawtooth_sndh_load(bytes, length)
 *   cawtooth_sndh_init(init_addr, exit_addr, play_addr, subsong, cycles_per_play)
 *   cawtooth_sndh_generate(buf, num_frames)         // repeat
 *   cawtooth_sndh_destroy()
 *
 * Musashi exposes its CPU state as global state, so only one m68k
 * instance is live at a time. That's fine — only one SNDH tune plays
 * at a time, and the YM chip instance is bound to the same WASM module.
 *
 * Memory map matches the Atari ST 1040ST closely enough for ripper
 * code:
 *   $00000000-$003FFFFF  4 MB user RAM (the SNDH binary lives here at $0)
 *   $00400000-...        sentinel range — instruction fetch ends timeslice
 *   $00FF8800/02         YM2149 register select / data port
 *   $00FF8900-$FF893F    STE DMA sound (writes silently dropped)
 *   $00FFFA00-$FFFA3F    MFP 68901 (writes silently dropped — the wrapper
 *                        drives play() at the cadence supplied by the JS
 *                        caller; we don't run the MFP timers)
 *   everything else      reads zero, writes drop
 *
 * The play routine is invoked JSR-style at a fixed cycle cadence, with
 * a longword sentinel pushed onto the stack as the return address. When
 * RTS pops the sentinel into PC, the next memory read from the sentinel
 * range ends the timeslice and we know the subroutine finished.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "ayumi.h"
#include "m68k.h"

#define CAWTOOTH_EXPORT __attribute__((used, visibility("default")))

// ----------------------------------------------------------------------------
// Memory model.
// ----------------------------------------------------------------------------

#define RAM_SIZE        (4u * 1024u * 1024u)
#define INITIAL_SP      0x00400000u

// Address range whose instruction fetch terminates the current m68k
// timeslice. After RTS pops our sentinel longword into PC, the next
// fetch hits this range and we know the subroutine has returned.
#define SENTINEL_BASE   0x00400000u
#define SENTINEL_MASK   0xFFF00000u

static uint8_t ram[RAM_SIZE];
static uint8_t selected_ym_reg = 0;
static volatile int subroutine_done = 0;

// ----------------------------------------------------------------------------
// YM2149 (Ayumi) state.
// ----------------------------------------------------------------------------

static struct ayumi ym;
static uint8_t ym_regs[16];
static int ym_is_ym = 1;
static double ym_clock_rate = 2000000.0;
static int ym_sample_rate = 44100;
static double ym_pan[3] = { 0.0, 0.5, 1.0 };

// Re-derive Ayumi setters from a register write. Mirrors ayumi-wrapper.c
// `apply_register` exactly — kept inline here so the SNDH module is
// self-contained (no cross-WASM dependency on the chip module).
static void ym_apply(int reg) {
    const uint8_t* r = ym_regs;
    switch (reg) {
        case 0:
        case 1:
            ayumi_set_tone(&ym, 0, ((r[1] & 0x0f) << 8) | r[0]);
            break;
        case 2:
        case 3:
            ayumi_set_tone(&ym, 1, ((r[3] & 0x0f) << 8) | r[2]);
            break;
        case 4:
        case 5:
            ayumi_set_tone(&ym, 2, ((r[5] & 0x0f) << 8) | r[4]);
            break;
        case 6:
            ayumi_set_noise(&ym, r[6] & 0x1f);
            break;
        case 7:
            for (int i = 0; i < 3; i++) {
                int t_off = (r[7] >> i) & 1;
                int n_off = (r[7] >> (i + 3)) & 1;
                int e_on = (r[8 + i] >> 4) & 1;
                ayumi_set_mixer(&ym, i, t_off, n_off, e_on);
            }
            break;
        case 8:
        case 9:
        case 10: {
            int i = reg - 8;
            int t_off = (r[7] >> i) & 1;
            int n_off = (r[7] >> (i + 3)) & 1;
            int e_on = (r[reg] >> 4) & 1;
            ayumi_set_volume(&ym, i, r[reg] & 0x0f);
            ayumi_set_mixer(&ym, i, t_off, n_off, e_on);
            break;
        }
        case 11:
        case 12:
            ayumi_set_envelope(&ym, (r[12] << 8) | r[11]);
            break;
        case 13:
            ayumi_set_envelope_shape(&ym, r[13] & 0x0f);
            break;
        // Regs 14/15 are I/O ports; YM2149 on Atari ST drives the floppy
        // strobe and parallel-port handshake from these. Audio-irrelevant.
        case 14:
        case 15:
            break;
    }
}

static void ym_write_register(uint8_t reg, uint8_t value) {
    if (reg > 15) return;
    ym_regs[reg] = value;
    ym_apply(reg);
}

// ----------------------------------------------------------------------------
// m68k bus callbacks (required by Musashi).
// ----------------------------------------------------------------------------

static inline int in_sentinel_range(unsigned int address) {
    return (address & SENTINEL_MASK) == SENTINEL_BASE;
}

unsigned int m68k_read_memory_8(unsigned int address) {
    if (in_sentinel_range(address)) {
        // Subroutine returned: end timeslice and feed back a NOP so any
        // residual fetch from this read is harmless.
        subroutine_done = 1;
        m68k_end_timeslice();
        return 0x4e;
    }
    if (address == 0xFF8800u) {
        // YM register-select port: undocumented Atari ST trick lets you
        // read back the currently-selected register's value.
        return ym_regs[selected_ym_reg & 0x0f];
    }
    if (address < RAM_SIZE) {
        return ram[address];
    }
    return 0;
}

unsigned int m68k_read_memory_16(unsigned int address) {
    if (in_sentinel_range(address)) {
        subroutine_done = 1;
        m68k_end_timeslice();
        // 0x4E71 == NOP, harmless if Musashi happens to execute one
        // word before the timeslice ends.
        return 0x4e71;
    }
    if (address + 1 < RAM_SIZE) {
        return (ram[address] << 8) | ram[address + 1];
    }
    return (m68k_read_memory_8(address) << 8) | m68k_read_memory_8(address + 1);
}

unsigned int m68k_read_memory_32(unsigned int address) {
    if (in_sentinel_range(address)) {
        subroutine_done = 1;
        m68k_end_timeslice();
        return 0x4e714e71;
    }
    if (address + 3 < RAM_SIZE) {
        return ((unsigned int)ram[address] << 24)
             | ((unsigned int)ram[address + 1] << 16)
             | ((unsigned int)ram[address + 2] << 8)
             | (unsigned int)ram[address + 3];
    }
    return (m68k_read_memory_16(address) << 16) | m68k_read_memory_16(address + 2);
}

unsigned int m68k_read_immediate_16(unsigned int address) {
    return m68k_read_memory_16(address);
}

unsigned int m68k_read_immediate_32(unsigned int address) {
    return m68k_read_memory_32(address);
}

unsigned int m68k_read_pcrelative_8(unsigned int address)  { return m68k_read_memory_8(address); }
unsigned int m68k_read_pcrelative_16(unsigned int address) { return m68k_read_memory_16(address); }
unsigned int m68k_read_pcrelative_32(unsigned int address) { return m68k_read_memory_32(address); }

unsigned int m68k_read_disassembler_8(unsigned int address)  { return m68k_read_memory_8(address); }
unsigned int m68k_read_disassembler_16(unsigned int address) { return m68k_read_memory_16(address); }
unsigned int m68k_read_disassembler_32(unsigned int address) { return m68k_read_memory_32(address); }

void m68k_write_memory_8(unsigned int address, unsigned int value) {
    uint8_t v = (uint8_t)value;

    // YM2149 ports.
    if (address == 0xFF8800u) {
        selected_ym_reg = v & 0x0f;
        return;
    }
    if (address == 0xFF8802u) {
        ym_write_register(selected_ym_reg, v);
        return;
    }
    // STE DMA sound (regs $FF8900-$FF893F): silently drop. Pure-YM SNDH
    // tunes do not need DMA, but some players probe these addresses.
    if (address >= 0xFF8900u && address <= 0xFF893Fu) return;
    // MFP 68901 (regs $FFFA00-$FFFA3F): silently drop. The wrapper
    // drives play() externally based on the cycle cadence the JS layer
    // computed from the SNDH `TC{N}` tag, so we don't actually need to
    // run the MFP timers — but the player WILL write to these to set up
    // its own (now-unused) timer programming.
    if (address >= 0xFFFA00u && address <= 0xFFFA3Fu) return;

    if (address < RAM_SIZE) {
        ram[address] = v;
    }
}

void m68k_write_memory_16(unsigned int address, unsigned int value) {
    // Atari ST `move.w Dn,$FF8800.W` is occasionally used to write
    // register select + the data byte at $FF8801 simultaneously, but the
    // canonical ripper idiom is `movep.w` which routes through write_8.
    // Default to two byte writes — identical bus behavior.
    m68k_write_memory_8(address, (value >> 8) & 0xff);
    m68k_write_memory_8(address + 1, value & 0xff);
}

void m68k_write_memory_32(unsigned int address, unsigned int value) {
    m68k_write_memory_16(address, (value >> 16) & 0xffff);
    m68k_write_memory_16(address + 2, value & 0xffff);
}

// Required when M68K_SIMULATE_PD_WRITES is on; we leave it off in
// m68kconf.h, so this is just here to satisfy the linker.
void m68k_write_memory_32_pd(unsigned int address, unsigned int value) {
    m68k_write_memory_32(address, value);
}

// ----------------------------------------------------------------------------
// Subroutine helper: JSR + RTS-to-sentinel pattern.
// ----------------------------------------------------------------------------

// Cycle ceilings — same conservative bounds as sidplay-wrapper.cc, scaled
// for the m68k's higher clock rate (~8 MHz vs C64's ~1 MHz).
#define SNDH_INIT_MAX_CYCLES   (200u * 1000u * 1000u)   // ~25s of m68k time
#define SNDH_PLAY_MAX_CYCLES   (4u * 1000u * 1000u)     // ~500ms

/**
 * Set PC = entry, push SENTINEL_BASE as the longword return address,
 * then run the m68k until either:
 *   - PC enters the sentinel range (subroutine returned cleanly), or
 *   - max_cycles consumed (timeout — likely an infinite loop),
 *   - m68k_execute returns 0 (CPU stopped without coming back).
 *
 * Returns cycles consumed on success, or -1 on timeout. The caller is
 * responsible for setting up D0 (subsong number) before this for init.
 */
static int run_subroutine(unsigned int entry, unsigned int max_cycles) {
    unsigned int sp = m68k_get_reg(NULL, M68K_REG_A7);
    sp -= 4;
    m68k_write_memory_32(sp, SENTINEL_BASE);
    m68k_set_reg(M68K_REG_A7, sp);
    m68k_set_reg(M68K_REG_PC, entry);

    subroutine_done = 0;
    unsigned int total = 0;
    while (total < max_cycles && !subroutine_done) {
        // Small chunks so the PC-check granularity is fine. m68k_execute
        // returns the number of cycles actually consumed (≥ 1 instruction).
        int chunk = m68k_execute(256);
        if (chunk <= 0) break;
        total += (unsigned int)chunk;
        unsigned int pc = m68k_get_reg(NULL, M68K_REG_PC);
        if (in_sentinel_range(pc)) break;
    }
    unsigned int pc_final = m68k_get_reg(NULL, M68K_REG_PC);
    if (subroutine_done || in_sentinel_range(pc_final)) {
        return (int)total;
    }
    return -1;
}

// ----------------------------------------------------------------------------
// Cached playback state.
// ----------------------------------------------------------------------------

static unsigned int play_addr_cached = 0;
static int cycles_per_play_frame = 160212;  // PAL Atari ST default at TC50
static int cycles_until_next_play = 0;

// Sub-sample fractional accumulator: m68k cycles per output audio sample.
// `cycles_per_sample_int + cycles_per_sample_num/cycles_per_sample_den`
// keeps the audio clock locked to the m68k clock without floating-point
// drift over long generates.
static int cycles_per_sample_int = 181;
static int cycles_per_sample_num = 0;
static int cycles_per_sample_den = 1;
static int cycles_per_sample_phase = 0;

// ----------------------------------------------------------------------------
// Public C-ABI.
// ----------------------------------------------------------------------------

CAWTOOTH_EXPORT uint32_t cawtooth_sndh_create(
    double atari_clock_hz, double ym_clock_hz, int sample_rate, int is_ym
) {
    memset(ram, 0, sizeof(ram));
    memset(ym_regs, 0, sizeof(ym_regs));
    selected_ym_reg = 0;
    subroutine_done = 0;

    if (atari_clock_hz <= 0) atari_clock_hz = 8010613.0;
    if (ym_clock_hz <= 0)    ym_clock_hz    = 2000000.0;
    if (sample_rate <= 0)    sample_rate    = 44100;

    ym_is_ym = is_ym ? 1 : 0;
    ym_clock_rate = ym_clock_hz;
    ym_sample_rate = sample_rate;
    if (!ayumi_configure(&ym, ym_is_ym, ym_clock_rate, ym_sample_rate)) {
        return 0;
    }
    for (int i = 0; i < 3; i++) {
        ayumi_set_pan(&ym, i, ym_pan[i], 1);
    }

    // m68k cycles per output audio sample, in `int + num/den` form so we
    // can advance the play-counter without floating-point drift.
    int atari_int = (int)atari_clock_hz;
    cycles_per_sample_int = atari_int / sample_rate;
    cycles_per_sample_num = atari_int % sample_rate;
    cycles_per_sample_den = sample_rate;
    cycles_per_sample_phase = 0;

    m68k_init();
    m68k_set_cpu_type(M68K_CPU_TYPE_68000);
    // Reset reads SP from RAM[$0..$3] and PC from RAM[$4..$7], which on
    // a freshly-zeroed RAM gives SP=0 / PC=0 — we override both before
    // running any code.
    m68k_pulse_reset();

    play_addr_cached = 0;
    cycles_per_play_frame = 160212;
    cycles_until_next_play = 0;
    return 1;
}

CAWTOOTH_EXPORT void cawtooth_sndh_destroy(void) {
    play_addr_cached = 0;
    cycles_until_next_play = 0;
    memset(ram, 0, sizeof(ram));
}

/**
 * Copy `length` bytes of `data` into Atari ST RAM starting at $0.
 * Clipped at the RAM ceiling.
 */
CAWTOOTH_EXPORT void cawtooth_sndh_load(const uint8_t* data, uint32_t length) {
    if (length > RAM_SIZE) length = RAM_SIZE;
    memcpy(ram, data, length);
}

/**
 * Run the SNDH `init` routine for the given subsong, then cache the
 * play address + cycle budget for subsequent generate() calls.
 *
 * Subsong is 1-based per the SNDH spec — pass through whatever the
 * SndhSong header surfaced.
 *
 * Returns the number of m68k cycles consumed by init, or -1 on timeout.
 */
CAWTOOTH_EXPORT int32_t cawtooth_sndh_init(
    uint32_t init_addr,
    uint32_t exit_addr,
    uint32_t play_addr,
    uint32_t subsong,
    int32_t cycles_per_play
) {
    (void)exit_addr; // Surfaced for future symmetry; nothing calls exit yet.

    // Reset Ayumi between subsongs/inits — `init` routines commonly
    // assume power-on YM state, and the DC filter / FIR delay lines
    // need a clean slate so a new subsong doesn't smear into the old.
    memset(ym_regs, 0, sizeof(ym_regs));
    selected_ym_reg = 0;
    ayumi_configure(&ym, ym_is_ym, ym_clock_rate, ym_sample_rate);
    for (int i = 0; i < 3; i++) {
        ayumi_set_pan(&ym, i, ym_pan[i], 1);
    }

    // Initialise CPU registers to a TOS-like baseline:
    //   - Supervisor mode, all interrupts masked (SR=$2700)
    //   - SP at top of RAM
    //   - D0 = subsong number (SNDH calling convention)
    //   - other registers cleared
    m68k_set_reg(M68K_REG_SR, 0x2700);
    m68k_set_reg(M68K_REG_A7, INITIAL_SP);
    for (int i = 0; i < 7; i++) {
        m68k_set_reg(M68K_REG_D0 + i, 0);
    }
    for (int i = 0; i < 7; i++) {
        m68k_set_reg(M68K_REG_A0 + i, 0);
    }
    m68k_set_reg(M68K_REG_D0, subsong);

    play_addr_cached = play_addr;
    cycles_per_play_frame = cycles_per_play > 0 ? cycles_per_play : 160212;
    cycles_until_next_play = 0;

    return run_subroutine(init_addr, SNDH_INIT_MAX_CYCLES);
}

CAWTOOTH_EXPORT int32_t cawtooth_sndh_get_play_interval(void) {
    return cycles_per_play_frame;
}

static inline int16_t to_int16(double v) {
    if (v >= 1.0) return 32767;
    if (v <= -1.0) return -32768;
    return (int16_t)(v * 32767.0);
}

static inline int advance_sample_cycles(void) {
    int dt = cycles_per_sample_int;
    cycles_per_sample_phase += cycles_per_sample_num;
    if (cycles_per_sample_phase >= cycles_per_sample_den) {
        cycles_per_sample_phase -= cycles_per_sample_den;
        dt++;
    }
    return dt;
}

CAWTOOTH_EXPORT void cawtooth_sndh_generate(int16_t* buf, uint32_t num_frames) {
    if (num_frames == 0) return;
    for (uint32_t i = 0; i < num_frames; i++) {
        if (cycles_until_next_play <= 0 && play_addr_cached != 0) {
            run_subroutine(play_addr_cached, SNDH_PLAY_MAX_CYCLES);
            cycles_until_next_play += cycles_per_play_frame;
        }
        ayumi_process(&ym);
        ayumi_remove_dc(&ym);
        buf[i * 2]     = to_int16(ym.left);
        buf[i * 2 + 1] = to_int16(ym.right);
        cycles_until_next_play -= advance_sample_cycles();
    }
}

CAWTOOTH_EXPORT void cawtooth_sndh_generate_channels(
    int16_t* stereo_buf, int16_t* channels_buf, uint32_t num_frames
) {
    if (num_frames == 0) return;
    for (uint32_t i = 0; i < num_frames; i++) {
        if (cycles_until_next_play <= 0 && play_addr_cached != 0) {
            run_subroutine(play_addr_cached, SNDH_PLAY_MAX_CYCLES);
            cycles_until_next_play += cycles_per_play_frame;
        }
        ayumi_process(&ym);
        ayumi_remove_dc(&ym);
        stereo_buf[i * 2]     = to_int16(ym.left);
        stereo_buf[i * 2 + 1] = to_int16(ym.right);

        // Per-voice DAC snapshot — same compute as ayumi-wrapper.c.
        int noise_bit = ym.noise & 1;
        for (int c = 0; c < 3; c++) {
            struct tone_channel* ch = &ym.channels[c];
            int gate = (ch->tone | ch->t_off) & (noise_bit | ch->n_off);
            int dac_idx = gate * (ch->e_on ? ym.envelope : (ch->volume * 2 + 1));
            channels_buf[i * 3 + c] = to_int16(ym.dac_table[dac_idx]);
        }

        cycles_until_next_play -= advance_sample_cycles();
    }
}

CAWTOOTH_EXPORT void cawtooth_sndh_set_pan(int channel, double pan, int is_eqp) {
    if (channel < 0 || channel > 2) return;
    ym_pan[channel] = pan;
    ayumi_set_pan(&ym, channel, pan, is_eqp);
}

/**
 * Read a byte from emulated Atari ST RAM. Useful for tests that want to
 * verify the init routine set up some state correctly. Does NOT route
 * YM register reads — those come back from the cached register file.
 */
CAWTOOTH_EXPORT uint8_t cawtooth_sndh_peek(uint32_t address) {
    if (address < RAM_SIZE) return ram[address];
    return 0;
}

CAWTOOTH_EXPORT void cawtooth_sndh_reset_chip(void) {
    memset(ym_regs, 0, sizeof(ym_regs));
    selected_ym_reg = 0;
    ayumi_configure(&ym, ym_is_ym, ym_clock_rate, ym_sample_rate);
    for (int i = 0; i < 3; i++) {
        ayumi_set_pan(&ym, i, ym_pan[i], 1);
    }
}
