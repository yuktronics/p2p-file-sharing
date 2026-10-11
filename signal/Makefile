.PHONY: vet test dev build

vet:
	go vet ./...

test:
	go test -count=1 ./...

dev:
	SIGNAL_ADDR=127.0.0.1:8090 SIGNAL_WEB_DIR=web go run ./cmd/signal

build:
	go build -o signal ./cmd/signal
