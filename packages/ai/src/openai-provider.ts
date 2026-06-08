/**
 * OpenAI extraction provider.
 *
 * Uses structured outputs (`response_format: json_schema` with `strict: true`)
 * so the model is constrained at decode time rather than merely asked nicely.
 * That removes the single largest source of extraction flakiness — valid-looking
 * JSON with the wrong shape.
 */

import { UpstreamError, withTimeout } from '@onelineflow/core';
import {
  computeCostMicros,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  parseExtraction,
  type ExtractionProvider,
  type ExtractionRequest,
  type ExtractionResult,
  type ModelPricing,
} from './provider.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export interface OpenAiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly pricing: ModelPricing;
}

export class OpenAiProvider implements ExtractionProvider {
  readonly name = 'openai';
  readonly model: string;

  constructor(private readonly opts: OpenAiProviderOptions) {
    this.model = opts.model;
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const started = Date.now();
    const dataUrl = `data:${req.mimeType};base64,${Buffer.from(req.documentBytes).toString('base64')}`;

    const body = {
      model: this.opts.model,
      // Deterministic decoding: the same invoice must extract identically on a
      // retry, otherwise the consensus comparison is measuring sampling noise.
      temperature: 0,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: req.expectedCurrency
                ? `Extract this invoice. The tenant usually transacts in ${req.expectedCurrency}, ` +
                  'but use the currency actually shown on the document.'
                : 'Extract this invoice.',
            },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'invoice', strict: true, schema: EXTRACTION_JSON_SCHEMA },
      },
    };

    const res = await withTimeout(
      (signal) =>
        fetch(OPENAI_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        }),
      this.opts.timeoutMs,
      'ai.openai.extract',
      req.signal,
    );

    const text = await res.text();
    if (!res.ok) {
      throw new UpstreamError(`OpenAI returned ${res.status}: ${text.slice(0, 300)}`, {
        context: { status: res.status, model: this.opts.model },
      });
    }

    /* eslint-disable @typescript-eslint/no-explicit-any -- untyped upstream body */
    const parsed: any = JSON.parse(text);
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new UpstreamError('OpenAI response contained no message content');
    }
    const usage = parsed?.usage ?? {};
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const inputTokens = Number(usage.prompt_tokens ?? 0);
    const outputTokens = Number(usage.completion_tokens ?? 0);

    return {
      extracted: parseExtraction(content, 'openai'),
      model: this.opts.model,
      provider: this.name,
      latencyMs: Date.now() - started,
      costMicros: computeCostMicros(this.opts.pricing, inputTokens, outputTokens),
      inputTokens,
      outputTokens,
    };
  }
}
