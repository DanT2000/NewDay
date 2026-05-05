FROM node:20-alpine

# Build tools needed for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY server/ ./server/
COPY public/ ./public/
COPY samples/ ./samples/

# Data directory for the SQLite file
RUN mkdir -p /app/data

# Non-root user
RUN addgroup -S planner && adduser -S planner -G planner && \
    chown -R planner:planner /app
USER planner

VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "server/index.js"]
