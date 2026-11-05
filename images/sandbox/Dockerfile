FROM python:3.12-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates coreutils && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --create-home --uid 10001 agent

USER agent
WORKDIR /home/agent

CMD ["sleep", "infinity"]
