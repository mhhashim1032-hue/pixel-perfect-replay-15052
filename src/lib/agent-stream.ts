import type { AgentEvent } from "@/lib/providers";

/** Decodes newline-delimited agent events across arbitrary byte chunks. */
export function createAgentEventDecoder() {
  const decoder = new TextDecoder();
  let buffer = "";

  function parseLines(final: boolean): AgentEvent[] {
    const lines = buffer.split("\n");
    // Keep the incomplete tail during streaming; at EOF, parse that final line too.
    buffer = final ? "" : lines.pop() ?? "";
    return lines
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AgentEvent);
  }

  return {
    push(chunk: Uint8Array): AgentEvent[] {
      buffer += decoder.decode(chunk, { stream: true });
      return parseLines(false);
    },
    finish(): AgentEvent[] {
      buffer += decoder.decode();
      return parseLines(true);
    },
  };
}
