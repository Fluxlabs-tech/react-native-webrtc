// Expo's `expo prebuild` looks up `app.plugin.js` at the package root when an app lists
// "react-native-webrtc" in `expo.plugins`.
module.exports = require('./plugin/withWebRTC');
