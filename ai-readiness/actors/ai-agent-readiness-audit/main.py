"""AI Agent Readiness Audit: Apify actor entry point."""

import asyncio

from actorkit.runner import run_actor

if __name__ == "__main__":
    asyncio.run(run_actor("readiness"))
