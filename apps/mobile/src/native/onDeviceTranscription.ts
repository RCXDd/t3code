import { requireOptionalNativeModule } from "expo";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../state/atom-registry";

type OnDeviceTranscriptionModule = {
  isModelDownloaded(): boolean;
  downloadModel(): Promise<void>;
  deleteModel(): Promise<void>;
  prepare(): Promise<void>;
  transcribe(uri: string): Promise<string>;
  addListener(
    event: "onDownloadProgress",
    listener: (event: { readonly fraction: number }) => void,
  ): { remove(): void };
};

/** Null where the app was built without the module, which includes Android. */
const nativeModule =
  requireOptionalNativeModule<OnDeviceTranscriptionModule>("T3OnDeviceTranscription");

/** Shown in Settings before the one-time download. */
export const PARAKEET_DOWNLOAD_LABEL = "about 630 MB";

export type ParakeetModelState =
  | { readonly status: "unsupported" }
  | { readonly status: "absent" }
  | { readonly status: "downloading"; readonly fraction: number }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly message: string };

function readModelState(): ParakeetModelState {
  if (!nativeModule) return { status: "unsupported" };
  return nativeModule.isModelDownloaded() ? { status: "ready" } : { status: "absent" };
}

export const parakeetModelAtom = Atom.make<ParakeetModelState>(readModelState()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-parakeet-model"),
);

function setModelState(state: ParakeetModelState) {
  appAtomRegistry.set(parakeetModelAtom, state);
}

export function parakeetModule(): OnDeviceTranscriptionModule | null {
  return nativeModule;
}

/** Downloads once; a second call while downloading is ignored. */
export async function downloadParakeetModel(): Promise<void> {
  const current = appAtomRegistry.get(parakeetModelAtom);
  if (!nativeModule || current.status === "downloading" || current.status === "ready") return;
  setModelState({ status: "downloading", fraction: 0 });
  const subscription = nativeModule.addListener("onDownloadProgress", ({ fraction }) => {
    setModelState({ status: "downloading", fraction: Math.max(0, Math.min(1, fraction)) });
  });
  try {
    await nativeModule.downloadModel();
    setModelState(readModelState());
  } catch (error) {
    setModelState({
      status: "failed",
      message: error instanceof Error && error.message ? error.message : "The download failed.",
    });
  } finally {
    subscription.remove();
  }
}

export async function deleteParakeetModel(): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.deleteModel();
  } finally {
    setModelState(readModelState());
  }
}
