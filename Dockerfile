FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit \
    && npm audit --omit=dev --audit-level=high

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    GMAIL_MCP_STATE_DIR=/var/lib/gmail-mcp \
    GMAIL_OAUTH_PATH=/etc/gmail-mcp/gcp-oauth.keys.json \
    GMAIL_CREDENTIALS_PATH=/var/lib/gmail-mcp/credentials.json

RUN groupadd --system --gid 10001 gmail-mcp \
    && useradd --system --uid 10001 --gid gmail-mcp \
        --home-dir /var/lib/gmail-mcp --shell /usr/sbin/nologin gmail-mcp \
    && install -d -o gmail-mcp -g gmail-mcp -m 0700 /var/lib/gmail-mcp \
    && install -d -o root -g gmail-mcp -m 0750 /etc/gmail-mcp

WORKDIR /app
COPY --from=build --chown=root:root /app/package.json /app/package-lock.json ./
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist

USER gmail-mcp
VOLUME ["/var/lib/gmail-mcp", "/etc/gmail-mcp"]
EXPOSE 8080
EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
CMD []
