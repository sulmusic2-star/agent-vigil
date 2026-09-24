"""Which products or businesses do AI assistants recommend? Ask them and measure it.

``engines``  asks ChatGPT, Perplexity, Gemini and Claude a question with live web search
``extract``  reads the recommended names, in order, out of each answer
``track``    samples every engine several times, reuses recent answers and aggregates
``actor``    the Apify wrapper: input, charging per AI answer, the shared answer cache
"""
