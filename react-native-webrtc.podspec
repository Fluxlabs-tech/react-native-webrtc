require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  # Pinned: the npm name is scoped, which is not a valid pod name. Keeping the
  # upstream pod name also keeps the `react_native_webrtc` module name.
  s.name                = 'react-native-webrtc'
  s.version             = package['version']
  s.summary             = package['description']
  s.homepage            = 'https://github.com/Fluxlabs-tech/react-native-webrtc'
  s.license             = package['license']
  s.author              = 'https://github.com/react-native-webrtc/react-native-webrtc/graphs/contributors'
  s.source              = { :git => 'https://github.com/Fluxlabs-tech/react-native-webrtc.git', :tag => "v#{s.version}" }
  s.requires_arc        = true

  s.platforms           = { :ios => '12.0', :osx => '10.13', :tvos => '16.0' }

  s.preserve_paths      = 'ios/**/*'
  s.source_files        = 'ios/**/*.{h,m,mm,c}'
  s.libraries           = 'c', 'sqlite3', 'stdc++'
  s.framework           = 'AudioToolbox','AVFoundation', 'CoreAudio', 'CoreGraphics', 'CoreVideo', 'GLKit', 'VideoToolbox'
  # The livestream network monitor's path monitor.
  s.ios.framework       = 'Network'
  s.tvos.framework      = 'Network'
  s.dependency          'JitsiWebRTC', '~> 124.0.0'

  # React-Core plus the codegen and Fabric dependencies the TurboModule and the component views build
  # against.
  install_modules_dependencies(s)
end
