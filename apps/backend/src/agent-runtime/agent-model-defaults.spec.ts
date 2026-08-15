import {
  orderReasoningEfforts,
  resolveAgentStartupSelection,
} from './agent-model-defaults.js';
import type { AgentCatalogModel } from './agent-runtime.types.js';

const MODELS: AgentCatalogModel[] = [
  {
    id: 'opus',
    displayName: 'Opus',
    description: '',
    supportsEffort: true,
  },
  {
    id: 'haiku',
    displayName: 'Haiku',
    description: '',
    supportsEffort: false,
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4-Mini',
    description: '',
    supportsEffort: true,
    reasoningEfforts: ['low', 'medium'],
  },
];

describe('resolveAgentStartupSelection', () => {
  it('falls back to the provider default when nothing is configured', () => {
    expect(
      resolveAgentStartupSelection(
        { model: null, reasoningEffort: null },
        MODELS,
        'gpt-5.5',
      ),
    ).toEqual({ selectedModel: 'gpt-5.5', reasoningEffort: null });
  });

  it('leaves both unset when there is no configured or provider default', () => {
    expect(
      resolveAgentStartupSelection(
        { model: null, reasoningEffort: null },
        MODELS,
      ),
    ).toEqual({ selectedModel: null, reasoningEffort: null });
  });

  it('prefers the configured model over the provider default', () => {
    expect(
      resolveAgentStartupSelection(
        { model: 'opus', reasoningEffort: 'high' },
        MODELS,
        'sonnet',
      ),
    ).toEqual({ selectedModel: 'opus', reasoningEffort: 'high' });
  });

  it('honors a model the catalog has not caught up with yet', () => {
    expect(
      resolveAgentStartupSelection(
        { model: 'model-released-tomorrow', reasoningEffort: 'max' },
        MODELS,
      ),
    ).toEqual({
      selectedModel: 'model-released-tomorrow',
      reasoningEffort: 'max',
    });
  });

  it('drops the thinking level when the chosen model cannot reason', () => {
    expect(
      resolveAgentStartupSelection(
        { model: 'haiku', reasoningEffort: 'high' },
        MODELS,
      ),
    ).toEqual({ selectedModel: 'haiku', reasoningEffort: null });
  });

  it('drops a thinking level outside the levels the model reports', () => {
    expect(
      resolveAgentStartupSelection(
        { model: 'gpt-5.4-mini', reasoningEffort: 'max' },
        MODELS,
      ),
    ).toEqual({ selectedModel: 'gpt-5.4-mini', reasoningEffort: null });
  });

  it('keeps a thinking level the model reports as supported', () => {
    expect(
      resolveAgentStartupSelection(
        { model: 'gpt-5.4-mini', reasoningEffort: 'low' },
        MODELS,
      ),
    ).toEqual({ selectedModel: 'gpt-5.4-mini', reasoningEffort: 'low' });
  });

  it('applies a thinking level even when no model is pinned', () => {
    expect(
      resolveAgentStartupSelection(
        { model: null, reasoningEffort: 'high' },
        MODELS,
      ),
    ).toEqual({ selectedModel: null, reasoningEffort: 'high' });
  });
});

describe('orderReasoningEfforts', () => {
  it('sorts known levels weakest-first regardless of input order', () => {
    expect(orderReasoningEfforts(['high', 'low', 'xhigh', 'medium'])).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('keeps unrecognised levels at the end instead of dropping them', () => {
    expect(orderReasoningEfforts(['ultra', 'low', 'minimal'])).toEqual([
      'low',
      'minimal',
      'ultra',
    ]);
  });
});
