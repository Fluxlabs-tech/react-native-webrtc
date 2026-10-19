package com.oney.WebRTCModule;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.ViewGroupManager;
import com.facebook.react.uimanager.ViewManagerDelegate;
import com.facebook.react.viewmanagers.RTCVideoViewManagerDelegate;
import com.facebook.react.viewmanagers.RTCVideoViewManagerInterface;

/**
 * The {@code RTCVideoView} native component. Its props and commands come through the delegate
 * codegen generates from src/RTCVideoViewNativeComponent.ts.
 */
public class RTCVideoViewManager
        extends ViewGroupManager<WebRTCView> implements RTCVideoViewManagerInterface<WebRTCView> {
    private static final String REACT_CLASS = "RTCVideoView";

    private final ViewManagerDelegate<WebRTCView> delegate = new RTCVideoViewManagerDelegate<>(this);

    @Override
    public String getName() {
        return REACT_CLASS;
    }

    @Nullable
    @Override
    protected ViewManagerDelegate<WebRTCView> getDelegate() {
        return delegate;
    }

    @Override
    public WebRTCView createViewInstance(ThemedReactContext context) {
        return new WebRTCView(context);
    }

    /**
     * Sets the indicator which determines whether a specific {@link WebRTCView}
     * is to mirror the video specified by {@code streamURL} during its rendering.
     * For more details, refer to the documentation of the {@code mirror} property
     * of the JavaScript counterpart of {@code WebRTCView} i.e. {@code RTCView}.
     *
     * @param view The {@code WebRTCView} on which the specified {@code mirror} is
     * to be set.
     * @param mirror If the specified {@code WebRTCView} is to mirror the video
     * specified by its associated {@code streamURL} during its rendering,
     * {@code true}; otherwise, {@code false}.
     */
    @Override
    public void setMirror(WebRTCView view, boolean mirror) {
        view.setMirror(mirror);
    }

    /**
     * In the fashion of
     * https://www.w3.org/TR/html5/embedded-content-0.html#dom-video-videowidth
     * and https://www.w3.org/TR/html5/rendering.html#video-object-fit, resembles
     * the CSS style {@code object-fit}.
     *
     * @param view The {@code WebRTCView} on which the specified {@code objectFit}
     * is to be set.
     * @param objectFit For details, refer to the documentation of the
     * {@code objectFit} property of the JavaScript counterpart of
     * {@code WebRTCView} i.e. {@code RTCView}.
     */
    @Override
    public void setObjectFit(WebRTCView view, @Nullable String objectFit) {
        view.setObjectFit(objectFit);
    }

    @Override
    public void setStreamURL(WebRTCView view, @Nullable String streamURL) {
        view.setStreamURL(streamURL);
    }

    /**
     * Sets whether the remote audio of the stream a specific {@link WebRTCView} shows is silent.
     * For more details, refer to the documentation of the {@code muted} property of the JavaScript
     * counterpart of {@code WebRTCView} i.e. {@code RTCView}.
     *
     * @param view The {@code WebRTCView} on which the flag is to be set.
     * @param muted Whether the stream's remote audio is silent.
     */
    @Override
    public void setMuted(WebRTCView view, boolean muted) {
        view.setMuted(muted);
    }

    @Override
    public void onDropViewInstance(WebRTCView view) {
        // The view's hold on its stream's audio ends with the view.
        view.releaseAudioHold();
        super.onDropViewInstance(view);
    }

    /**
     * Sets the z-order of a specific {@link WebRTCView} in the stacking space of
     * all {@code WebRTCView}s. For more details, refer to the documentation of
     * the {@code zOrder} property of the JavaScript counterpart of
     * {@code WebRTCView} i.e. {@code RTCView}.
     *
     * @param view The {@code WebRTCView} on which the specified {@code zOrder} is
     * to be set.
     * @param zOrder The z-order to set on the specified {@code WebRTCView}.
     */
    @Override
    public void setZOrder(WebRTCView view, int zOrder) {
        view.setZOrder(zOrder);
    }

    /**
     * Sets whether a specific {@link WebRTCView} handles picture-in-picture. Only one view
     * should: the most recently enabled one does.
     *
     * @param view The {@code WebRTCView} on which the flag is to be set.
     * @param enabled Whether the view handles picture-in-picture.
     */
    @Override
    public void setPictureInPictureEnabled(WebRTCView view, boolean enabled) {
        view.setPictureInPictureEnabled(enabled);
    }

    /**
     * Sets whether leaving the app enters picture-in-picture by itself.
     *
     * @param view The {@code WebRTCView} on which the flag is to be set.
     * @param autoStart Whether picture-in-picture starts automatically.
     */
    @Override
    public void setAutoStartPictureInPicture(WebRTCView view, boolean autoStart) {
        view.setAutoStartPictureInPicture(autoStart);
    }

    /**
     * iOS only: Android leaves picture-in-picture when the user returns to the app.
     */
    @Override
    public void setAutoStopPictureInPicture(WebRTCView view, boolean autoStop) {}

    /**
     * Sets the shape of the picture-in-picture window, as {@code {width, height}}. Only the ratio
     * matters on Android.
     */
    @Override
    public void setPictureInPicturePreferredSize(WebRTCView view, @Nullable ReadableMap size) {
        view.setPictureInPicturePreferredSize(size);
    }

    /**
     * iOS only: Android has one kind of picture-in-picture window.
     */
    @Override
    public void setPictureInPictureKind(WebRTCView view, @Nullable String kind) {}

    @Override
    public void startPictureInPicture(WebRTCView view) {
        view.enterPictureInPicture();
    }

    /**
     * Android has no call to leave picture-in-picture; the user does.
     */
    @Override
    public void stopPictureInPicture(WebRTCView view) {}

    /**
     * iOS only, deprecated.
     */
    @Override
    public void startIOSPIP(WebRTCView view) {}

    /**
     * iOS only, deprecated.
     */
    @Override
    public void stopIOSPIP(WebRTCView view) {}
}
