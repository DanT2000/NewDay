FROM node:22-alpine

WORKDIR /app

# better-sqlite3 — нативный модуль: собирается компиляторами, но в рантайме
# ему нужен libstdc++. Компиляторы удаляем после сборки, libstdc++ оставляем —
# без него модуль падает с ERR_DLOPEN_FAILED.
COPY package*.json ./
RUN apk add --no-cache libstdc++ \
 && apk add --no-cache --virtual .build python3 make g++ \
 && npm ci --omit=dev \
 && npm cache clean --force \
 && apk del .build

COPY . .

RUN mkdir -p /app/data /app/public/downloads /app/public/icons

EXPOSE 3000

CMD ["node", "server/index.js"]
