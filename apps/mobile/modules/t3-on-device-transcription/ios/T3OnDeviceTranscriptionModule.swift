import ExpoModulesCore
import FluidAudio

/// Parakeet runs on the Neural Engine. The app does not bundle the model: it is downloaded on
/// request from Settings, kept in Application Support, and can be deleted again.
private let modelVersion: AsrModelVersion = .ultra

private actor ParakeetEngine {
  private var manager: AsrManager?

  func loadedManager() async throws -> AsrManager {
    if let manager { return manager }
    // The models are already on disk, so this loads and compiles them without downloading.
    let models = try await AsrModels.downloadAndLoad(version: modelVersion)
    let loaded = AsrManager(config: .default)
    try await loaded.loadModels(models)
    manager = loaded
    return loaded
  }

  func transcribe(_ url: URL) async throws -> String {
    let manager = try await loadedManager()
    var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
    return try await manager.transcribe(url, decoderState: &state).text
  }

  func unload() async {
    await manager?.cleanup()
    manager = nil
  }
}

public final class T3OnDeviceTranscriptionModule: Module {
  private let engine = ParakeetEngine()

  private var modelDirectory: URL {
    AsrModels.defaultCacheDirectory(for: modelVersion)
  }

  public func definition() -> ModuleDefinition {
    Name("T3OnDeviceTranscription")

    Events("onDownloadProgress")

    Function("isModelDownloaded") { () -> Bool in
      AsrModels.modelsExist(at: self.modelDirectory, version: modelVersion)
    }

    AsyncFunction("downloadModel") { () async throws in
      _ = try await AsrModels.download(version: modelVersion) { [weak self] progress in
        self?.sendEvent("onDownloadProgress", ["fraction": progress.fractionCompleted])
      }
    }

    AsyncFunction("deleteModel") { () async throws in
      await self.engine.unload()
      let directory = self.modelDirectory
      if FileManager.default.fileExists(atPath: directory.path) {
        try FileManager.default.removeItem(at: directory)
      }
    }

    AsyncFunction("prepare") { () async throws in
      _ = try await self.engine.loadedManager()
    }

    AsyncFunction("transcribe") { (uri: String) async throws -> String in
      let url = URL(string: uri).flatMap { $0.isFileURL ? $0 : nil } ?? URL(fileURLWithPath: uri)
      return try await self.engine.transcribe(url)
    }
  }
}
