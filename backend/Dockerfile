FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/server.js ./
COPY backend/data/ ./data/
COPY frontend/ /frontend/

ARG EFRIS_PRIVATE_KEY
RUN mkdir -p /app/keys && echo "$EFRIS_PRIVATE_KEY" > /app/keys/efris_private.pem

EXPOSE 3000

CMD ["node", "server.js"]
