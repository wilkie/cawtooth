# capture-herad — AdPlug-based register-event dumper for HERAD files.
#
# Builds against the system libadplug (Debian: apt install libadplug-dev).
# The output binary is committed out of the tree (gitignored); rebuild locally
# with `make`.

CXX ?= g++
CXXFLAGS ?= -O2 -Wall -Wextra -std=c++17
PKG_CFLAGS := $(shell pkg-config --cflags adplug)
PKG_LIBS   := $(shell pkg-config --libs adplug)

capture-herad: capture-herad.cc
	$(CXX) $(CXXFLAGS) $(PKG_CFLAGS) -o $@ $< $(PKG_LIBS)

clean:
	rm -f capture-herad

.PHONY: clean
