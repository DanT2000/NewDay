# Сборка не ходит в Cloudflare.
#
# С хоста, где стоит Coolify, всё, что стоит за Cloudflare, не открывается
# или обрывается: auth.docker.io отвечает обычным HTTP вместо TLS,
# registry.npmjs.org роняет npm ci на полпути («Exit handler never called»),
# nodejs.org недоступен для заголовков node-gyp. GitHub, Timeweb, Яндекс и
# Fastly при этом открываются. Поэтому каждая сетевая зависимость сборки
# взята с адреса не за Cloudflare, и каждую можно подменить переменной
# в Coolify — они уезжают в сборку как --build-arg:
#  - BASE_IMAGE   — базовый образ с зеркала Timeweb (те же официальные образы);
#  - NPM_REGISTRY — пакеты с npmmirror; адреса в package-lock указывают на
#                   registry.npmjs.org, npm сам подменяет хост на зеркало;
#  - APK_MIRROR   — репозитории Alpine с зеркала Яндекса (dl-cdn через Fastly
#                   шёл по 0,4 МБ/с — тринадцать минут на компиляторы).
# Заголовки node для сборки better-sqlite3 берём из самого образа
# (/usr/local/include/node), а не качаем с nodejs.org.
ARG BASE_IMAGE=dockerhub.timeweb.cloud/library/node:22-alpine
FROM ${BASE_IMAGE}
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG APK_MIRROR=https://mirror.yandex.ru/mirrors/alpine

WORKDIR /app

# better-sqlite3 — нативный модуль: собирается компиляторами, но в рантайме
# ему нужен libstdc++. Компиляторы удаляем после сборки, libstdc++ оставляем —
# без него модуль падает с ERR_DLOPEN_FAILED.
COPY package*.json ./
RUN sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${APK_MIRROR}#" /etc/apk/repositories \
 && apk add --no-cache libstdc++ \
 && apk add --no-cache --virtual .build python3 make g++ \
 && npm_config_nodedir=/usr/local npm ci --omit=dev --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000 \
 && npm cache clean --force \
 && apk del .build

COPY . .

RUN mkdir -p /app/data /app/public/downloads /app/public/icons

EXPOSE 3000

CMD ["node", "server/index.js"]
