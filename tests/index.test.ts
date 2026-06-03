import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockInitializeOtel, mockHandlers } = vi.hoisted(() => {
  const mockShutdown = vi.fn();
  return {
    mockInitializeOtel: vi.fn(() => ({ shutdown: mockShutdown })),
    mockHandlers: {
      beforePromptBuild: vi.fn(),
      beforeToolCall: vi.fn(),
      toolResultPersist: vi.fn(),
      agentEnd: vi.fn(),
      llmInput: vi.fn(),
      llmOutput: vi.fn(),
    },
  };
});

vi.mock('../src/otel.js', () => ({
  initializeOtel: mockInitializeOtel,
}));

vi.mock('../src/hooks/before-agent-start.js', () => ({
  handleBeforePromptBuild: mockHandlers.beforePromptBuild,
}));

vi.mock('../src/hooks/before-tool-call.js', () => ({
  handleBeforeToolCall: mockHandlers.beforeToolCall,
}));

vi.mock('../src/hooks/tool-result-persist.js', () => ({
  handleToolResultPersist: mockHandlers.toolResultPersist,
}));

vi.mock('../src/hooks/agent-end.js', () => ({
  handleAgentEnd: mockHandlers.agentEnd,
}));

vi.mock('../src/hooks/llm-input.js', () => ({
  handleLlmInput: mockHandlers.llmInput,
}));

vi.mock('../src/hooks/llm-output.js', () => ({
  handleLlmOutput: mockHandlers.llmOutput,
}));

import register from '../src/index.js';
import { createMockLogger } from './test-helpers.js';

function createPluginApi(pluginConfig: Record<string, unknown> = { apiKey: 'test-key' }) {
  return {
    pluginConfig,
    logger: createMockLogger(),
    on: vi.fn(),
    registerService: vi.fn(),
  };
}

describe('register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers modern hooks without the legacy before_agent_start hook', () => {
    const api = createPluginApi();

    register(api);

    const hookNames = api.on.mock.calls.map(([hookName]) => hookName);

    expect(hookNames).toEqual([
      'before_prompt_build',
      'before_tool_call',
      'tool_result_persist',
      'agent_end',
      'llm_input',
      'llm_output',
    ]);
    expect(hookNames).not.toContain('before_agent_start');
  });

  it('does not register hooks when auth is missing', () => {
    const api = createPluginApi({});

    register(api);

    expect(api.on).not.toHaveBeenCalled();
    expect(api.registerService).not.toHaveBeenCalled();
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('PROMPTLAYER_API_KEY not set'),
    );
  });
});
