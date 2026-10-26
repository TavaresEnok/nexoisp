FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY apps/api-go/go.mod apps/api-go/go.sum ./
RUN go mod download
COPY apps/api-go/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/api ./cmd/api
RUN CGO_ENABLED=0 go build -trimpath -o /out/nexo-db ./cmd/nexo-db
FROM alpine:3.22
RUN apk add --no-cache ca-certificates && addgroup -g 1000 -S nexo && adduser -u 1000 -S -G nexo nexo
COPY --from=build /out/api /usr/local/bin/nexo-api-go
COPY --from=build /out/nexo-db /usr/local/bin/nexo-db
COPY db /app/db
WORKDIR /app
USER nexo
ENV NEXO_GO_ADDR=0.0.0.0:8080 NEXO_GO_INTERNAL_ADDR=0.0.0.0:9090
EXPOSE 8080 9090
ENTRYPOINT ["nexo-api-go"]
