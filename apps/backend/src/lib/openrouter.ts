import { MODEL_IDS } from "@clinical/shared";
import type { Settings } from "./config.js";
export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};
export interface Reply {
  content: string;
  requested_model: string;
  returned_model: string;
  provider: string | null;
  generation_id: string | null;
  usage: Record<string, unknown>;
  latency_ms: number;
}
export interface Provider {
  complete(model: string, messages: Message[], json?: boolean): Promise<Reply>;
}
export class ProviderError extends Error {}
export class OpenRouter implements Provider {
  constructor(
    private settings: Settings,
    private transport: typeof fetch = fetch,
  ) {}
  async complete(
    model: string,
    messages: Message[],
    json = false,
  ): Promise<Reply> {
    if (!(MODEL_IDS as readonly string[]).includes(model))
      throw new ProviderError("model_not_allowed");
    if (!this.settings.openrouterKey)
      throw new ProviderError("openrouter_not_configured");
    const started = performance.now();
    try {
      // A timed-out call may already have been billed. Never automatically replay it.
      const response = await this.transport(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          signal: AbortSignal.timeout(this.settings.llmTimeout),
          headers: {
            Authorization: `Bearer ${this.settings.openrouterKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "Clinical Reasoning Study",
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: this.settings.maxTokens,
            provider: { allow_fallbacks: false, require_parameters: true },
            ...(json ? { response_format: { type: "json_object" } } : {}),
          }),
        },
      );
      if (!response.ok)
        throw new ProviderError(`openrouter_http_${response.status}`);
      const data = (await response.json()) as any;
      if (data.error) throw new ProviderError("openrouter_response_error");
      const choice = data.choices?.[0];
      if (
        typeof choice?.message?.content !== "string" ||
        !choice.message.content.trim()
      )
        throw new ProviderError("empty_completion");
      if (choice.finish_reason !== "stop")
        throw new ProviderError("incomplete_completion");
      if (data.model !== model) throw new ProviderError("unexpected_model");
      return {
        content: choice.message.content,
        requested_model: model,
        returned_model: data.model,
        provider: data.provider ?? null,
        generation_id: data.id ?? null,
        usage: data.usage ?? {},
        latency_ms: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
      )
        throw new ProviderError("openrouter_timeout");
      throw new ProviderError("openrouter_network_or_response_error");
    }
  }
}
