FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/server.js ./
COPY backend/data/ ./data/
COPY frontend/ /frontend/

ARG EFRIS_PRIVATE_KEY
RUN mkdir -p /app/keys && \
    printf '%s' "$EFRIS_PRIVATE_KEY" | sed 's/\\n/\n/g' | sed 's/\r//g' > /app/keys/efris_private.pem && \
    echo "PEM byte count: $(wc -c < /app/keys/efris_private.pem)" && \
    echo "PEM line count: $(wc -l < /app/keys/efris_private.pem)" && \
    echo "PEM first 40 chars: $(cut -c1-40 /app/keys/efris_private.pem | head -1)"

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
