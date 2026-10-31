FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/clean.mjs ./scripts/clean.mjs
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production CODERELAY_DATA_DIR=/var/lib/coderelay
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && mkdir -p /var/lib/coderelay && chown node:node /var/lib/coderelay
COPY --from=build /app/dist/src ./dist/src
COPY LICENSE README.md ./
USER node
VOLUME ["/var/lib/coderelay"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/cli.js", "serve"]
