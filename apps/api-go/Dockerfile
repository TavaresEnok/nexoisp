FROM golang:1.27.2-alpine AS build
WORKDIR /src
COPY apps/api-go/go.mod apps/api-go/go.sum ./
RUN go mod download
COPY apps/api-go/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/api ./cmd/api
FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -S nexo && adduser -S -G nexo nexo
COPY --from=build /out/api /usr/local/bin/nexo-api-go
USER nexo
ENV NEXO_GO_ADDR=0.0.0.0:8080 NEXO_GO_INTERNAL_ADDR=0.0.0.0:9090
EXPOSE 8080 9090
ENTRYPOINT ["nexo-api-go"]
