import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { fromRunner, type Request, type Runner } from "./textGenerationOperations.ts";

describe("fromRunner cleanDictation", () => {
  it.effect("runs one plain prompt and trims the rewrite", () =>
    Effect.gen(function* () {
      const requests: Array<Request<Schema.Top>> = [];
      const run: Runner = (request) =>
        Effect.sync(() => {
          requests.push(request);
          return { text: "  Run the tests.  " } as never;
        });
      const generation = fromRunner("Test", run);
      const result = yield* generation.cleanDictation!({
        cwd: "/tmp",
        transcript: "um run the the tests",
        language: "en",
        vocabulary: "",
        instructions: "",
        conversation: [],
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      });
      expect(result).toEqual({ text: "Run the tests." });
      expect(requests[0]!.operation).toBe("cleanDictation");
      expect(requests[0]!.investigate).toBeUndefined();
      expect(requests[0]!.prompt).toContain("Transcript:\num run the the tests");
      // Cursor, Grok, Pi, and OpenCode decode the reply as JSON, so the prompt must ask for it.
      expect(requests[0]!.prompt).toContain(
        "Return a JSON object with one key, text: the cleaned message.",
      );
    }),
  );
});
