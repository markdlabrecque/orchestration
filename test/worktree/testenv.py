"""Shared test-environment helper."""
import os

# Environment variables the agent harnesses export to their tools; scrubbed so
# harness detection never sees the agent running this suite.
HARNESS_MARKERS = ("CLAUDECODE", "PI_CODING_AGENT", "PI_SESSION_ID", "PI_SUBAGENT_CHILD",
                   "ORCH_PI_PARENT_SESSION", "CODEX_THREAD_ID", "CODEX_SESSION_ID",
                   "CODEX_CI", "AI_AGENT")


def clean_env():
    """os.environ minus orchestration/platform/harness variables."""
    return {
        k: v for k, v in os.environ.items()
        if not k.startswith(("ORCH_", "ORCA_", "HERDR_"))
        and k not in ("CLAUDE_CODE_ENTRYPOINT",) + HARNESS_MARKERS
    }
