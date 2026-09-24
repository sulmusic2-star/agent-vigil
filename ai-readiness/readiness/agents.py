"""Known AI crawlers and agents, keyed by the product token used in robots.txt.

Purposes:
    training - collects content to train or improve models
    search   - indexes content for an AI search or answer product
    user     - fetches a page because a person asked an assistant to
    other    - general or mixed use that feeds AI features

Some tokens (Google-Extended, Applebot-Extended) are *control tokens*: no crawler
sends them as a user agent, but the vendor honours robots.txt rules written for
them. The list is maintained by hand; callers can add tokens at run time.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AIAgent:
    token: str
    vendor: str
    purpose: str  # training | search | user | other
    note: str = ""


AI_AGENTS: tuple[AIAgent, ...] = (
    AIAgent("GPTBot", "OpenAI", "training", "Collects content that may be used to train OpenAI models."),
    AIAgent("OAI-SearchBot", "OpenAI", "search", "Indexes sites for ChatGPT search results."),
    AIAgent("ChatGPT-User", "OpenAI", "user", "Fetches pages when a ChatGPT user asks."),
    AIAgent("ClaudeBot", "Anthropic", "training", "Collects content that may be used to train Claude."),
    AIAgent("Claude-SearchBot", "Anthropic", "search", "Indexes sites to improve Claude's search results."),
    AIAgent("Claude-User", "Anthropic", "user", "Fetches pages when a Claude user asks."),
    AIAgent("anthropic-ai", "Anthropic", "training", "Older Anthropic token that many robots.txt files still list."),
    AIAgent("Google-Extended", "Google", "training", "Control token for Gemini training and grounding; Googlebot still crawls for Search."),
    AIAgent("GoogleOther", "Google", "other", "Generic Google crawler used for research and product work."),
    AIAgent("Applebot-Extended", "Apple", "training", "Control token for Apple AI training; Applebot still crawls for Siri and Spotlight."),
    AIAgent("PerplexityBot", "Perplexity", "search", "Indexes sites for Perplexity answers."),
    AIAgent("Perplexity-User", "Perplexity", "user", "Fetches pages when a Perplexity user asks."),
    AIAgent("Meta-ExternalAgent", "Meta", "training", "Collects content for Meta AI models and products."),
    AIAgent("Meta-ExternalFetcher", "Meta", "user", "Fetches pages for Meta AI user requests."),
    AIAgent("CCBot", "Common Crawl", "training", "Open web crawl that is widely used to train AI models."),
    AIAgent("Bytespider", "ByteDance", "training", "Collects content for ByteDance AI models."),
    AIAgent("Amazonbot", "Amazon", "other", "Crawls for Alexa answers and other Amazon products."),
    AIAgent("cohere-ai", "Cohere", "training", "Cohere's crawler token."),
    AIAgent("MistralAI-User", "Mistral", "user", "Fetches pages when a Le Chat user asks."),
    AIAgent("DuckAssistBot", "DuckDuckGo", "search", "Fetches sources for DuckDuckGo AI answers."),
    AIAgent("Diffbot", "Diffbot", "training", "Builds a knowledge graph that is sold for AI use."),
)

PURPOSES = ("training", "search", "user", "other")


def agents_with_extras(extra_tokens: list[str] | tuple[str, ...] = ()) -> list[AIAgent]:
    """Return the known agents plus caller-supplied tokens (deduplicated, case-insensitive)."""

    seen = {a.token.lower() for a in AI_AGENTS}
    result = list(AI_AGENTS)
    for token in extra_tokens:
        clean = str(token).strip()
        if clean and clean.lower() not in seen:
            seen.add(clean.lower())
            result.append(AIAgent(clean, "custom", "other", "Added by the caller."))
    return result
