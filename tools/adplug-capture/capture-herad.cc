// capture-herad: dumps AdPlug's HERAD player register writes as TSV.
//
// Usage: capture-herad [--v1|--v2] <herad-file>
//
// The optional variant flag overrides AdPlug's auto-detection. AdPlug's
// "aggressive v2 detection" heuristic (validTracks) mis-flags some v1 files
// (e.g. Cryo's SAVAGE.HSQ) as v2, which throws off event parsing. Passing
// --v1 on those gives us a fair comparison against our renderer.
//
// Output (stdout): one row per OPL write,
//   tick\treg\tval
// where `tick` counts HERAD `processEvents` calls from 0 (the same unit our
// TypeScript renderer emits), `reg` is the register number with the upper-
// bank bit at 0x100, and `val` is the byte written.
//
// This is the ground-truth reference for our TS renderer. We invoke the
// binary from a Jest test, run our own renderHeradToStream on the same file,
// and diff the two streams tuple-by-tuple to find divergences.
//
// Built against system libadplug (Debian: apt install libadplug-dev).

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <adplug/fprovide.h>
#include <adplug/herad.h>
#include <adplug/opl.h>

namespace {

// Capture OPL backend. Records every write as a (tick, reg, val) triple; the
// driver loop injects `currentTick` before each processEvents iteration.
class CaptureOpl : public Copl {
 public:
  uint32_t currentTick = 0;
  struct Event { uint32_t tick; uint16_t reg; uint8_t val; };
  std::vector<Event> events;

  CaptureOpl() { currType = TYPE_OPL3; }

  void write(int reg, int val) override {
    uint16_t fullReg = static_cast<uint16_t>(reg & 0x1FF);
    if (currChip == 1) fullReg |= 0x100;
    events.push_back({currentTick, fullReg, static_cast<uint8_t>(val & 0xFF)});
  }

  // AdPlug's rewind() calls write() for the init sequence (regs 0x01, 0x08,
  // 0xBD, and for AGD 0x105/0x104). Those should appear at tick 0 in the
  // capture. init() is AdPlug's "reset the chip state" hook — we don't need
  // it because we're not simulating a real chip.
  void init() override {}
};

// CheradPlayer's `v2` field is protected. Subclassing is the only way to
// reach it from outside without patching AdPlug's headers.
class ForcibleHeradPlayer : public CheradPlayer {
 public:
  explicit ForcibleHeradPlayer(Copl* opl) : CheradPlayer(opl) {}
  void forceV1() { v2 = false; }
  void forceV2() { v2 = true; }
};

}  // namespace

int main(int argc, char* argv[]) {
  const char* path = nullptr;
  enum { AUTO, FORCE_V1, FORCE_V2 } forceVariant = AUTO;
  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--v1") == 0) forceVariant = FORCE_V1;
    else if (std::strcmp(argv[i], "--v2") == 0) forceVariant = FORCE_V2;
    else if (path == nullptr) path = argv[i];
    else {
      fprintf(stderr, "unexpected argument: %s\n", argv[i]);
      return 2;
    }
  }
  if (!path) {
    fprintf(stderr, "usage: %s [--v1|--v2] <herad-file>\n", argv[0]);
    return 2;
  }

  CaptureOpl opl;
  ForcibleHeradPlayer player(&opl);

  CProvider_Filesystem fp;
  if (!player.load(path, fp)) {
    fprintf(stderr, "capture-herad: failed to load %s\n", path);
    return 1;
  }
  if (forceVariant == FORCE_V1) player.forceV1();
  else if (forceVariant == FORCE_V2) player.forceV2();

  // Mirror AdPlug's update() gate math externally to derive the song tick.
  //
  // update() does:
  //   wTime -= 256
  //   if wTime < 0 then wTime += wSpeed; processEvents()
  //
  // processEvents is where writes happen AND where `ticks_pos` increments.
  // We run the same gate in parallel here: the tick we assign to each
  // update() is the same tick processEvents sees internally.
  const int wSpeed = static_cast<int>(player.getspeed());
  int simWTime = 0;
  uint32_t songTick = 0;

  // Hard cap so a broken/looping file can't spin forever. HERAD files max
  // out at ~75 KB of song data which couldn't generate more than ~200k
  // internal ticks even at the slowest wSpeed.
  const uint32_t kMaxTicks = 200000;
  while (songTick < kMaxTicks) {
    simWTime -= 256;
    const bool willFireEvents = simWTime < 0;
    if (willFireEvents) {
      simWTime += wSpeed;
      opl.currentTick = songTick;
    }
    const bool alive = player.update();
    if (willFireEvents) songTick++;
    if (!alive) break;
  }

  // TSV output.
  fprintf(stdout, "# tick\treg\tval\n");
  for (const auto& e : opl.events) {
    fprintf(stdout, "%u\t%u\t%u\n", e.tick, e.reg, e.val);
  }
  return 0;
}
