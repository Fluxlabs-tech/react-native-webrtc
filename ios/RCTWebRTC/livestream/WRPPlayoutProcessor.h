// The voice chain the iOS playout device runs on every buffer WebRTC hands it:
// input gain -> soft-knee compressor -> lookahead peak limiter.
//
// Plain C with no Apple dependency on purpose: it runs on the real-time render
// thread, so it must never allocate, lock or message an object, and keeping it
// portable means it can be compiled and measured off-device.
//
// The Android half cannot run code on the playout path, so it approximates this
// chain with the platform's DynamicsProcessing effect. The numbers in
// `WRPPlayoutConfigDefault` are mirrored in `LivestreamAudio.java` — change them
// together.

#ifndef WRP_PLAYOUT_PROCESSOR_H
#define WRP_PLAYOUT_PROCESSOR_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WRP_PP_MAX_CHANNELS 2

/**
 * Limiter lookahead, in frames. 64 frames is 1.3 ms at 48 kHz: long enough for
 * the gain to ramp down smoothly ahead of a peak rather than stepping on it,
 * short enough that the added delay is inaudible and irrelevant to lip sync.
 */
#define WRP_PP_LOOKAHEAD 64

typedef struct {
  /** Gain applied before anything else, in dB. */
  float inputGainDb;
  /** Level the compressor starts working at, in dBFS. */
  float thresholdDb;
  /** Compression ratio above the threshold, N:1. */
  float ratio;
  /** Width of the soft knee centred on the threshold, in dB. */
  float kneeDb;
  float attackMs;
  float releaseMs;
  /** The limiter's ceiling, in dBFS. Nothing leaves the chain above it. */
  float ceilingDb;
  float limiterReleaseMs;
  /**
   * Input level, in dBFS RMS before the input gain, below which the compressor
   * and limiter hold their gain instead of releasing. A pause between phrases
   * then plays at the gain the voice set, so the room noise in it is not lifted.
   */
  float holdBelowDb;
} WRPPlayoutConfig;

typedef struct {
  float inputPeak;
  float outputPeak;
  /** Largest total gain reduction (compressor + limiter) applied, in dB. */
  float maxReductionDb;
} WRPPlayoutStats;

typedef struct {
  // Derived from the config.
  int channels;
  float inputGain;
  float thresholdDb;
  float slope;
  float kneeDb;
  float attackCoef;
  float releaseCoef;
  float ceiling;
  float limiterReleaseCoef;
  /** `holdBelowDb` moved past the input gain, where the level detector reads. */
  float holdDb;

  // Compressor: the level detector's running mean square, and the smoothed gain
  // reduction in dB.
  float rmsCoef;
  float meanSquare;
  float smoothDb;

  // Limiter: the audio delay line, a sliding-window minimum over the gain each
  // frame needs, and a moving average of that minimum.
  float delay[WRP_PP_LOOKAHEAD][WRP_PP_MAX_CHANNELS];
  int delayPos;
  float minValue[WRP_PP_LOOKAHEAD];
  uint32_t minStamp[WRP_PP_LOOKAHEAD];
  int minHead;
  int minCount;
  float boxRing[WRP_PP_LOOKAHEAD];
  int boxPos;
  double boxSum;
  float limiterGain;
  uint32_t frame;

  // Accumulated since the last `WRPPlayoutProcessorTakeStats`.
  WRPPlayoutStats stats;
} WRPPlayoutProcessor;

/** The tuning the app ships with. */
WRPPlayoutConfig WRPPlayoutConfigDefault(void);

void WRPPlayoutProcessorInit(WRPPlayoutProcessor *p,
                              const WRPPlayoutConfig *config,
                              double sampleRate,
                              int channels);

/** Drop all history — the next buffer is treated as the start of a new stream. */
void WRPPlayoutProcessorReset(WRPPlayoutProcessor *p);

/** Process interleaved 16-bit PCM in place. Real-time safe. */
void WRPPlayoutProcessorProcess(WRPPlayoutProcessor *p, int16_t *interleaved, size_t frames);

/** Read and clear the stats. Not synchronised with `Process`: for logging only. */
WRPPlayoutStats WRPPlayoutProcessorTakeStats(WRPPlayoutProcessor *p);

#ifdef __cplusplus
}
#endif

#endif  // WRP_PLAYOUT_PROCESSOR_H
