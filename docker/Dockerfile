FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git procps jq \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 verifier \
    && git config --system --add safe.directory '*'

ENV GIT_AUTHOR_NAME=verifier GIT_AUTHOR_EMAIL=verifier@localhost \
    GIT_COMMITTER_NAME=verifier GIT_COMMITTER_EMAIL=verifier@localhost

USER verifier
WORKDIR /work
