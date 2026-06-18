FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y wget ca-certificates libicu-dev && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Download Manager Server Edition for Linux
# Check latest version at: https://www.manager.io/releases/server
ARG MANAGER_VERSION=24.1.0
RUN wget -q -O /manager-server \
    "https://mngr.s3.amazonaws.com/${MANAGER_VERSION}/ManagerServer" && \
    chmod +x /manager-server

# Data will be stored here — mount a Railway Volume at this path
RUN mkdir -p /data

EXPOSE 8080

CMD ["/manager-server", "--port", "8080", "--path", "/data"]
