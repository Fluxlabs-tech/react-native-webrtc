package com.oney.WebRTCModule;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.common.MapBuilder;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.ViewGroupManager;
import com.facebook.react.uimanager.annotations.ReactProp;

import java.util.HashMap;
import java.util.Map;

public class RTCVideoViewManager extends ViewGroupManager<WebRTCView> {
    private static final String REACT_CLASS = "RTCVideoView";

    @Override
    public String getName() {
        return REACT_CLASS;
    }

    public static final int COMMAND_ENTER_PIP = 1;
    public static final int COMMAND_EXIT_PIP = 2;

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
    @ReactProp(name = "mirror")
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
    @ReactProp(name = "objectFit")
    public void setObjectFit(WebRTCView view, String objectFit) {
        view.setObjectFit(objectFit);
    }

    @ReactProp(name = "streamURL")
    public void setStreamURL(WebRTCView view, String streamURL) {
        view.setStreamURL(streamURL);
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
    @ReactProp(name = "zOrder")
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
    @ReactProp(name = "pictureInPictureEnabled", defaultBoolean = false)
    public void setPictureInPictureEnabled(WebRTCView view, boolean enabled) {
        view.setPictureInPictureEnabled(enabled);
    }

    /**
     * Sets whether leaving the app enters picture-in-picture by itself.
     *
     * @param view The {@code WebRTCView} on which the flag is to be set.
     * @param autoStart Whether picture-in-picture starts automatically.
     */
    @ReactProp(name = "autoStartPictureInPicture", defaultBoolean = true)
    public void setAutoStartPictureInPicture(WebRTCView view, boolean autoStart) {
        view.setAutoStartPictureInPicture(autoStart);
    }

    /**
     * Sets the shape of the picture-in-picture window, as {@code {width, height}}. Only the ratio
     * matters on Android.
     */
    @ReactProp(name = "pictureInPicturePreferredSize")
    public void setPictureInPicturePreferredSize(WebRTCView view, @Nullable ReadableMap size) {
        view.setPictureInPicturePreferredSize(size);
    }

    @Nullable
    @Override
    public Map<String, Integer> getCommandsMap() {
        return MapBuilder.of("startPictureInPicture", COMMAND_ENTER_PIP, "stopPictureInPicture", COMMAND_EXIT_PIP);
    }

    @Override
    public void receiveCommand(@NonNull WebRTCView view, String commandId, @Nullable ReadableArray args) {
        // The new architecture passes the command's number as a string; accept its name too.
        switch (commandId) {
            case "startPictureInPicture":
            case "" + COMMAND_ENTER_PIP:
                view.enterPictureInPicture();
                break;
            case "stopPictureInPicture":
            case "" + COMMAND_EXIT_PIP:
                // Android has no call to leave picture-in-picture; the user does.
                break;
            default:
                super.receiveCommand(view, commandId, args);
        }
    }

    /**
     * Sets the callback for when video dimensions change.
     *
     * @param view The {@code WebRTCView} on which the callback is to be set.
     * @param onDimensionsChange The callback to be called when video dimensions change.
     */
    @ReactProp(name = "onDimensionsChange")
    public void setOnDimensionsChange(WebRTCView view, boolean onDimensionsChange) {
        view.setOnDimensionsChange(onDimensionsChange);
    }

    @Override
    public Map<String, Object> getExportedCustomDirectEventTypeConstants() {
        // Added to the base view manager's events, not in place of them.
        Map<String, Object> base = super.getExportedCustomDirectEventTypeConstants();
        Map<String, Object> eventTypeConstants = base != null ? new HashMap<>(base) : new HashMap<>();
        eventTypeConstants.put("onDimensionsChange", MapBuilder.of("registrationName", "onDimensionsChange"));
        eventTypeConstants.put(
                PictureInPictureChangeEvent.EVENT_NAME, MapBuilder.of("registrationName", "onPictureInPictureChange"));
        return eventTypeConstants;
    }
}
