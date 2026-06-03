type SpanAttributeMap = Record<string, string | number | string[]>;

export function addUsageAttributes(
  attributes: SpanAttributeMap,
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
): void {
  if (usage.input !== undefined) {
    attributes['gen_ai.usage.input_tokens'] = usage.input;
  }
  if (usage.output !== undefined) {
    attributes['gen_ai.usage.output_tokens'] = usage.output;
  }
  if (usage.cacheRead !== undefined) {
    attributes['openclaw.usage.cache_read_tokens'] = usage.cacheRead;
  }
  if (usage.cacheWrite !== undefined) {
    attributes['openclaw.usage.cache_write_tokens'] = usage.cacheWrite;
  }
}
