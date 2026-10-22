import time
import httpx
from app.schemas import MODEL_IDS


class ProviderError(Exception):
    """Sanitized error code; never expose provider bodies or credentials."""


class OpenRouter:
    def __init__(self, settings, transport=None):
        self.settings = settings
        self.transport = transport

    def complete(self, model: str, messages: list[dict], json_output=False):
        if model not in MODEL_IDS:
            raise ProviderError("model_not_allowed")
        key = self.settings.openrouter_api_key.get_secret_value()
        if not key:
            raise ProviderError("openrouter_not_configured")
        payload = {
            "model": model, "messages": messages,
            "max_tokens": self.settings.llm_max_tokens,
            "provider": {"allow_fallbacks": False, "require_parameters": True},
        }
        if json_output:
            payload["response_format"] = {"type": "json_object"}
        start = time.monotonic()
        # No automatic retry: a timed-out generation can still be billed upstream.
        try:
            with httpx.Client(timeout=self.settings.llm_timeout_seconds, transport=self.transport) as client:
                response = client.post("https://openrouter.ai/api/v1/chat/completions", json=payload, headers={
                    "Authorization": f"Bearer {key}", "X-OpenRouter-Title": "Agentic LLM Benchmark",
                })
            if response.status_code != 200:
                raise ProviderError(f"openrouter_http_{response.status_code}")
            data = response.json()
            if "error" in data:
                raise ProviderError("openrouter_response_error")
            content = data["choices"][0]["message"]["content"]
            if not isinstance(content, str) or not content.strip():
                raise ProviderError("empty_completion")
            if data["choices"][0].get("finish_reason") != "stop":
                raise ProviderError("incomplete_completion")
            if data.get("model") != model:
                raise ProviderError("unexpected_model")
            return {
                "content": content, "requested_model": model, "returned_model": data["model"],
                "provider": data.get("provider"), "generation_id": data.get("id"),
                "usage": data.get("usage", {}), "latency_ms": round((time.monotonic() - start) * 1000),
            }
        except httpx.TimeoutException:
            raise ProviderError("openrouter_timeout") from None
        except httpx.HTTPError:
            raise ProviderError("openrouter_network_error") from None
        except (ValueError, KeyError, IndexError, TypeError):
            raise ProviderError("invalid_provider_response") from None
