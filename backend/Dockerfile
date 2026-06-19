FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/server.js ./
COPY frontend/ /frontend/

EXPOSE 3000

CMD ["node", "server.js"]
