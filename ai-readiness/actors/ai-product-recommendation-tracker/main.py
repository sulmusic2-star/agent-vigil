"""AI Product Recommendation Tracker: Apify actor entry point."""

import asyncio

from airecs.actor import run

if __name__ == "__main__":
    asyncio.run(run())
