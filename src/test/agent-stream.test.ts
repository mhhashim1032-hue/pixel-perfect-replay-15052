import { describe, expect, it } from "vitest";
import { createAgentEventDecoder } from "@/lib/agent-stream";

const encode = (value: string) => new TextEncoder().encode(value);

describe("agent event stream decoder", () => {
  it("parses complete events split across arbitrary chunks", () => {
    const decoder = createAgentEventDecoder();
    expect(decoder.push(encode('{"t":"text","d":"hel'))).toEqual([]);
    expect(decoder.push(encode('lo"}\n{"t":"done"}\n'))).toEqual([
      { t: "text", d: "hello" },
      { t: "done" },
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  it("flushes a final event without a trailing newline", () => {
    const decoder = createAgentEventDecoder();
    expect(decoder.push(encode('{"t":"usage","input":12,"output":0'))).toEqual([]);
    expect(decoder.finish()).toEqual([{ t: "usage", input: 12, output: 0 }]);
  });

  it("preserves UTF-8 characters split between byte chunks", () => {
    const bytes = encode('{"t":"text","d":"世界"}\\n');
    const decoder = createAgentEventDecoder();
    const splitInsideFirstCharacter = encode('{"t":"text","d":"').length + 1;
    expect(decoder.push(bytes.slice(0, splitInsideFirstCharacter))).toEqual([]);
    expect(decoder.push(bytes.slice(splitInsideFirstCharacter))).toEqual([{ t: "text", d: "世界" }]);
  });
  it("ignores blank lines and handles several events in one chunk", () => {
    const decoder = createAgentEventDecoder();
    expect(decoder.push(encode('\n{"t":"done"}\n\n{"t":"error","m":"failed"}\n'))).toEqual([
      { t: "done" },
      { t: "error", m: "failed" },
    ]);
  });
});
