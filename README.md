> **This is `@fluxlabs/react-native-webrtc`**, a fork of [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc) 124.0.8 that adds seamless picture-in-picture on Android. The sections after this one are upstream's README.

## About this fork

Upstream **124.0.8**, plus picture-in-picture for `RTCView` on Android. It starts from [react-native-webrtc#1710](https://github.com/react-native-webrtc/react-native-webrtc/pull/1710) by [@EdgarJMesquita](https://github.com/EdgarJMesquita), reworked so the transition is seamless:

- The video replaces the screen as the transition starts (Android 15+ reports it; earlier versions when the activity pauses into PiP), so the shrink animation shows the video, not the controls drawn over it.
- A still of the last frame covers the moved video surface until it draws again, so there is no black flash.
- The PiP window takes the video's shape and animates from where the video is on screen.
- Leaving the app starts PiP on Android 8 and later; `startPictureInPicture()` starts it on request.

### Install

Install it under the upstream name, so imports and native project names do not change:

```sh
yarn add react-native-webrtc@npm:@fluxlabs/react-native-webrtc@124.1.0
```

### Picture-in-picture

```tsx
import { RTCView, isInPictureInPicture, isPictureInPictureSupported } from 'react-native-webrtc';

<RTCView
    streamURL={streamURL}
    objectFit="cover"
    pictureInPictureEnabled
    autoStartPictureInPicture
    onPictureInPictureChange={(active, { dismissed }) => {
        // dismissed (Android): the viewer closed the window rather than returning to the app.
    }}
/>
```

- `ref.current?.startPictureInPicture()` enters on request.
- `isPictureInPictureSupported()` resolves `false` when the device lacks PiP or the user turned it off for the app.
- `isInPictureInPicture()` answers synchronously. On Android, AppState reports `background` as soon as the activity pauses into PiP, sometimes before `onPictureInPictureChange` arrives.
- One view manages PiP at a time: the most recently enabled one. Automatic entry waits for a video track.

Android needs `android:supportsPictureInPicture="true"` on the activity, `configChanges` that include `screenSize|smallestScreenSize|screenLayout`, and compileSdk 36 (androidx.activity 1.13). While in PiP the activity is paused, and React Native does not run JS timers for a paused activity. iOS needs iOS 15 and the `audio` background mode.

---

[<img src="https://avatars.githubusercontent.com/u/42463376" alt="React Native WebRTC" style="height: 6em;" />](https://github.com/react-native-webrtc/react-native-webrtc)

# React-Native-WebRTC

[![npm version](https://img.shields.io/npm/v/react-native-webrtc)](https://www.npmjs.com/package/react-native-webrtc)
[![npm downloads](https://img.shields.io/npm/dm/react-native-webrtc)](https://www.npmjs.com/package/react-native-webrtc)
[![Discourse topics](https://img.shields.io/discourse/topics?server=https%3A%2F%2Freact-native-webrtc.discourse.group%2F)](https://react-native-webrtc.discourse.group/)

A WebRTC module for React Native.

## Feature Overview

|  | Android | iOS | tvOS | macOS* | Windows* | Web* | Expo* |
| :- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Audio/Video | :heavy_check_mark: | :heavy_check_mark: | :heavy_check_mark: | - | - | :heavy_check_mark: | :heavy_check_mark: |
| Data Channels | :heavy_check_mark: | :heavy_check_mark: | - | - | - | :heavy_check_mark: | :heavy_check_mark: |
| Screen Capture | :heavy_check_mark: | :heavy_check_mark: | - | - | - | :heavy_check_mark: | :heavy_check_mark: |
| Plan B | - | - | - | - | - | - | - |
| Unified Plan* | :heavy_check_mark: | :heavy_check_mark: | - | - | - | :heavy_check_mark: | :heavy_check_mark: |
| Simulcast* | :heavy_check_mark: | :heavy_check_mark: | - | - | - | :heavy_check_mark: | :heavy_check_mark: |

> **macOS** - We don't currently actively support macOS at this time.  
Support might return in the future.

> **Windows** - We don't currently support the [react-native-windows](https://github.com/microsoft/react-native-windows) platform at this time.  
Anyone interested in getting the ball rolling? We're open to contributions.

> **Web** - The [react-native-webrtc-web-shim](https://github.com/react-native-webrtc/react-native-webrtc-web-shim) project provides a shim for [react-native-web](https://github.com/necolas/react-native-web) support.  
Which will allow you to use [(almost)](https://github.com/react-native-webrtc/react-native-webrtc-web-shim/tree/main#setup) the exact same code in your [react-native-web](https://github.com/necolas/react-native-web) project as you would with [react-native](https://reactnative.dev/) directly.  

> **Expo** - As this module includes native code it is not available in the [Expo Go](https://expo.dev/client) app by default.  
However you can get things working via the [expo-dev-client](https://docs.expo.dev/development/getting-started/) library and out-of-tree [config-plugins/react-native-webrtc](https://github.com/expo/config-plugins/tree/master/packages/react-native-webrtc) package.  

> **Unified Plan** - As of version 106.0.0 Unified Plan is the only supported mode.  
Those still in need of Plan B will need to use an older release.

> **Simulcast** - As of version 111.0.0 Simulcast is now possible with ease.  
Software encode/decode factories have been enabled by default.

## WebRTC Revision

* Currently used revision: [M124](https://github.com/jitsi/webrtc/tree/M124)
* Supported architectures
  * Android: armeabi-v7a, arm64-v8a, x86, x86_64
  * iOS: arm64, x86_64
  * tvOS: arm64
  * macOS: arm64, x86_64

## Getting Started

Use one of the following preferred package install methods to immediately get going.  
Don't forget to follow platform guides below to cover any extra required steps.  

**npm:** `npm install react-native-webrtc --save`  
**yarn:** `yarn add react-native-webrtc`  
**pnpm:** `pnpm install react-native-webrtc`  

## Guides

- [Android Install](./Documentation/AndroidInstallation.md)
- [iOS Install](./Documentation/iOSInstallation.md)
- [tvOS Install](./Documentation/tvOSInstallation.md)
- [Basic Usage](./Documentation/BasicUsage.md)
- [Step by Step Call Guide](./Documentation/CallGuide.md)
- [Improving Call Reliability](./Documentation/ImprovingCallReliability.md)
- [Migrating to Unified Plan](https://docs.google.com/document/d/1-ZfikoUtoJa9k-GZG1daN0BU3IjIanQ_JSscHxQesvU/edit#heading=h.wuu7dx8tnifl)

## Example Projects

We have some very basic example projects included in the [examples](./examples) directory.  
Don't worry, there are plans to include a much more broader example with backend included.  

## Community

Come join our [Discourse Community](https://react-native-webrtc.discourse.group/) if you want to discuss any React Native and WebRTC related topics.  
Everyone is welcome and every little helps.  

## Related Projects

Looking for extra functionality coverage?  
The [react-native-webrtc](https://github.com/react-native-webrtc) organization provides a number of packages which are more than useful when developing Real Time Communication applications.  
