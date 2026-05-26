import anthropic
import httpx
from app.config import settings

_http_client = httpx.AsyncClient(verify=False)
_client = anthropic.AsyncAnthropic(
    api_key=settings.ANTHROPIC_API_KEY,
    http_client=_http_client,
)


async def call_claude(
    system_prompt: str,
    messages: list,
    max_tokens: int = 400,
    model: str = "claude-haiku-4-5-20251001",
) -> str:
    try:
        response = await _client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=messages,
        )
        return response.content[0].text
    except anthropic.APIConnectionError as e:
        raise Exception(f"Claude API connection error: {str(e)}")
    except anthropic.RateLimitError as e:
        raise Exception(f"Claude API rate limit exceeded: {str(e)}")
    except anthropic.APIStatusError as e:
        raise Exception(f"Claude API error {e.status_code}: {e.message}")
    except Exception as e:
        raise Exception(f"Unexpected error calling Claude: {str(e)}")
