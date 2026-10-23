# Coding sandbox for the code-mcp cloud device: a long-lived dev container
# that the gateway's /mcp/cloud tools exec into. Kept alive by sleeping -
# processes are started on demand via the Containers exec() API.
FROM node:22-alpine

RUN apk add --no-cache bash git python3 py3-pip ripgrep curl ca-certificates build-base \
  && npm install -g bun \
  && bun --version && node --version && python3 --version && rg --version

# Default workdir for coding tasks (fs.list defaults to it). Note: container
# filesystem is ephemeral across instance recycling - use KV/D1/R2 for durable data.
RUN mkdir -p /workspace

# Keep the container running so exec() has a live process tree.
CMD ["sleep", "infinity"]
