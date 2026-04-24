# 프론트는 Node로 빌드 후 nginx로 정적 파일만 서빙. /api 는 nginx.conf에서 백엔드로 프록시.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
ARG VITE_API_URL=
ARG VITE_BOOKMARKLET_API_URL=
ARG VITE_BEATMAP_BUCKET_URL=
ARG VITE_TURNSTILE_SITE_KEY=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_BOOKMARKLET_API_URL=$VITE_BOOKMARKLET_API_URL
ENV VITE_BEATMAP_BUCKET_URL=$VITE_BEATMAP_BUCKET_URL
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
