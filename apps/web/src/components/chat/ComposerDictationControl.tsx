import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { WebVoiceRecorder } from "../../lib/webVoiceRecorder";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerDictation } from "./useComposerDictation";

const BAR_COUNT = 28;
const BAR_WIDTH = 2;
const BAR_GAP = 2;
const CANVAS_HEIGHT = 20;

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Drawn on a canvas so recording does not re-render the composer every frame. */
function DictationWaveform({ recorder }: { readonly recorder: WebVoiceRecorder }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = BAR_COUNT * (BAR_WIDTH + BAR_GAP) * scale;
    canvas.height = CANVAS_HEIGHT * scale;
    context.scale(scale, scale);
    const levels: number[] = Array.from({ length: BAR_COUNT }, () => 0);
    const startedAt = performance.now();
    let lastSample = 0;
    let lastSecond = -1;
    let frame = 0;
    const draw = (now: number) => {
      // About 16 samples a second keeps the bars readable instead of jittery.
      if (now - lastSample > 60) {
        lastSample = now;
        levels.shift();
        levels.push(recorder.level());
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = getComputedStyle(canvas).color;
        levels.forEach((level, index) => {
          const height = Math.max(2, level * CANVAS_HEIGHT);
          context.fillRect(
            index * (BAR_WIDTH + BAR_GAP),
            (CANVAS_HEIGHT - height) / 2,
            BAR_WIDTH,
            height,
          );
        });
      }
      const second = Math.floor((now - startedAt) / 1000);
      if (second !== lastSecond && timerRef.current) {
        lastSecond = second;
        timerRef.current.textContent = formatElapsed(second);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [recorder]);

  return (
    <span className="flex items-center gap-2 text-foreground/70">
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{ width: BAR_COUNT * (BAR_WIDTH + BAR_GAP), height: CANVAS_HEIGHT }}
      />
      <span ref={timerRef} className="min-w-8 text-xs tabular-nums text-muted-foreground">
        0:00
      </span>
    </span>
  );
}

export function ComposerDictationControl({
  dictation,
  disabled,
}: {
  readonly dictation: ComposerDictation;
  readonly disabled: boolean;
}) {
  const { phase } = dictation.state;

  if (phase === "recording" || phase === "transcribing") {
    return (
      <div
        data-chat-composer-dictation={phase}
        className="flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 p-0.5"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onPointerDown={(event) => event.preventDefault()}
                onClick={dictation.cancel}
                aria-label="Cancel dictation"
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>Cancel</TooltipPopup>
        </Tooltip>
        {phase === "recording" ? (
          <DictationWaveform recorder={dictation.recorder} />
        ) : (
          <span className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Transcribing…
          </span>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={phase !== "recording"}
                onPointerDown={(event) => event.preventDefault()}
                onClick={dictation.stop}
                aria-label="Finish dictation"
              />
            }
          >
            <CheckIcon />
          </TooltipTrigger>
          <TooltipPopup>Insert transcript</TooltipPopup>
        </Tooltip>
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={phase === "preparing" ? dictation.cancel : dictation.start}
            aria-label={phase === "preparing" ? "Cancel dictation" : "Dictate"}
          />
        }
      >
        {phase === "preparing" ? <Spinner className="size-4" /> : <MicIcon />}
      </TooltipTrigger>
      <TooltipPopup>Dictate</TooltipPopup>
    </Tooltip>
  );
}
