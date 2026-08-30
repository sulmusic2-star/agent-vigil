# The verifier itself still uses the exact Node image reviewed by Agent Vigil.
# Additional language tools are available only inside the candidate sandbox.
FROM oven/bun@sha256:4b2a0f909e520adb526ef1c12fe0d1e8464fc7beba19140d688222647af68904 AS bun
FROM mcr.microsoft.com/dotnet/sdk@sha256:d50371ed5e6839058f8644f0331aaf9188ee2cdd2a8b9ee6471906290b875577 AS dotnet
FROM node@sha256:46e94f8cf91baab69a2deb3153e74eeffd73c20c7cc1d8432f5b96469eaa0322

USER root
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=dotnet /usr/share/dotnet /usr/share/dotnet

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      cargo default-jdk-headless golang-go gradle maven php-cli phpunit \
      python3 python3-pytest ruby ruby-bundler ruby-rspec rustc \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
    && corepack enable \
    && corepack install --global pnpm@10.15.1 yarn@4.9.4 \
    && python3 -m pytest --version \
    && cargo --version \
    && go version \
    && mvn --version \
    && gradle --version \
    && ruby --version \
    && phpunit --version \
    && dotnet --version \
    && pnpm --version \
    && yarn --version \
    && bun --version \
    && rm -rf /var/lib/apt/lists/* /root/.cache

LABEL org.opencontainers.image.source="https://github.com/sulmusic2-star/agent-vigil"
LABEL org.opencontainers.image.description="Digest-pinned hermetic candidate test runner for Agent Vigil"
