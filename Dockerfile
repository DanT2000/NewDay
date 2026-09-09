# Базовый образ — с зеркала, а не с docker.io напрямую.
#
# С хоста, где стоит Coolify, к auth.docker.io HTTPS не проходит: сервер
# отвечает обычным HTTP, и сборка падает ещё на строке FROM, не дойдя до
# кода. Зеркало Timeweb отдаёт те же официальные образы и открывается из
# России без фокусов. Адрес можно подменить переменной BASE_IMAGE в Coolify
# (она уезжает в сборку как --build-arg), если зеркало сменится.
ARG BASE_IMAGE=dockerhub.timeweb.cloud/library/node:22-alpine
FROM ${BASE_IMAGE}

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
