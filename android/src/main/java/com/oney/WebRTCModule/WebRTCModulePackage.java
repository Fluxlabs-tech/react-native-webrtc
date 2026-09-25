package com.oney.WebRTCModule;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.BaseReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;
import com.facebook.react.uimanager.ViewManager;

import java.util.Collections;
import java.util.List;

/**
 * WebRTCModule, a TurboModule created when JS first asks for it, and the RTCVideoView component.
 */
public class WebRTCModulePackage extends BaseReactPackage {
    @Nullable
    @Override
    public NativeModule getModule(@NonNull String name, @NonNull ReactApplicationContext reactContext) {
        return name.equals(NativeWebRTCModuleSpec.NAME) ? new WebRTCModule(reactContext) : null;
    }

    @Override
    public ReactModuleInfoProvider getReactModuleInfoProvider() {
        return () -> Collections.singletonMap(NativeWebRTCModuleSpec.NAME,
                new ReactModuleInfo(NativeWebRTCModuleSpec.NAME,
                        WebRTCModule.class.getName(),
                        /* canOverrideExistingModule */ false,
                        /* needsEagerInit */ false,
                        /* isCxxModule */ false,
                        /* isTurboModule */ true));
    }

    @NonNull
    @Override
    public List<ViewManager> createViewManagers(@NonNull ReactApplicationContext reactContext) {
        return Collections.<ViewManager>singletonList(new RTCVideoViewManager());
    }
}
