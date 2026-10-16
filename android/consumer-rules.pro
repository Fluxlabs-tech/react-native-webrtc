# WebRTC
-keep class org.webrtc.** { *; }
-keep class J.N { *; }
-keepclasseswithmembers,includedescriptorclasses class ** {
    @org.jni_zero.CalledByNative <methods>;
}
-keepclasseswithmembers,includedescriptorclasses class ** {
    @org.jni_zero.CalledByNativeUnchecked <methods>;
}
-keepclasseswithmembers class ** {
    @org.jni_zero.AccessedByNative <fields>;
}
-dontwarn org.webrtc.Dav1dDecoder$Natives
