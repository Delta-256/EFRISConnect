FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

WORKDIR /
COPY frontend/ ./frontend/

WORKDIR /app

EXPOSE 3000

CMD ["node", "server.js"]
