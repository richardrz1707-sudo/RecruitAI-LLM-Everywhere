import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env relative to this file's location so it works regardless of CWD
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_env_path, override=True)


class Settings:
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    SUPABASE_URL: str = os.getenv("SUPABASE_URL", "")
    SUPABASE_ANON_KEY: str = os.getenv("SUPABASE_ANON_KEY", "")
    # Service role key bypasses RLS — used for server-side public operations.
    # Get it from: Supabase Dashboard → Project Settings → API → service_role key
    SUPABASE_SERVICE_KEY: str = os.getenv("SUPABASE_SERVICE_KEY", "")


settings = Settings()
