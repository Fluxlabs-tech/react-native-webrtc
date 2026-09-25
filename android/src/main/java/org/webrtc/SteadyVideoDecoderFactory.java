package org.webrtc;

import android.media.MediaCodecInfo;
import android.media.MediaCodecInfo.CodecCapabilities;
import android.media.MediaCodecList;
import android.os.Build;

import androidx.annotation.Nullable;

/**
 * Hardware decoders, as HardwareVideoDecoderFactory offers them, made as SteadyAndroidVideoDecoder:
 * frames that arrive late after resent packets are shown rather than dropped.
 *
 * Lives in org.webrtc for libwebrtc's package-private MediaCodec helpers.
 */
public class SteadyVideoDecoderFactory implements VideoDecoderFactory {
    private static final String TAG = "SteadyVideoDecoderFactory";

    // CodecCapabilities.FEATURE_LowLatency, API 30: by value, for apps compiling against an older SDK.
    private static final String FEATURE_LOW_LATENCY = "low-latency";

    private final @Nullable EglBase.Context sharedContext;
    private final HardwareVideoDecoderFactory hardwareFactory;

    /**
     * @param sharedContext The textures generated will be accessible from this context. May be null,
     *                      which decodes to memory instead.
     */
    public SteadyVideoDecoderFactory(@Nullable EglBase.Context sharedContext) {
        this.sharedContext = sharedContext;
        this.hardwareFactory = new HardwareVideoDecoderFactory(sharedContext);
    }

    @Override
    public VideoCodecInfo[] getSupportedCodecs() {
        return hardwareFactory.getSupportedCodecs();
    }

    @Nullable
    @Override
    public VideoDecoder createDecoder(VideoCodecInfo codecInfo) {
        VideoCodecMimeType type;
        try {
            type = VideoCodecMimeType.valueOf(codecInfo.getName());
        } catch (IllegalArgumentException e) {
            return null;
        }

        MediaCodecInfo info = findHardwareDecoder(type);
        if (info == null) {
            return null;
        }

        CodecCapabilities capabilities = info.getCapabilitiesForType(type.mimeType());
        Integer colorFormat =
                MediaCodecUtils.selectColorFormat(MediaCodecUtils.DECODER_COLOR_FORMATS, capabilities);
        if (colorFormat == null) {
            return null;
        }

        boolean lowLatency = Build.VERSION.SDK_INT >= 30 && capabilities.isFeatureSupported(FEATURE_LOW_LATENCY);
        return new SteadyAndroidVideoDecoder(new MediaCodecWrapperFactoryImpl(), info.getName(), type, colorFormat,
                sharedContext, lowLatency);
    }

    // The first hardware decoder for the type, as HardwareVideoDecoderFactory picks it.
    @Nullable
    private static MediaCodecInfo findHardwareDecoder(VideoCodecMimeType type) {
        for (int i = 0; i < MediaCodecList.getCodecCount(); ++i) {
            MediaCodecInfo info;
            try {
                info = MediaCodecList.getCodecInfoAt(i);
            } catch (IllegalArgumentException e) {
                Logging.e(TAG, "Cannot retrieve decoder codec info", e);
                continue;
            }
            if (info == null || info.isEncoder() || !MediaCodecUtils.codecSupportsType(info, type)) {
                continue;
            }
            if (MediaCodecUtils.selectColorFormat(
                        MediaCodecUtils.DECODER_COLOR_FORMATS, info.getCapabilitiesForType(type.mimeType()))
                    == null) {
                continue;
            }
            if (MediaCodecUtils.isHardwareAccelerated(info)) {
                return info;
            }
        }
        return null;
    }
}
