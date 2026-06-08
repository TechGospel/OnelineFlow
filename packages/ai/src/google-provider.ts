/**
 * Google AI (Gemini) extraction provider.
 *
 * Kept as the second opinion primarily because it is a genuinely different
 * model family. Two models from the same family tend to make correlated
 * mistakes, which would make the consensus gate feel safe while catching very
 * little. Architectural diversity is the point.
 *
 * It also handles long multi-page scans well and is inexpensive, which matters
 * when the second opinion runs on a meaningful share of 2M documents a day.
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

export interface GoogleProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly pricing: ModelPricing;
}

export class GoogleAiProvider implements ExtractionProvider {
  readonly name = 'google';
  readonly model: string;

  constructor(private readonly opts: GoogleProviderOptions) {
    this.model = opts.model;
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const started = Date.now();
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(this.opts.model)}:generateContent`;

    const body = {
      systemInstruction: { parts: [{ text: EXTRACTION_SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: req.expectedCurrency
                ? `Extract this invoice. The tenant usually transacts in ${req.expectedCurrency}, ` +
                  'but use the currency actually shown on the document.'
                : 'Extract this invoice.',
            },
            {
              inlineData: {
                mimeType: req.mimeType,
                data: Buffer.from(req.documentBytes).toString('base64'),
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(EXTRACTION_JSON_SCHEMA),
      },
    };

    const res = await withTimeout(
      (signal) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Header rather than a query parameter: query strings end up in
            // access logs and proxy caches.
            'x-goog-api-key': this.opts.apiKey,
          },
          body: JSON.stringify(body),
          signal,
        }),
      this.opts.timeoutMs,
      'ai.google.extract',
      req.signal,
    );

    const text = await res.text();
    if (!res.ok) {
      throw new UpstreamError(`Google AI returned ${res.status}: ${text.slice(0, 300)}`, {
        context: { status: res.status, model: this.opts.model },
      });
    }

    /* eslint-disable @typescript-eslint/no-explicit-any -- untyped upstream body */
    const parsed: any = JSON.parse(text);
    const content = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof content !== 'string') {
      const reason = parsed?.candidates?.[0]?.finishReason ?? 'unknown';
      throw new UpstreamError(`Google AI returned no content (finishReason=${reason})`);
    }
    const usage = parsed?.usageMetadata ?? {};
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const inputTokens = Number(usage.promptTokenCount ?? 0);
    const outputTokens = Number(usage.candidatesTokenCount ?? 0);

    return {
      extracted: parseExtraction(content, 'google'),
      model: this.opts.model,
      provider: this.name,
      latencyMs: Date.now() - started,
      costMicros: computeCostMicros(this.opts.pricing, inputTokens, outputTokens),
      inputTokens,
      outputTokens,
    };
  }
}

/**
 * Gemini's responseSchema is a subset of JSON Schema: it rejects
 * `additionalProperties` and uses uppercase type names. Rather than maintain two
 * schema definitions that can drift apart, translate the one source of truth.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- schema transformation */
function toGeminiSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type' && typeof value === 'string') {
      out['type'] = value.toUpperCase();
      continue;
    }
    out[key] = toGeminiSchema(value);
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
