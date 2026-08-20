FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application files
COPY server.js ./
COPY public/ ./public/

# Run as non-root
USER node

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    POLL_INTERVAL_MS=10000

CMD ["node", "server.js"]
