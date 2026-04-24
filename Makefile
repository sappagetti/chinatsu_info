.PHONY: all build build-frontend build-bookmarklet build-backend \
	test test-backend test-frontend typecheck \
	docker-build docker-build-backend docker-build-frontend \
	fmt clean

# CI 에서 실행되는 명령과 로컬이 최대한 같은 커맨드를 쓰도록 집약.
# 개발자는 `make test` 로 CI 전 로컬 검증을 빠르게 돌릴 수 있다.

all: build

build: build-bookmarklet build-frontend build-backend

build-frontend:
	npm --prefix frontend run build

build-bookmarklet:
	npm --prefix bookmarklet run build

build-backend:
	cd backend && go build ./...

# CI 의 test 잡과 동일한 검증. 로컬에서 실패하면 CI 도 실패한다.
test: test-backend typecheck test-frontend

test-backend:
	cd backend && go vet ./... && go test ./...

test-frontend:
	npm --prefix frontend run test

typecheck:
	npm --prefix frontend exec -- tsc --noEmit

docker-build: docker-build-backend docker-build-frontend

docker-build-backend:
	docker build -t chinatsu-info-backend:local ./backend

# 로컬 docker build 는 환경변수에서 VITE_* 를 읽어 --build-arg 로 넘긴다.
# 값이 비어도 빌드는 통과하지만 런타임 에러가 날 수 있으므로 .env 를 미리 source 하자.
#   set -a; . .env; set +a; make docker-build-frontend
docker-build-frontend:
	docker build \
		--build-arg VITE_API_URL=$${VITE_API_URL} \
		--build-arg VITE_BOOKMARKLET_API_URL=$${VITE_BOOKMARKLET_API_URL} \
		--build-arg VITE_BEATMAP_BUCKET_URL=$${VITE_BEATMAP_BUCKET_URL} \
		--build-arg VITE_TURNSTILE_SITE_KEY=$${VITE_TURNSTILE_SITE_KEY} \
		-t chinatsu-info-frontend:local ./frontend

fmt:
	cd backend && gofmt -w $$(rg --files -g '*.go')

clean:
	rm -rf frontend/dist bookmarklet/dist
