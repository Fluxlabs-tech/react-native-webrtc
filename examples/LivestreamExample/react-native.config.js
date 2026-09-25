const path = require('path');

// The library is this repository, linked from ../.. rather than installed from npm.
module.exports = {
  dependencies: {
    'react-native-webrtc': {
      root: path.join(__dirname, '../..'),
    },
  },
};
