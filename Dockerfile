# Multi-stage Docker image for CodeRecall MCP Server (Glama.ai & local stdio compatible)
FROM node:24-slim AS builder

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
RUN pnpm run build

FROM node:24-slim AS runner

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* && corepack enable && mkdir -p /workspace /data/coderecall

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV CODERECALL_HOME=/data/coderecall

# Serve scoped MCP tools over stdio; /workspace is the default allowed root for Glama introspection
ENTRYPOINT ["node", "dist/cli.js", "mcp", "--allow-root", "/workspace"]
