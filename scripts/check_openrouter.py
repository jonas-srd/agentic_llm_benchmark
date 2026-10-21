"""Run only explicitly: uses the environment key and makes three small paid calls."""
from app.config import get_settings
from app.openrouter import OpenRouter
from app.schemas import MODEL_IDS


if __name__ == "__main__":
    settings = get_settings().model_copy(update={"llm_max_tokens": 512})
    provider = OpenRouter(settings)
    for model in MODEL_IDS:
        reply = provider.complete(model, [
            {"role": "system", "content": "Return only a JSON object with a single key status and value ok."},
            {"role": "user", "content": "Connection test."},
        ], json_output=True)
        print(f"{model}: OK; {reply['latency_ms']} ms; total_tokens={reply['usage'].get('total_tokens')}", flush=True)
