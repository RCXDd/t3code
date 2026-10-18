Pod::Spec.new do |s|
  s.name           = 'T3OnDeviceTranscription'
  s.version        = '1.0.0'
  s.summary        = 'On-device Parakeet transcription for T3 Code dictation.'
  s.description    = 'Downloads Parakeet on demand and transcribes recordings on the Apple Neural Engine.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # FluidAudio ships its current releases through Swift Package Manager only.
  spm_dependency(s,
    url: 'https://github.com/FluidInference/FluidAudio.git',
    requirement: { kind: 'exactVersion', version: '0.17.7' },
    products: ['FluidAudio']
  )
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift}'
end
