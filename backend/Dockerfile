# 멀티스테이지: 1) Go 빌드 2) 실행은 최소 alpine
# modernc.org/sqlite 는 순수 Go라 CGO 없이 정적 링크에 가깝게 빌드 가능.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/server ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /out/server ./server
ENV DB_PATH=/data/app.db
EXPOSE 8080
ENTRYPOINT ["./server"]
