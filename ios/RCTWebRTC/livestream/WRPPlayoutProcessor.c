#include "WRPPlayoutProcessor.h"

#include <math.h>
#include <string.h>

#define FULL_SCALE 32768.0f
/** Anything quieter is treated as silence by the compressor's level detector. */
#define SILENCE_DB -120.0f
/**
 * The compressor's level detector integrates power over this window, so its
 * threshold reads as speech loudness rather than as the peak of every syllable —
 * peaks are the limiter's job.
 */
#define RMS_WINDOW_MS 10.0f

WRPPlayoutConfig WRPPlayoutConfigDefault(void) {
  // A leveller rather than a fixed boost: a quiet speaker is lifted a long way
  // and a loud one is not lifted at all. Measured on speech at three source levels
  // with room noise 40 dB under it, loudness and voice over noise, in -> out:
  //
  //   quiet   -28.4 LUFS -> -19.1 LUFS   40.2 dB -> 39.8 dB
  //   typical -20.4 LUFS -> -16.9 LUFS   40.3 dB -> 39.7 dB
  //   hot     -14.4 LUFS -> -15.3 LUFS   40.3 dB -> 39.5 dB
  //
  // Sample peaks held at -1.0 dBFS (true peak -0.9 dBTP).
  //
  // -16 LUFS is where other media on a phone sits. For comparison, boosting the
  // track with `_setVolume(10)` instead took the typical source to -4.8 dBFS RMS
  // with 15% of samples clipped flat.
  WRPPlayoutConfig config = {
      .inputGainDb = 15.0f,
      .thresholdDb = -20.0f,
      .ratio = 4.0f,
      .kneeDb = 6.0f,
      // Slow on purpose: the compressor follows how loud the speaker is, not
      // each syllable, and the limiter takes the peaks. A fast compressor
      // squashes loud syllables against soft ones, which on a hot source cost
      // 10 dB of voice over room noise for no gain in loudness.
      .attackMs = 30.0f,
      .releaseMs = 2000.0f,
      .ceilingDb = -1.0f,
      .limiterReleaseMs = 60.0f,
      // Under any speech and over the room noise of a phone mic, so a pause
      // plays at the gain the voice set rather than rising toward the full
      // input gain.
      .holdBelowDb = -45.0f,
  };
  return config;
}

static float OnePole(float ms, double sampleRate) {
  if (ms <= 0.0f) return 0.0f;
  return (float)exp(-1.0 / (ms * 0.001 * sampleRate));
}

static float DbToLinear(float db) {
  return powf(10.0f, db / 20.0f);
}

void WRPPlayoutProcessorReset(WRPPlayoutProcessor *p) {
  p->meanSquare = 0.0f;
  p->smoothDb = 0.0f;
  memset(p->delay, 0, sizeof(p->delay));
  p->delayPos = 0;
  p->minHead = 0;
  p->minCount = 0;
  for (int i = 0; i < WRP_PP_LOOKAHEAD; i++) p->boxRing[i] = 1.0f;
  p->boxPos = 0;
  p->boxSum = WRP_PP_LOOKAHEAD;
  p->limiterGain = 1.0f;
  p->frame = 0;
  memset(&p->stats, 0, sizeof(p->stats));
}

void WRPPlayoutProcessorInit(WRPPlayoutProcessor *p,
                              const WRPPlayoutConfig *config,
                              double sampleRate,
                              int channels) {
  memset(p, 0, sizeof(*p));
  p->channels = channels < 1 ? 1 : (channels > WRP_PP_MAX_CHANNELS ? WRP_PP_MAX_CHANNELS : channels);
  p->inputGain = DbToLinear(config->inputGainDb);
  p->thresholdDb = config->thresholdDb;
  p->slope = 1.0f / (config->ratio < 1.0f ? 1.0f : config->ratio) - 1.0f;
  p->kneeDb = config->kneeDb < 0.0f ? 0.0f : config->kneeDb;
  p->rmsCoef = OnePole(RMS_WINDOW_MS, sampleRate);
  p->attackCoef = OnePole(config->attackMs, sampleRate);
  p->releaseCoef = OnePole(config->releaseMs, sampleRate);
  p->ceiling = DbToLinear(config->ceilingDb);
  p->limiterReleaseCoef = OnePole(config->limiterReleaseMs, sampleRate);
  p->holdDb = config->holdBelowDb + config->inputGainDb;
  WRPPlayoutProcessorReset(p);
}

/** The compressor's static curve: how many dB to take off a level of `levelDb`. */
static inline float Reduction(const WRPPlayoutProcessor *p, float levelDb) {
  const float over = levelDb - p->thresholdDb;
  const float halfKnee = p->kneeDb * 0.5f;
  if (over <= -halfKnee) return 0.0f;
  if (over >= halfKnee) return -p->slope * over;
  const float into = over + halfKnee;
  return -p->slope * into * into / (2.0f * p->kneeDb);
}

void WRPPlayoutProcessorProcess(WRPPlayoutProcessor *p, int16_t *interleaved, size_t frames) {
  const int channels = p->channels;
  float inputPeak = p->stats.inputPeak;
  float outputPeak = p->stats.outputPeak;
  float deepestCompressionDb = 0.0f;
  float lowestLimiterGain = 1.0f;

  for (size_t f = 0; f < frames; f++) {
    int16_t *frame = interleaved + f * channels;

    // Linked across channels: one gain for the frame, so the stereo image never
    // shifts under compression.
    float x[WRP_PP_MAX_CHANNELS];
    float peak = 0.0f;
    float power = 0.0f;
    for (int c = 0; c < channels; c++) {
      x[c] = (float)frame[c] / FULL_SCALE;
      const float magnitude = fabsf(x[c]);
      if (magnitude > peak) peak = magnitude;
      power += x[c] * x[c];
    }
    if (peak > inputPeak) inputPeak = peak;

    // --- Compressor: an RMS level into the static curve, then attack/release
    // smoothing on the gain reduction it asks for.
    power *= p->inputGain * p->inputGain / (float)channels;
    p->meanSquare = p->rmsCoef * p->meanSquare + (1.0f - p->rmsCoef) * power;
    const float levelDb = p->meanSquare > 1e-12f ? 10.0f * log10f(p->meanSquare) : SILENCE_DB;
    const float wanted = Reduction(p, levelDb);
    const int holding = levelDb < p->holdDb;
    if (wanted > p->smoothDb) {
      p->smoothDb = p->attackCoef * p->smoothDb + (1.0f - p->attackCoef) * wanted;
    } else if (!holding) {
      p->smoothDb = p->releaseCoef * p->smoothDb + (1.0f - p->releaseCoef) * wanted;
    }
    if (p->smoothDb > deepestCompressionDb) deepestCompressionDb = p->smoothDb;
    const float gain = p->inputGain * (p->smoothDb > 1e-4f ? DbToLinear(-p->smoothDb) : 1.0f);

    float compressed[WRP_PP_MAX_CHANNELS];
    float compressedPeak = 0.0f;
    for (int c = 0; c < channels; c++) {
      compressed[c] = x[c] * gain;
      const float magnitude = fabsf(compressed[c]);
      if (magnitude > compressedPeak) compressedPeak = magnitude;
    }

    // --- Limiter. `needed` is the gain this frame requires to stay under the
    // ceiling. The minimum of that over the lookahead window, averaged over the
    // same window, is a gain that ramps down across the window and reaches the
    // required value exactly when the peak leaves the delay line — so the
    // ceiling holds with no step in the gain.
    const float needed = compressedPeak > p->ceiling ? p->ceiling / compressedPeak : 1.0f;

    if (p->minCount > 0 && (uint32_t)(p->frame - p->minStamp[p->minHead]) >= WRP_PP_LOOKAHEAD) {
      p->minHead = (p->minHead + 1) % WRP_PP_LOOKAHEAD;
      p->minCount--;
    }
    while (p->minCount > 0) {
      const int tail = (p->minHead + p->minCount - 1) % WRP_PP_LOOKAHEAD;
      if (p->minValue[tail] < needed) break;
      p->minCount--;
    }
    const int slot = (p->minHead + p->minCount) % WRP_PP_LOOKAHEAD;
    p->minValue[slot] = needed;
    p->minStamp[slot] = p->frame;
    p->minCount++;
    const float held = p->minValue[p->minHead];

    p->boxSum += held - p->boxRing[p->boxPos];
    p->boxRing[p->boxPos] = held;
    p->boxPos = (p->boxPos + 1) % WRP_PP_LOOKAHEAD;
    const float average = (float)(p->boxSum / WRP_PP_LOOKAHEAD);

    // Attack follows the averaged gain exactly (it is already smooth); release
    // eases back up so the gain does not flutter between peaks.
    if (average < p->limiterGain) {
      p->limiterGain = average;
    } else if (!holding) {
      p->limiterGain += (average - p->limiterGain) * (1.0f - p->limiterReleaseCoef);
    }
    if (p->limiterGain < lowestLimiterGain) lowestLimiterGain = p->limiterGain;

    // The frame leaving the delay line entered it LOOKAHEAD - 1 frames ago.
    for (int c = 0; c < channels; c++) p->delay[p->delayPos][c] = compressed[c];
    const int out = (p->delayPos + 1) % WRP_PP_LOOKAHEAD;
    for (int c = 0; c < channels; c++) {
      const float y = p->delay[out][c] * p->limiterGain;
      const float magnitude = fabsf(y);
      if (magnitude > outputPeak) outputPeak = magnitude;
      float scaled = y * FULL_SCALE;
      if (scaled > 32767.0f) scaled = 32767.0f;
      if (scaled < -32768.0f) scaled = -32768.0f;
      frame[c] = (int16_t)lrintf(scaled);
    }
    p->delayPos = out;
    p->frame++;
  }

  p->stats.inputPeak = inputPeak;
  p->stats.outputPeak = outputPeak;
  const float reductionDb = deepestCompressionDb - 20.0f * log10f(lowestLimiterGain);
  if (reductionDb > p->stats.maxReductionDb) p->stats.maxReductionDb = reductionDb;
}

WRPPlayoutStats WRPPlayoutProcessorTakeStats(WRPPlayoutProcessor *p) {
  WRPPlayoutStats stats = p->stats;
  memset(&p->stats, 0, sizeof(p->stats));
  return stats;
}
