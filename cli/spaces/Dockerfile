# A codespace image for "prime spaces": a minimal Linux with the bundled
# device buddy, already running as a local (no gateway) MCP server on 7777.
# By digest (debian:bookworm-slim at the time of pinning): a tag that is moved changes nothing here.
FROM debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git coreutils findutils grep sed gawk procps \
      openssh-client unzip wget jq ripgrep python3 \
 && rm -rf /var/lib/apt/lists/*

# bun has no apt package: it comes from its own installer, and is put on the
# path every shell reads.
RUN curl -fsSL https://bun.sh/install | bash \
 && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
 && bun --version

ARG BIN=prime-linux-arm64
COPY ${BIN} /usr/local/bin/prime
RUN chmod 0755 /usr/local/bin/prime && mkdir -p /root/work

WORKDIR /root/work
ENV HOME=/root

# The space's token is injected at run time; nothing secret is baked in.
ENTRYPOINT ["/bin/sh", "-c", "exec /usr/local/bin/prime code-mcp --bind 0.0.0.0 --port 7777 --token \"$PRIME_SPACE_TOKEN\""]
